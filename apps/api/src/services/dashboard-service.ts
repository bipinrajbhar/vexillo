import { LRUCache } from 'lru-cache';
import type { DbClient } from '@vexillo/db';
import {
  queryUserOrgs,
  queryOrgBySlug,
  queryUserOrgRole,
  queryOrgFlagsWithStates,
  insertFlag,
  backfillFlagStatesForFlag,
  updateFlag,
  deleteFlag,
  toggleFlag,
  queryEnvironmentFlagStates,
  queryOrgEnvironments,
  queryOrgEnvironmentIds,
  insertEnvironmentWithKey,
  updateEnvironmentOrigins,
  deleteEnvironment,
  rotateEnvironmentKey,
  queryOrgMembers,
  queryMemberRole,
  countOrgAdmins,
  updateMemberRole,
  removeMember,
  restoreMember,
  queryRemovedOrgMembers,
  queryUserIsSuperAdmin,
  insertAuditLog,
  type FlagWithStates,
  type EnvRef,
  type EnvironmentWithKey,
  type MemberRow,
  organizations,
} from '@vexillo/db';
import { generateApiKey, hashKey, maskKey } from '../lib/api-key';

// ── Interfaces ────────────────────────────────────────────────────────────────

export type NotifyFlagChange = (environmentId: string, payload: string) => void | Promise<void>;

