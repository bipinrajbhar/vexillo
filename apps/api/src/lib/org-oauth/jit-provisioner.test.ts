import { describe, it, expect } from 'bun:test';
import * as schema from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { eq, and } from 'drizzle-orm';
import { createTestDb } from '../pglite-test-helpers';
import { createJitProvisioner } from './jit-provisioner';

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedOrg(db: DbClient, slug = 'acme'): Promise<{ id: string }> {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: 'Acme',
      slug,
      oktaClientId: 'okta-client',
      oktaClientSecret: 'okta-secret-ciphertext',
      oktaIssuer: 'https://acme.okta.com',
    })
    .returning({ id: schema.organizations.id });
  return org;
}

async function seedUser(
  db: DbClient,
  attrs: { id: string; email: string; isSuperAdmin?: boolean },
): Promise<void> {
  const now = new Date();
  await db.insert(schema.authUser).values({
    id: attrs.id,
    name: attrs.email.split('@')[0]!,
    email: attrs.email,
    emailVerified: true,
    isSuperAdmin: attrs.isSuperAdmin ?? false,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedMembership(
  db: DbClient,
  args: {
    orgId: string;
    userId: string;
    role: 'admin' | 'viewer';
    removedAt?: Date | null;
  },
): Promise<void> {
  await db.insert(schema.organizationMembers).values({
    orgId: args.orgId,
    userId: args.userId,
    role: args.role,
    removedAt: args.removedAt ?? null,
  });
}

async function readMembership(
  db: DbClient,
  orgId: string,
  userId: string,
): Promise<{ role: string; removedAt: Date | null } | null> {
  const [row] = await db
    .select({
      role: schema.organizationMembers.role,
      removedAt: schema.organizationMembers.removedAt,
    })
    .from(schema.organizationMembers)
    .where(
      and(
        eq(schema.organizationMembers.orgId, orgId),
        eq(schema.organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function readSuperAdmin(db: DbClient, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isSuperAdmin: schema.authUser.isSuperAdmin })
    .from(schema.authUser)
    .where(eq(schema.authUser.id, userId))
    .limit(1);
  return row?.isSuperAdmin ?? false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('rule 1: super-admin email match', () => {
  it('promotes the user to isSuperAdmin and inserts membership as admin', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-1', email: 'boss@x.com' });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-1', email: 'boss@x.com' },
      superAdminEmails: new Set(['boss@x.com']),
    });

    expect(result).toEqual({ ok: true, userId: 'u-1', role: 'admin', isSuperAdmin: true });
    expect(await readMembership(db, org.id, 'u-1')).toEqual({ role: 'admin', removedAt: null });
    expect(await readSuperAdmin(db, 'u-1')).toBe(true);
  });

  it('is idempotent — reinstates a previously revoked super-admin', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-1', email: 'boss@x.com' });
    await seedMembership(db, {
      orgId: org.id,
      userId: 'u-1',
      role: 'viewer',
      removedAt: new Date(),
    });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-1', email: 'boss@x.com' },
      superAdminEmails: new Set(['boss@x.com']),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.role).toBe('admin');
    expect(await readMembership(db, org.id, 'u-1')).toEqual({ role: 'admin', removedAt: null });
  });

  it('matches super-admin emails case-insensitively', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-1', email: 'Boss@X.com' });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-1', email: 'Boss@X.com' },
      superAdminEmails: new Set(['boss@x.com']),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isSuperAdmin).toBe(true);
  });
});

describe('rule 2: revoked member', () => {
  it('rejects with access_revoked and does not modify the membership', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-1', email: 'a@x.com' });
    const removedAt = new Date('2026-01-01T00:00:00Z');
    await seedMembership(db, { orgId: org.id, userId: 'u-1', role: 'viewer', removedAt });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-1', email: 'a@x.com' },
      superAdminEmails: new Set(),
    });

    expect(result).toEqual({ ok: false, reason: 'access_revoked' });
    expect(await readMembership(db, org.id, 'u-1')).toEqual({
      role: 'viewer',
      removedAt,
    });
  });
});

describe('rule 3: existing active member', () => {
  it('reuses the stored role and does not insert anything', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-1', email: 'a@x.com' });
    await seedMembership(db, { orgId: org.id, userId: 'u-1', role: 'admin' });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-1', email: 'a@x.com' },
      superAdminEmails: new Set(),
    });

    expect(result).toEqual({ ok: true, userId: 'u-1', role: 'admin', isSuperAdmin: false });
  });
});

describe('rule 4: first user into the org', () => {
  it('inserts as admin when org has zero admins', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-1', email: 'a@x.com' });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-1', email: 'a@x.com' },
      superAdminEmails: new Set(),
    });

    expect(result).toEqual({ ok: true, userId: 'u-1', role: 'admin', isSuperAdmin: false });
    expect(await readMembership(db, org.id, 'u-1')).toEqual({ role: 'admin', removedAt: null });
  });

  it('does not promote a user when the only existing admin has been revoked', async () => {
    // Org's only admin was removed → counts as zero active admins → next sign-in
    // promotes that user. (Documenting the rule's actual behavior — if the
    // product wants a different rule, update it here, not in the route.)
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-removed', email: 'removed@x.com' });
    await seedUser(db, { id: 'u-new', email: 'new@x.com' });
    await seedMembership(db, {
      orgId: org.id,
      userId: 'u-removed',
      role: 'admin',
      removedAt: new Date(),
    });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-new', email: 'new@x.com' },
      superAdminEmails: new Set(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.role).toBe('admin');
  });
});

describe('rule 5: subsequent users', () => {
  it('inserts as viewer when the org already has at least one admin', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    await seedUser(db, { id: 'u-admin', email: 'admin@x.com' });
    await seedUser(db, { id: 'u-2', email: 'b@x.com' });
    await seedMembership(db, { orgId: org.id, userId: 'u-admin', role: 'admin' });
    const provisioner = createJitProvisioner({ db });

    const result = await provisioner.provision({
      org: { id: org.id },
      identity: { userId: 'u-2', email: 'b@x.com' },
      superAdminEmails: new Set(),
    });

    expect(result).toEqual({ ok: true, userId: 'u-2', role: 'viewer', isSuperAdmin: false });
    expect(await readMembership(db, org.id, 'u-2')).toEqual({
      role: 'viewer',
      removedAt: null,
    });
  });
});
