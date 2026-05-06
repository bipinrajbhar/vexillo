import {
  queryUserOrgs,
  insertFlag,
  backfillFlagStatesForFlag,
  updateFlag,
  deleteFlag,
  toggleFlag,
  setFlagCountryRules,
  queryOrgEnvironmentIds,
  insertEnvironmentWithKey,
  updateEnvironmentOrigins,
  deleteEnvironment,
  rotateEnvironmentKey,
  queryMemberRole,
  countOrgAdmins,
  updateMemberRole,
  removeMember,
  restoreMember,
  queryUserIsSuperAdmin,
  type FlagWithStates,
  type EnvRef,
  type EnvironmentWithKey,
  type MemberRow,
  organizations,
} from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { generateApiKey, hashKey, maskKey } from '../lib/api-key';
import type { FlagOps } from './flag-ops';

// Domain errors and helpers live in shared modules so SuperAdminService and
// DashboardService throw a single error identity. Re-exported here so existing
// callers (e.g. routes/dashboard.ts) keep working without changing imports.
import {
  NotFoundError,
  ConflictError,
  PreconditionError,
  ForbiddenError,
  isUniqueError,
} from '../lib/domain-errors';
import { slugify } from '../lib/slugify';

export { NotFoundError, ConflictError, PreconditionError, ForbiddenError };

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

export function createDashboardService(db: DbClient, flagOps: FlagOps): DashboardService {
  return {
    async getMyOrgs(userId) {
      return queryUserOrgs(db, userId);
    },

    // ── Flags ────────────────────────────────────────────────────────────────

    async getFlagsWithStates(orgId) {
      return flagOps.read.flagsWithStates(orgId);
    },

    async createFlag(orgId, actorId, input) {
      const envIds = await queryOrgEnvironmentIds(db, orgId);
      if (envIds.length === 0) {
        throw new PreconditionError('Create an environment before creating flags');
      }
      const key = input.key?.trim() || slugify(input.name);
      if (!key) throw new PreconditionError('Invalid key');
      try {
        return await db.transaction(async (tx) => {
          const created = await insertFlag(tx as unknown as DbClient, orgId, {
            name: input.name,
            key,
            description: input.description,
            createdByUserId: actorId,
          });
          await backfillFlagStatesForFlag(tx as unknown as DbClient, created.id, envIds.map((e) => e.id));
          await flagOps.commit(
            {
              kind: 'flag.created',
              orgId,
              actorId,
              flagId: created.id,
              flagKey: created.key,
              name: created.name,
            },
            tx as unknown as DbClient,
          );
          return created;
        });
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
      await flagOps.commit({
        kind: 'flag.updated',
        orgId,
        actorId,
        flagId: flag.id,
        flagKey: key,
        changes: patch,
      });
      return flag;
    },

    async deleteFlag(orgId, actorId, key) {
      const deleted = await deleteFlag(db, orgId, key);
      if (!deleted) throw new NotFoundError('Flag not found');
      await flagOps.commit({ kind: 'flag.deleted', orgId, actorId, flagKey: key });
    },

    async toggleFlag(orgId, actorId, key, environmentId) {
      const result = await toggleFlag(db, orgId, key, environmentId);
      if (!result) throw new NotFoundError('Flag not found');
      await flagOps.commit({
        kind: 'flag.toggled',
        orgId,
        actorId,
        flagKey: key,
        environmentId,
        enabled: result.enabled,
      });
      return result;
    },

    async updateCountryRules(orgId, actorId, key, environmentId, countries) {
      const normalized = countries.map((c) => c.toUpperCase());
      const result = await setFlagCountryRules(db, orgId, key, environmentId, normalized);
      if (!result) throw new NotFoundError('Flag not found');
      await flagOps.commit({
        kind: 'flag.country_rules',
        orgId,
        actorId,
        flagKey: key,
        environmentId,
        before: result.before,
        after: result.after,
      });
      return { countries: result.after };
    },

    // ── Environments ─────────────────────────────────────────────────────────

    async getEnvironments(orgId) {
      return flagOps.read.environments(orgId);
    },

    async createEnvironment(orgId, actorId, name) {
      const slug = slugify(name);
      if (!slug) throw new PreconditionError('Invalid name');
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      try {
        const environment = await insertEnvironmentWithKey(db, orgId, { name, slug, keyHash, keyHint });
        await flagOps.commit({
          kind: 'env.created',
          orgId,
          actorId,
          environmentId: environment.id,
          name,
          slug,
        });
        return { environment, apiKey: rawKey };
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Environment name already exists');
        throw err;
      }
    },

    async updateEnvironmentOrigins(orgId, actorId, id, allowedOrigins) {
      const result = await updateEnvironmentOrigins(db, orgId, id, allowedOrigins);
      if (!result) throw new NotFoundError('Environment not found');
      await flagOps.commit({
        kind: 'env.origins_updated',
        orgId,
        actorId,
        environmentId: id,
        allowedOrigins,
      });
      return result;
    },

    async deleteEnvironment(orgId, actorId, id) {
      const deleted = await deleteEnvironment(db, orgId, id);
      if (!deleted) throw new NotFoundError('Environment not found');
      await flagOps.commit({ kind: 'env.deleted', orgId, actorId, environmentId: id });
    },

    async rotateEnvironmentKey(orgId, actorId, envId) {
      const rawKey = generateApiKey();
      const keyHash = await hashKey(rawKey);
      const keyHint = maskKey(rawKey);
      await db.transaction(async (tx) => {
        const ok = await rotateEnvironmentKey(tx as unknown as DbClient, orgId, envId, { keyHash, keyHint });
        if (!ok) throw new NotFoundError('Environment not found');
      });
      await flagOps.commit({
        kind: 'env.key_rotated',
        orgId,
        actorId,
        environmentId: envId,
      });
      return { apiKey: rawKey };
    },

    // ── Members ──────────────────────────────────────────────────────────────

    async getMembers(orgId) {
      return flagOps.read.members(orgId);
    },

    async getRemovedMembers(orgId) {
      return flagOps.read.removedMembers(orgId);
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
      await flagOps.commit({
        kind: 'member.role_updated',
        orgId,
        actorId,
        userId,
        role,
      });
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
      await flagOps.commit({ kind: 'member.removed', orgId, actorId, userId });
    },

    async restoreMember(orgId, actorId, userId) {
      if (await queryUserIsSuperAdmin(db, userId)) {
        throw new ForbiddenError('Cannot restore a super admin');
      }
      const ok = await restoreMember(db, orgId, userId);
      if (!ok) throw new NotFoundError('Member not found');
      await flagOps.commit({ kind: 'member.restored', orgId, actorId, userId });
    },
  };
}
