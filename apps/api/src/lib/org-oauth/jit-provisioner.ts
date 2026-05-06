import {
  countOrgAdmins,
  insertOrgMember,
  queryOrgMembership,
  setUserSuperAdmin,
  upsertOrgMember,
} from '@vexillo/db';
import type { DbClient } from '@vexillo/db';

/**
 * The role-decision rules for vexillo's just-in-time org provisioning, applied
 * after Okta has authenticated a user and BetterAuth has materialised an
 * `authUser` row. Five named rules, evaluated in order:
 *
 *   1. Super-admin email match → upsert membership to `admin`, set
 *      `authUser.isSuperAdmin = true`. Idempotent on every sign-in (a previously
 *      removed super-admin is reinstated).
 *   2. Existing membership with `removedAt` set → reject with `access_revoked`.
 *      A revoked member cannot get back in via SSO; an org admin must restore
 *      them explicitly.
 *   3. Existing active membership → reuse the stored role; no insert/update.
 *   4. New (no membership), org has zero admins → insert as `admin`. The first
 *      user to sign into a fresh org is the bootstrap admin.
 *   5. New (no membership), org has at least one admin → insert as `viewer`.
 *
 * The rules live here, named, instead of inline at the bottom of a 175-LOC
 * route handler. Tests in jit-provisioner.test.ts exercise each rule by name.
 */

export type ProvisionInput = {
  org: { id: string };
  identity: { userId: string; email: string };
  superAdminEmails: ReadonlySet<string>;
};

export type ProvisionResult =
  | { ok: true; userId: string; role: 'admin' | 'viewer'; isSuperAdmin: boolean }
  | { ok: false; reason: 'access_revoked' };

export interface JitProvisioner {
  provision(input: ProvisionInput): Promise<ProvisionResult>;
}

export function createJitProvisioner(deps: { db: DbClient }): JitProvisioner {
  const { db } = deps;

  return {
    async provision({ org, identity, superAdminEmails }) {
      const isSuperAdmin = superAdminEmails.has(identity.email.toLowerCase());

      // Rule 1: super-admin path — promote on every sign-in (idempotent).
      if (isSuperAdmin) {
        await setUserSuperAdmin(db, identity.userId, true);
        await upsertOrgMember(db, {
          orgId: org.id,
          userId: identity.userId,
          role: 'admin',
        });
        return { ok: true, userId: identity.userId, role: 'admin', isSuperAdmin: true };
      }

      const existing = await queryOrgMembership(db, org.id, identity.userId);

      // Rule 2: revoked member — SSO cannot bring them back.
      if (existing?.removedAt) {
        return { ok: false, reason: 'access_revoked' };
      }

      // Rule 3: existing active member — reuse stored role.
      if (existing) {
        return {
          ok: true,
          userId: identity.userId,
          role: roleOf(existing.role),
          isSuperAdmin: false,
        };
      }

      // Rule 4 & 5: brand-new member — admin if first into the org, else viewer.
      const adminCount = await countOrgAdmins(db, org.id);
      const role: 'admin' | 'viewer' = adminCount === 0 ? 'admin' : 'viewer';
      await insertOrgMember(db, { orgId: org.id, userId: identity.userId, role });
      return { ok: true, userId: identity.userId, role, isSuperAdmin: false };
    },
  };
}

function roleOf(stored: string): 'admin' | 'viewer' {
  return stored === 'admin' ? 'admin' : 'viewer';
}
