import { LRUCache } from 'lru-cache';
import type { DbClient } from '@vexillo/db';
import {
  queryUserOrgs,
  queryOrgFlagsWithStates,
  insertFlag,
  backfillFlagStatesForFlag,
  updateFlag,
  deleteFlag,
  toggleFlag,
  setFlagCountryRules,
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
  type AuditEntry,
  type FlagWithStates,
  type EnvRef,
  type EnvironmentWithKey,
  type MemberRow,
  organizations,
} from '@vexillo/db';
import { generateApiKey, hashKey, maskKey } from '../lib/api-key';
import { createCacheInvalidator } from '../lib/cache-invalidator';

// ── Interfaces ────────────────────────────────────────────────────────────────

export type PublishLocal = (environmentId: string, payload: string) => Promise<void>;
export type ClearAuthCache = (environmentId: string) => void;
export type InvalidateMemberContext = (orgId: string, userId: string) => void;

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

// ── ServiceEffects ─────────────────────────────────────────────────────────────

export interface ServiceEffects {
  audit(orgId: string, actorId: string, payload: Omit<AuditEntry, 'orgId' | 'actorId'>): Promise<void>;
  publishFlagChange(orgId: string, environmentId: string): Promise<void>;
  evictMemberContext(orgId: string, userId: string): void;
}

const TTL = 30_000;
const MAX = 200;

export function createServiceEffects(
  db: DbClient,
  opts: {
    publishLocal?: PublishLocal;
    invalidateMemberContext?: InvalidateMemberContext;
  } = {},
): ServiceEffects {
  const { publishLocal, invalidateMemberContext } = opts;
  return {
    async audit(orgId, actorId, payload) {
      await insertAuditLog(db, { orgId, actorId, ...payload });
    },
    async publishFlagChange(orgId, environmentId) {
      if (!publishLocal) return;
      const flagStates = await queryEnvironmentFlagStates(db, orgId, environmentId);
      await publishLocal(environmentId, JSON.stringify({ flags: flagStates }));
    },
    evictMemberContext(orgId, userId) {
      invalidateMemberContext?.(orgId, userId);
    },
  };
}

// ── DashboardService interface ─────────────────────────────────────────────────

export type OrgRow = typeof organizations.$inferSelect;

export interface DashboardService {
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
  updateCountryRules(
    orgId: string,
    actorId: string,
    key: string,
    environmentId: string,
    countries: string[],
  ): Promise<{ countries: string[] }>;

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

export function createDashboardService(
  db: DbClient,
  effects: ServiceEffects,
  clearAuthCache?: ClearAuthCache,
): DashboardService {
  const flagsCache = new LRUCache<string, { flags: FlagWithStates[]; environments: EnvRef[] }>({ max: MAX, ttl: TTL });
  const envsCache = new LRUCache<string, EnvironmentWithKey[]>({ max: MAX, ttl: TTL });
  const membersCache = new LRUCache<string, MemberRow[]>({ max: MAX, ttl: TTL });
  const removedMembersCache = new LRUCache<string, MemberRow[]>({ max: MAX, ttl: TTL });

  const invalidator = createCacheInvalidator({
    flagsCache,
    envsCache,
    membersCache,
    removedMembersCache,
    clearAuthCache,
  });

  return {
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
        const flag = await db.transaction(async (tx) => {
          const created = await insertFlag(tx as unknown as DbClient, orgId, { name: input.name, key, description: input.description, createdByUserId: actorId });
          await backfillFlagStatesForFlag(tx as unknown as DbClient, created.id, envIds.map((e) => e.id));
          return created;
        });
        await effects.audit(orgId, actorId, { action: 'flag.create', targetType: 'flag', targetId: flag.id, metadata: { name: flag.name, key: flag.key } });
        invalidator.onFlagMutation(orgId);
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
      await effects.audit(orgId, actorId, { action: 'flag.update', targetType: 'flag', targetId: flag.id, metadata: { key, changes: patch } });
      invalidator.onFlagMutation(orgId);
      return flag;
    },

    async deleteFlag(orgId, actorId, key) {
      const deleted = await deleteFlag(db, orgId, key);
      if (!deleted) throw new NotFoundError('Flag not found');
      await effects.audit(orgId, actorId, { action: 'flag.delete', targetType: 'flag', targetId: key, metadata: { key } });
      invalidator.onFlagMutation(orgId);
    },

    async toggleFlag(orgId, actorId, key, environmentId) {
      const result = await toggleFlag(db, orgId, key, environmentId);
      if (!result) throw new NotFoundError('Flag not found');
      await effects.audit(orgId, actorId, { action: 'flag.toggle', targetType: 'flag', targetId: key, metadata: { key, environmentId, enabled: result.enabled } });
      await effects.publishFlagChange(orgId, environmentId);
      invalidator.onFlagMutation(orgId);
      return result;
    },

    async updateCountryRules(orgId, actorId, key, environmentId, countries) {
      const normalized = countries.map((c) => c.toUpperCase());
      const result = await setFlagCountryRules(db, orgId, key, environmentId, normalized);
      if (!result) throw new NotFoundError('Flag not found');
      await effects.audit(orgId, actorId, { action: 'flag.country-rules.update', targetType: 'flag', targetId: key, metadata: { key, environmentId, before: result.before, after: result.after } });
      await effects.publishFlagChange(orgId, environmentId);
      invalidator.onFlagMutation(orgId);
      return { countries: result.after };
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
        await effects.audit(orgId, actorId, { action: 'environment.create', targetType: 'environment', targetId: environment.id, metadata: { name, slug } });
        invalidator.onEnvironmentStructuralChange(orgId);
        return { environment, apiKey: rawKey };
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Environment name already exists');
        throw err;
      }
    },

