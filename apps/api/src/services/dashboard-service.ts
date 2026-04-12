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
  role: string;
}

export interface DashboardService {
  // Org context resolution (used by middleware)
  resolveOrgContext(slug: string, userId: string): Promise<OrgContext | null>;
  getMyOrgs(userId: string): Promise<{ id: string; name: string; slug: string }[]>;

  // Flags
  getFlagsWithStates(orgId: string): Promise<{ flags: FlagWithStates[]; environments: EnvRef[] }>;
  createFlag(
    orgId: string,
    input: { name: string; key?: string; description: string },
  ): Promise<typeof import('@vexillo/db').flags.$inferSelect>;
  updateFlag(
    orgId: string,
    key: string,
    patch: { name?: string; description?: string },
  ): Promise<typeof import('@vexillo/db').flags.$inferSelect>;
  deleteFlag(orgId: string, key: string): Promise<void>;
  toggleFlag(orgId: string, key: string, environmentId: string): Promise<{ enabled: boolean }>;

  // Environments
  getEnvironments(orgId: string): Promise<EnvironmentWithKey[]>;
  createEnvironment(
    orgId: string,
    name: string,
  ): Promise<{ environment: typeof import('@vexillo/db').environments.$inferSelect; apiKey: string }>;
  updateEnvironmentOrigins(
    orgId: string,
    id: string,
    allowedOrigins: string[],
  ): Promise<{ id: string; allowedOrigins: string[] }>;
  deleteEnvironment(orgId: string, id: string): Promise<void>;
  rotateEnvironmentKey(orgId: string, envId: string): Promise<{ apiKey: string }>;

  // Members
  getMembers(orgId: string): Promise<MemberRow[]>;
  updateMemberRole(orgId: string, userId: string, role: string): Promise<{ userId: string; role: string }>;
  removeMember(orgId: string, userId: string): Promise<void>;

}

// ── Implementation ─────────────────────────────────────────────────────────────

export function createDashboardService(db: DbClient): DashboardService {
  return {
    async resolveOrgContext(slug, userId) {
      const org = await queryOrgBySlug(db, slug);
      if (!org) return null;
      const role = await queryUserOrgRole(db, org.id, userId);
      if (!role) return null;
      return { org, role };
    },

    async getMyOrgs(userId) {
      return queryUserOrgs(db, userId);
    },

    // ── Flags ────────────────────────────────────────────────────────────────

    async getFlagsWithStates(orgId) {
      return queryOrgFlagsWithStates(db, orgId);
    },

    async createFlag(orgId, input) {
      const envIds = await queryOrgEnvironmentIds(db, orgId);
      if (envIds.length === 0) {
        throw new PreconditionError('Create an environment before creating flags');
      }
      const key = input.key?.trim() || slugify(input.name);
      if (!key) throw new PreconditionError('Invalid key');
      try {
        const flag = await insertFlag(db, orgId, { name: input.name, key, description: input.description });
        await backfillFlagStatesForFlag(db, flag.id, envIds.map((e) => e.id));
        return flag;
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Flag key already exists');
        throw err;
      }
    },

    async updateFlag(orgId, key, patch) {
      if (patch.name !== undefined && !patch.name) {
        throw new PreconditionError('Name cannot be empty');
      }
      const flag = await updateFlag(db, orgId, key, patch);
      if (!flag) throw new NotFoundError('Flag not found');
      return flag;
    },

    async deleteFlag(orgId, key) {
      const deleted = await deleteFlag(db, orgId, key);
      if (!deleted) throw new NotFoundError('Flag not found');
    },

    async toggleFlag(orgId, key, environmentId) {
      const result = await toggleFlag(db, orgId, key, environmentId);
      if (!result) throw new NotFoundError('Flag not found');
      return result;
    },

    // ── Environments ─────────────────────────────────────────────────────────

    async getEnvironments(orgId) {
      return queryOrgEnvironments(db, orgId);
    },

    async createEnvironment(orgId, name) {
      const slug = slugify(name);
      if (!slug) throw new PreconditionError('Invalid name');
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      try {
        const environment = await insertEnvironmentWithKey(db, orgId, { name, slug, keyHash, keyHint });
        return { environment, apiKey: rawKey };
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Environment name already exists');
        throw err;
      }
    },

    async updateEnvironmentOrigins(orgId, id, allowedOrigins) {
      const result = await updateEnvironmentOrigins(db, orgId, id, allowedOrigins);
      if (!result) throw new NotFoundError('Environment not found');
      return result;
    },

    async deleteEnvironment(orgId, id) {
      const deleted = await deleteEnvironment(db, orgId, id);
      if (!deleted) throw new NotFoundError('Environment not found');
    },

    async rotateEnvironmentKey(orgId, envId) {
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      const ok = await rotateEnvironmentKey(db, orgId, envId, { keyHash, keyHint });
      if (!ok) throw new NotFoundError('Environment not found');
      return { apiKey: rawKey };
    },

    // ── Members ──────────────────────────────────────────────────────────────

    async getMembers(orgId) {
      return queryOrgMembers(db, orgId);
    },

    async updateMemberRole(orgId, userId, role) {
      if (role !== 'admin' && role !== 'viewer') {
        throw new PreconditionError('Role must be admin or viewer');
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
      return { userId, role };
    },

    async removeMember(orgId, userId) {
      const [currentRole, adminCount] = await Promise.all([
        queryMemberRole(db, orgId, userId),
        countOrgAdmins(db, orgId),
      ]);
      if (!currentRole) throw new NotFoundError('Member not found');
      if (currentRole === 'admin' && adminCount <= 1) {
        throw new ConflictError('Cannot remove the last admin');
      }
      await removeMember(db, orgId, userId);
    },

  };
}
