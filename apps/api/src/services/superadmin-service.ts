import {
  queryAllOrgs,
  insertOrg,
  queryOrgBySlug,
  queryOrgWithMemberCount,
  updateOrgFields,
  setOrgStatus,
  deleteOrgById,
  queryOrgActiveMembership,
  querySuperAdminUsers,
  setUserSuperAdmin,
  type OrgRow,
  type OrgListRow,
  type SuperAdminUserRow,
} from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import {
  NotFoundError,
  ConflictError,
  PreconditionError,
  ForbiddenError,
  isUniqueError,
} from '../lib/domain-errors';
import { slugify } from '../lib/slugify';
import { encryptSecret, decryptSecret } from '../lib/okta-crypto';
import type { OrgOAuthService } from '../lib/org-oauth';

// ── Public types ──────────────────────────────────────────────────────────────

/** Org row returned to callers — always carries decrypted Okta client secret. */
export type OrgWithSecret = OrgRow;

export type OrgDetail = OrgRow & { memberCount: number };

export type SuperAdminUser = SuperAdminUserRow;

export type SuperAdminPatch = { id: string; email: string; isSuperAdmin: boolean };

export interface CreateOrgInput {
  name: string;
  slug?: string;
  oktaClientId: string;
  oktaClientSecret: string;
  oktaIssuer: string;
}

export interface UpdateOrgPatch {
  name?: string;
  oktaClientId?: string;
  oktaClientSecret?: string;
  oktaIssuer?: string;
}

// ── Service interface ─────────────────────────────────────────────────────────

export interface SuperAdminService {
  // Organizations
  listOrgs(): Promise<OrgListRow[]>;
  createOrg(actorId: string, input: CreateOrgInput): Promise<OrgWithSecret>;
  getOrg(slug: string): Promise<OrgDetail>;
  updateOrg(slug: string, patch: UpdateOrgPatch): Promise<OrgWithSecret>;
  suspendOrg(slug: string): Promise<{ status: 'suspended' }>;
  unsuspendOrg(slug: string): Promise<{ status: 'active' }>;
  deleteOrg(actorId: string, slug: string): Promise<void>;

  // Super-admin users
  listSuperAdminUsers(): Promise<SuperAdminUser[]>;
  setSuperAdminStatus(
    actorId: string,
    userId: string,
    isSuperAdmin: boolean,
  ): Promise<SuperAdminPatch>;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Optional dependency surface for invalidating the OIDC discovery cache when
 * an org's Okta config changes. Narrowed so SuperAdminService doesn't pull in
 * the full OrgOAuthService surface.
 */
export type SuperAdminOAuthInvalidator = Pick<OrgOAuthService, 'invalidateIssuer'>;

export function createSuperAdminService(
  db: DbClient,
  orgOAuth?: SuperAdminOAuthInvalidator,
): SuperAdminService {
  async function decryptOrgSecret(org: OrgRow): Promise<OrgWithSecret> {
    return { ...org, oktaClientSecret: await decryptSecret(org.oktaClientSecret) };
  }

  return {
    async listOrgs() {
      return queryAllOrgs(db);
    },

    async createOrg(_actorId, input) {
      const name = input.name.trim();
      if (!name) throw new PreconditionError('Name is required');

      const slug = input.slug?.trim() || slugify(name);
      if (!slug) throw new PreconditionError('Slug is required');

      const oktaClientId = input.oktaClientId.trim();
      const oktaClientSecret = input.oktaClientSecret.trim();
      const oktaIssuer = input.oktaIssuer.trim();
      if (!oktaClientId) throw new PreconditionError('oktaClientId is required');
      if (!oktaClientSecret) throw new PreconditionError('oktaClientSecret is required');
      if (!oktaIssuer) throw new PreconditionError('oktaIssuer is required');

      try {
        const org = await insertOrg(db, {
          name,
          slug,
          oktaClientId,
          oktaClientSecret: await encryptSecret(oktaClientSecret),
          oktaIssuer,
        });
        // Return plaintext to the caller — ciphertext never leaves this module.
        return { ...org, oktaClientSecret };
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Slug already exists');
        throw err;
      }
    },

    async getOrg(slug) {
      const found = await queryOrgWithMemberCount(db, slug);
      if (!found) throw new NotFoundError('Organization not found');
      const org = await decryptOrgSecret(found.org);
      return { ...org, memberCount: found.memberCount };
    },

    async updateOrg(slug, patch) {
      const fields: UpdateOrgPatch = {};
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name) throw new PreconditionError('Name cannot be empty');
        fields.name = name;
      }
      if (patch.oktaClientId !== undefined) fields.oktaClientId = patch.oktaClientId.trim();
      if (patch.oktaClientSecret !== undefined) {
        fields.oktaClientSecret = await encryptSecret(patch.oktaClientSecret.trim());
      }
      if (patch.oktaIssuer !== undefined) fields.oktaIssuer = patch.oktaIssuer.trim();

      if (Object.keys(fields).length === 0) {
        throw new PreconditionError('No fields to update');
      }

      // Snapshot the *old* issuer before the update so we can evict the
      // discovery cache for that URL. Only paid for when the patch touches
      // Okta config — name-only updates skip the extra read.
      const oktaConfigChanging =
        orgOAuth !== undefined &&
        (fields.oktaIssuer !== undefined ||
          fields.oktaClientId !== undefined ||
          fields.oktaClientSecret !== undefined);
      const oldIssuer = oktaConfigChanging
        ? (await queryOrgBySlug(db, slug))?.oktaIssuer
        : undefined;

      try {
        const updated = await updateOrgFields(db, slug, fields);
        if (!updated) throw new NotFoundError('Organization not found');
        if (orgOAuth && oldIssuer) orgOAuth.invalidateIssuer(oldIssuer);
        return decryptOrgSecret(updated);
      } catch (err) {
        if (isUniqueError(err)) throw new ConflictError('Slug already exists');
        throw err;
      }
    },

    async suspendOrg(slug) {
      const result = await setOrgStatus(db, slug, 'suspended');
      if (!result) throw new NotFoundError('Organization not found');
      return { status: 'suspended' };
    },

    async unsuspendOrg(slug) {
      const result = await setOrgStatus(db, slug, 'active');
      if (!result) throw new NotFoundError('Organization not found');
      return { status: 'active' };
    },

    async deleteOrg(actorId, slug) {
      const found = await queryOrgWithMemberCount(db, slug);
      if (!found) throw new NotFoundError('Organization not found');

      const ownMembership = await queryOrgActiveMembership(db, found.org.id, actorId);
      if (ownMembership) {
        throw new ForbiddenError('Cannot delete your own organization');
      }

      await deleteOrgById(db, found.org.id);
    },

    async listSuperAdminUsers() {
      return querySuperAdminUsers(db);
    },

    async setSuperAdminStatus(actorId, userId, isSuperAdmin) {
      if (userId === actorId && !isSuperAdmin) {
        throw new PreconditionError('Cannot demote yourself');
      }
      const updated = await setUserSuperAdmin(db, userId, isSuperAdmin);
      if (!updated) throw new NotFoundError('User not found');
      return updated;
    },
  };
}