    async updateEnvironmentOrigins(orgId, actorId, id, allowedOrigins) {
      const result = await updateEnvironmentOrigins(db, orgId, id, allowedOrigins);
      if (!result) throw new NotFoundError('Environment not found');
      await effects.audit(orgId, actorId, { action: 'environment.update_origins', targetType: 'environment', targetId: id, metadata: { allowedOrigins } });
      invalidator.onEnvironmentOriginsUpdate(orgId, id);
      return result;
    },

    async deleteEnvironment(orgId, actorId, id) {
      const deleted = await deleteEnvironment(db, orgId, id);
      if (!deleted) throw new NotFoundError('Environment not found');
      await effects.audit(orgId, actorId, { action: 'environment.delete', targetType: 'environment', targetId: id });
      invalidator.onEnvironmentStructuralChange(orgId);
    },

    async rotateEnvironmentKey(orgId, actorId, envId) {
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      await db.transaction(async (tx) => {
        const ok = await rotateEnvironmentKey(tx as unknown as DbClient, orgId, envId, { keyHash, keyHint });
        if (!ok) throw new NotFoundError('Environment not found');
      });
      await effects.audit(orgId, actorId, { action: 'environment.rotate_key', targetType: 'apiKey', targetId: envId });
      invalidator.onEnvironmentKeyRotation(orgId, envId);
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
      await effects.audit(orgId, actorId, { action: 'member.update_role', targetType: 'member', targetId: userId, metadata: { role } });
      invalidator.onMemberMutation(orgId);
      effects.evictMemberContext(orgId, userId);
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
      await effects.audit(orgId, actorId, { action: 'member.remove', targetType: 'member', targetId: userId });
      invalidator.onMemberMutation(orgId);
      effects.evictMemberContext(orgId, userId);
    },

    async restoreMember(orgId, actorId, userId) {
      if (await queryUserIsSuperAdmin(db, userId)) {
        throw new ForbiddenError('Cannot restore a super admin');
      }
      const ok = await restoreMember(db, orgId, userId);
      if (!ok) throw new NotFoundError('Member not found');
      await effects.audit(orgId, actorId, { action: 'member.restore', targetType: 'member', targetId: userId });
      invalidator.onMemberMutation(orgId);
      effects.evictMemberContext(orgId, userId);
    },

  };
}
