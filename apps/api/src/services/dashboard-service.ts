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

export function createDashboardService(db: DbClient): DashboardService {
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
      return queryOrgFlagsWithStates(db, orgId);
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
      return flag;
    },

    async deleteFlag(orgId, actorId, key) {
      const deleted = await deleteFlag(db, orgId, key);
      if (!deleted) throw new NotFoundError('Flag not found');
      await insertAuditLog(db, { orgId, actorId, action: 'flag.delete', targetType: 'flag', targetId: key, metadata: { key } });
    },

    async toggleFlag(orgId, actorId, key, environmentId) {
      const result = await toggleFlag(db, orgId, key, environmentId);
      if (!result) throw new NotFoundError('Flag not found');
      await insertAuditLog(db, { orgId, actorId, action: 'flag.toggle', targetType: 'flag', targetId: key, metadata: { key, environmentId, enabled: result.enabled } });
      return result;
    },

    // ── Environments ─────────────────────────────────────────────────────────

    async getEnvironments(orgId) {
      return queryOrgEnvironments(db, orgId);
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
      return result;
    },

    async deleteEnvironment(orgId, actorId, id) {
      const deleted = await deleteEnvironment(db, orgId, id);
      if (!deleted) throw new NotFoundError('Environment not found');
      await insertAuditLog(db, { orgId, actorId, action: 'environment.delete', targetType: 'environment', targetId: id });
    },

    async rotateEnvironmentKey(orgId, actorId, envId) {
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      const ok = await rotateEnvironmentKey(db, orgId, envId, { keyHash, keyHint });
      if (!ok) throw new NotFoundError('Environment not found');
      await insertAuditLog(db, { orgId, actorId, action: 'environment.rotate_key', targetType: 'apiKey', targetId: envId });
      return { apiKey: rawKey };
    },

    // ── Members ──────────────────────────────────────────────────────────────

    async getMembers(orgId) {
      return queryOrgMembers(db, orgId);
    },

    async getRemovedMembers(orgId) {
      return queryRemovedOrgMembers(db, orgId);
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
    },

    async restoreMember(orgId, actorId, userId) {
      if (await queryUserIsSuperAdmin(db, userId)) {
        throw new ForbiddenError('Cannot restore a super admin');
      }
      const ok = await restoreMember(db, orgId, userId);
      if (!ok) throw new NotFoundError('Member not found');
      await insertAuditLog(db, { orgId, actorId, action: 'member.restore', targetType: 'member', targetId: userId });
    },

  };
}