// ── Domain errors ──────────────────────────────────────────────────────────────

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class PreconditionError extends Error {
  readonly code = 'PRECONDITION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

function isUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return msg.includes('unique') || msg.includes('duplicate');
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Interface ──────────────────────────────────────────────────────────────────

export type OrgRow = typeof organizations.$inferSelect;

export interface OrgContext {
  org: OrgRow;
  role: string | null; // null means org exists but user is not a member
}

export interface DashboardService {
  // Org context resolution (used by middleware)
  resolveOrgContext(slug: string, userId: string): Promise<OrgContext | null>;
  getMyOrgs(userId: string): Promise<{ id: string; name: string; slug: string }[]>;

  // Flags
  getFlagsWithStates(orgId: string): Promise<{ flags: FlagWithStates[]; environments: EnvRef[] }>;
  createFlag(
    orgId: string,
    actorId: string,
    input: { name: string; key?: string; description: string },
  ): Promise<typeof import('@vexillo/db').flags.$inferSelect>;
  updateFlag(
    orgId: string,
    actorId: string,
    key: string,
    patch: { name?: string; description?: string },
  ): Promise<typeof import('@vexillo/db').flags.$inferSelect>;
  deleteFlag(orgId: string, actorId: string, key: string): Promise<void>;
  toggleFlag(orgId: string, actorId: string, key: string, environmentId: string): Promise<{ enabled: boolean }>;

  // Environments
  getEnvironments(orgId: string): Promise<EnvironmentWithKey[]>;
  createEnvironment(
    orgId: string,
    actorId: string,
    name: string,
  ): Promise<{ environment: typeof import('@vexillo/db').environments.$inferSelect; apiKey: string }>;
  updateEnvironmentOrigins(
    orgId: string,
    actorId: string,
    id: string,
    allowedOrigins: string[],
  ): Promise<{ id: string; allowedOrigins: string[] }>;
  deleteEnvironment(orgId: string, actorId: string, id: string): Promise<void>;
  rotateEnvironmentKey(orgId: string, actorId: string, envId: string): Promise<{ apiKey: string }>;

  // Members
  getMembers(orgId: string): Promise<MemberRow[]>;
  getRemovedMembers(orgId: string): Promise<MemberRow[]>;
  updateMemberRole(orgId: string, actorId: string, userId: string, role: string): Promise<{ userId: string; role: string }>;
  removeMember(orgId: string, actorId: string, userId: string): Promise<void>;
  restoreMember(orgId: string, actorId: string, userId: string): Promise<void>;

}

// ── Implementation ─────────────────────────────────────────────────────────────

const TTL = 30_000;
const MAX = 200;

export function createDashboardService(db: DbClient, notifyFlagChange?: NotifyFlagChange): DashboardService {
  const flagsCache = new LRUCache<string, { flags: FlagWithStates[]; environments: EnvRef[] }>({ max: MAX, ttl: TTL });
  const envsCache = new LRUCache<string, EnvironmentWithKey[]>({ max: MAX, ttl: TTL });
  const membersCache = new LRUCache<string, MemberRow[]>({ max: MAX, ttl: TTL });
  const removedMembersCache = new LRUCache<string, MemberRow[]>({ max: MAX, ttl: TTL });

  return {
    async resolveOrgContext(slug, userId) {
      const org = await queryOrgBySlug(db, slug);
      if (!org) return null;
      const role = await queryUserOrgRole(db, org.id, userId);
      return { org, role: role ?? null };
    },

    async getMyOrgs(userId) {
      return queryUserOrgs(db, userId);
    },

    // ── Flags ────────────────────────────────────────────────────────────────

    async getFlagsWithStates(orgId) {
      const hit = flagsCache.get(orgId);
      if (hit) return hit;
      const result = await queryOrgFlagsWithStates(db, orgId);
      flagsCache.set(orgId, result);
      return result;
    },

    async createFlag(orgId, actorId, input) {
      const envIds = await queryOrgEnvironmentIds(db, orgId);
      if (envIds.length === 0) {
        throw new PreconditionError('Create an environment before creating flags');
      }
      const key = input.key?.trim() || slugify(input.name);
      if (!key) throw new PreconditionError('Invalid key');
      try {
        const flag = await insertFlag(db, orgId, { name: input.name, key, description: input.description, createdByUserId: actorId });
        await backfillFlagStatesForFlag(db, flag.id, envIds.map((e) => e.id));
        await insertAuditLog(db, { orgId, actorId, action: 'flag.create', targetType: 'flag', targetId: flag.id, metadata: { name: flag.name, key: flag.key } });
        flagsCache.delete(orgId);
        return flag;
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Flag key already exists');
        throw err;
      }
    },

    async updateFlag(orgId, actorId, key, patch) {
      if (patch.name !== undefined && !patch.name) {
        throw new PreconditionError('Name cannot be empty');
      }
      const flag = await updateFlag(db, orgId, key, patch);
      if (!flag) throw new NotFoundError('Flag not found');
      await insertAuditLog(db, { orgId, actorId, action: 'flag.update', targetType: 'flag', targetId: flag.id, metadata: { key, changes: patch } });
      flagsCache.delete(orgId);
      return flag;
    },

    async deleteFlag(orgId, actorId, key) {
      const deleted = await deleteFlag(db, orgId, key);
      if (!deleted) throw new NotFoundError('Flag not found');
      await insertAuditLog(db, { orgId, actorId, action: 'flag.delete', targetType: 'flag', targetId: key, metadata: { key } });
      flagsCache.delete(orgId);
    },

    async toggleFlag(orgId, actorId, key, environmentId) {
      const result = await toggleFlag(db, orgId, key, environmentId);
      if (!result) throw new NotFoundError('Flag not found');
      await insertAuditLog(db, { orgId, actorId, action: 'flag.toggle', targetType: 'flag', targetId: key, metadata: { key, environmentId, enabled: result.enabled } });
      if (notifyFlagChange) {
        const flagStates = await queryEnvironmentFlagStates(db, orgId, environmentId);
        await notifyFlagChange(environmentId, JSON.stringify({ flags: flagStates }));
      }
      flagsCache.delete(orgId);
      return result;
    },

    // ── Environments ─────────────────────────────────────────────────────────

    async getEnvironments(orgId) {
      const hit = envsCache.get(orgId);
      if (hit) return hit;
      const result = await queryOrgEnvironments(db, orgId);
      envsCache.set(orgId, result);
      return result;
    },

    async createEnvironment(orgId, actorId, name) {
      const slug = slugify(name);
      if (!slug) throw new PreconditionError('Invalid name');
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      try {
        const environment = await insertEnvironmentWithKey(db, orgId, { name, slug, keyHash, keyHint });
        await insertAuditLog(db, { orgId, actorId, action: 'environment.create', targetType: 'environment', targetId: environment.id, metadata: { name, slug } });
        envsCache.delete(orgId);
        flagsCache.delete(orgId);
        return { environment, apiKey: rawKey };
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Environment name already exists');
        throw err;
      }
    },

    async updateEnvironmentOrigins(orgId, actorId, id, allowedOrigins) {
      const result = await updateEnvironmentOrigins(db, orgId, id, allowedOrigins);
      if (!result) throw new NotFoundError('Environment not found');
      await insertAuditLog(db, { orgId, actorId, action: 'environment.update_origins', targetType: 'environment', targetId: id, metadata: { allowedOrigins } });
      envsCache.delete(orgId);
      return result;
    },

    async deleteEnvironment(orgId, actorId, id) {
      const deleted = await deleteEnvironment(db, orgId, id);
      if (!deleted) throw new NotFoundError('Environment not found');
      await insertAuditLog(db, { orgId, actorId, action: 'environment.delete', targetType: 'environment', targetId: id });
      envsCache.delete(orgId);
      flagsCache.delete(orgId);
    },

    async rotateEnvironmentKey(orgId, actorId, envId) {
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      const ok = await rotateEnvironmentKey(db, orgId, envId, { keyHash, keyHint });
      if (!ok) throw new NotFoundError('Environment not found');
      await insertAuditLog(db, { orgId, actorId, action: 'environment.rotate_key', targetType: 'apiKey', targetId: envId });
      envsCache.delete(orgId);
      return { apiKey: rawKey };
    },

    // ── Members ──────────────────────────────────────────────────────────────

    async getMembers(orgId) {
      const hit = membersCache.get(orgId);
      if (hit) return hit;
      const result = await queryOrgMembers(db, orgId);
      membersCache.set(orgId, result);
      return result;
    },

    async getRemovedMembers(orgId) {
      const hit = removedMembersCache.get(orgId);
      if (hit) return hit;
      const result = await queryRemovedOrgMembers(db, orgId);
      removedMembersCache.set(orgId, result);
      return result;
    },

    async updateMemberRole(orgId, actorId, userId, role) {
      if (role !== 'admin' && role !== 'viewer') {
        throw new PreconditionError('Role must be admin or viewer');
      }
      if (await queryUserIsSuperAdmin(db, userId)) {
        throw new ForbiddenError('Cannot change role of a super admin');
      }
      if (role === 'viewer') {
        const [currentRole, adminCount] = await Promise.all([
          queryMemberRole(db, orgId, userId),
          countOrgAdmins(db, orgId),
        ]);
        if (currentRole === 'admin' && adminCount <= 1) {
          throw new ConflictError('Cannot demote the last admin');
        }
      }
      const updated = await updateMemberRole(db, orgId, userId, role);
      if (!updated) throw new NotFoundError('Member not found');
      await insertAuditLog(db, { orgId, actorId, action: 'member.update_role', targetType: 'member', targetId: userId, metadata: { role } });
      membersCache.delete(orgId);
      return { userId, role };
    },

    async removeMember(orgId, actorId, userId) {
      if (await queryUserIsSuperAdmin(db, userId)) {
        throw new ForbiddenError('Cannot remove a super admin from an org');
      }
      const [currentRole, adminCount] = await Promise.all([
        queryMemberRole(db, orgId, userId),
        countOrgAdmins(db, orgId),
      ]);
      if (!currentRole) throw new NotFoundError('Member not found');
      if (currentRole === 'admin' && adminCount <= 1) {
        throw new ConflictError('Cannot remove the last admin');
      }
      await removeMember(db, orgId, userId);
      await insertAuditLog(db, { orgId, actorId, action: 'member.remove', targetType: 'member', targetId: userId });
      membersCache.delete(orgId);
      removedMembersCache.delete(orgId);
    },

    async restoreMember(orgId, actorId, userId) {
      if (await queryUserIsSuperAdmin(db, userId)) {
        throw new ForbiddenError('Cannot restore a super admin');
      }
      const ok = await restoreMember(db, orgId, userId);
      if (!ok) throw new NotFoundError('Member not found');
      await insertAuditLog(db, { orgId, actorId, action: 'member.restore', targetType: 'member', targetId: userId });
      membersCache.delete(orgId);
      removedMembersCache.delete(orgId);
    },

  };
}
