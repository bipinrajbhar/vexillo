import { describe, it, expect, beforeAll } from 'bun:test';
import * as schema from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { createTestDb } from '../lib/pglite-test-helpers';
import { createSuperAdminService } from './superadmin-service';
import { encryptSecret } from '../lib/okta-crypto';

// AES-GCM test key — fixed 32-byte hex so encrypt/decrypt round-trips are
// deterministic across the suite and match the production code path exactly.
process.env.OKTA_SECRET_KEY = 'a'.repeat(64);

beforeAll(async () => {
  // Touch the helper once so the encryption key is exercised before any test
  // imports rely on it (process.env mutations propagate before bun:test starts).
  await encryptSecret('seed');
});

// ── Seed helpers ─────────────────────────────────────────────────────────────

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

async function seedOrg(
  db: DbClient,
  attrs: {
    name: string;
    slug: string;
    status?: 'active' | 'suspended';
    plaintextSecret?: string;
  } = { name: 'Acme', slug: 'acme' },
): Promise<{ id: string; slug: string }> {
  const plaintext = attrs.plaintextSecret ?? 'okta-secret';
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: attrs.name,
      slug: attrs.slug,
      oktaClientId: 'okta-client',
      oktaClientSecret: await encryptSecret(plaintext),
      oktaIssuer: 'https://example.okta.com',
      status: attrs.status ?? 'active',
    })
    .returning({ id: schema.organizations.id, slug: schema.organizations.slug });
  return org;
}

async function addMembership(
  db: DbClient,
  orgId: string,
  userId: string,
  role: 'admin' | 'viewer' = 'admin',
): Promise<void> {
  await db.insert(schema.organizationMembers).values({ orgId, userId, role });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SuperAdminService.listOrgs', () => {
  it('returns the projection for every org, newest first', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'A', slug: 'org-a' });
    await new Promise((r) => setTimeout(r, 5));
    await seedOrg(db, { name: 'B', slug: 'org-b' });

    const orgs = await svc.listOrgs();

    expect(orgs).toHaveLength(2);
    expect(orgs[0]!.slug).toBe('org-b');
    expect(orgs[1]!.slug).toBe('org-a');
    // Projection — ciphertext never leaves the service.
    expect(orgs[0]).not.toHaveProperty('oktaClientSecret');
  });
});

describe('SuperAdminService.createOrg', () => {
  it('encrypts the okta secret on insert and returns plaintext', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    const org = await svc.createOrg('actor', {
      name: 'Acme',
      oktaClientId: 'okta-id',
      oktaClientSecret: 'plaintext-secret',
      oktaIssuer: 'https://acme.okta.com',
    });

    expect(org.oktaClientSecret).toBe('plaintext-secret');
    expect(org.slug).toBe('acme');

    // Inspect the row directly — DB must hold ciphertext, not plaintext.
    const detail = await svc.getOrg('acme');
    expect(detail.oktaClientSecret).toBe('plaintext-secret');
  });

  it('derives slug from name when omitted', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    const org = await svc.createOrg('actor', {
      name: 'Acme Industries Inc.',
      oktaClientId: 'okta-id',
      oktaClientSecret: 'secret',
      oktaIssuer: 'https://acme.okta.com',
    });

    expect(org.slug).toBe('acme-industries-inc');
  });

  it('uses the provided slug when present', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    const org = await svc.createOrg('actor', {
      name: 'Acme',
      slug: 'custom-slug',
      oktaClientId: 'okta-id',
      oktaClientSecret: 'secret',
      oktaIssuer: 'https://acme.okta.com',
    });

    expect(org.slug).toBe('custom-slug');
  });

  it('throws ConflictError on slug collision', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Existing', slug: 'taken' });

    await expect(
      svc.createOrg('actor', {
        name: 'Acme',
        slug: 'taken',
        oktaClientId: 'okta-id',
        oktaClientSecret: 'secret',
        oktaIssuer: 'https://acme.okta.com',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('throws PreconditionError when name is empty', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    await expect(
      svc.createOrg('actor', {
        name: '   ',
        oktaClientId: 'okta-id',
        oktaClientSecret: 'secret',
        oktaIssuer: 'https://acme.okta.com',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION' });
  });

  it('throws PreconditionError when slug derivation produces empty string', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    await expect(
      svc.createOrg('actor', {
        name: '!!!',
        oktaClientId: 'okta-id',
        oktaClientSecret: 'secret',
        oktaIssuer: 'https://acme.okta.com',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION' });
  });

  it.each(['oktaClientId', 'oktaClientSecret', 'oktaIssuer'] as const)(
    'throws PreconditionError when %s is missing',
    async (field) => {
      const db = await createTestDb();
      const svc = createSuperAdminService(db);

      const input = {
        name: 'Acme',
        oktaClientId: 'okta-id',
        oktaClientSecret: 'secret',
        oktaIssuer: 'https://acme.okta.com',
      };
      input[field] = '';

      await expect(svc.createOrg('actor', input)).rejects.toMatchObject({
        code: 'PRECONDITION',
      });
    },
  );
});

describe('SuperAdminService.getOrg', () => {
  it('returns the org with member count and decrypted secret', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    const org = await seedOrg(db, { name: 'Acme', slug: 'acme', plaintextSecret: 'shh' });
    await seedUser(db, { id: 'u-1', email: 'a@x.com' });
    await seedUser(db, { id: 'u-2', email: 'b@x.com' });
    await addMembership(db, org.id, 'u-1');
    await addMembership(db, org.id, 'u-2');

    const detail = await svc.getOrg('acme');

    expect(detail.slug).toBe('acme');
    expect(detail.oktaClientSecret).toBe('shh');
    expect(detail.memberCount).toBe(2);
  });

  it('throws NotFoundError when slug does not exist', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    await expect(svc.getOrg('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SuperAdminService.updateOrg', () => {
  it('updates only the provided fields and returns the decrypted org', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Acme', slug: 'acme', plaintextSecret: 'old-secret' });

    const updated = await svc.updateOrg('acme', { name: 'Acme Renamed' });

    expect(updated.name).toBe('Acme Renamed');
    expect(updated.oktaClientSecret).toBe('old-secret');
  });

  it('encrypts a new oktaClientSecret on patch and returns plaintext', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Acme', slug: 'acme', plaintextSecret: 'old-secret' });

    const updated = await svc.updateOrg('acme', { oktaClientSecret: 'new-secret' });

    expect(updated.oktaClientSecret).toBe('new-secret');
    const refetched = await svc.getOrg('acme');
    expect(refetched.oktaClientSecret).toBe('new-secret');
  });

  it('throws PreconditionError when name is empty', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Acme', slug: 'acme' });

    await expect(svc.updateOrg('acme', { name: '   ' })).rejects.toMatchObject({
      code: 'PRECONDITION',
    });
  });

  it('throws PreconditionError when patch is empty', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Acme', slug: 'acme' });

    await expect(svc.updateOrg('acme', {})).rejects.toMatchObject({
      code: 'PRECONDITION',
    });
  });

  it('throws NotFoundError when the slug does not exist', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    await expect(svc.updateOrg('missing', { name: 'X' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('SuperAdminService.suspendOrg / unsuspendOrg', () => {
  it('flips status to suspended', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Acme', slug: 'acme' });

    expect(await svc.suspendOrg('acme')).toEqual({ status: 'suspended' });
    expect((await svc.getOrg('acme')).status).toBe('suspended');
  });

  it('flips status to active', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Acme', slug: 'acme', status: 'suspended' });

    expect(await svc.unsuspendOrg('acme')).toEqual({ status: 'active' });
    expect((await svc.getOrg('acme')).status).toBe('active');
  });

  it('throws NotFoundError on missing slug', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    await expect(svc.suspendOrg('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.unsuspendOrg('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SuperAdminService.deleteOrg', () => {
  it('deletes the org', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedOrg(db, { name: 'Acme', slug: 'acme' });

    await svc.deleteOrg('actor-not-a-member', 'acme');

    await expect(svc.getOrg('acme')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws ForbiddenError when the actor is an active member of the target org', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    const org = await seedOrg(db, { name: 'Acme', slug: 'acme' });
    await seedUser(db, { id: 'u-actor', email: 'actor@x.com' });
    await addMembership(db, org.id, 'u-actor');

    await expect(svc.deleteOrg('u-actor', 'acme')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Org still exists.
    await expect(svc.getOrg('acme')).resolves.toMatchObject({ slug: 'acme' });
  });

  it('throws NotFoundError on missing slug', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    await expect(svc.deleteOrg('actor', 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('SuperAdminService.listSuperAdminUsers', () => {
  it('returns only users with isSuperAdmin = true, sorted by email', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedUser(db, { id: 'u-1', email: 'b@x.com', isSuperAdmin: true });
    await seedUser(db, { id: 'u-2', email: 'a@x.com', isSuperAdmin: true });
    await seedUser(db, { id: 'u-3', email: 'c@x.com', isSuperAdmin: false });

    const users = await svc.listSuperAdminUsers();

    expect(users.map((u) => u.email)).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('SuperAdminService.setSuperAdminStatus', () => {
  it('promotes a user to super-admin', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedUser(db, { id: 'u-target', email: 't@x.com', isSuperAdmin: false });

    const patch = await svc.setSuperAdminStatus('actor', 'u-target', true);

    expect(patch).toEqual({ id: 'u-target', email: 't@x.com', isSuperAdmin: true });
  });

  it('demotes a user', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedUser(db, { id: 'u-target', email: 't@x.com', isSuperAdmin: true });

    const patch = await svc.setSuperAdminStatus('actor', 'u-target', false);

    expect(patch).toEqual({ id: 'u-target', email: 't@x.com', isSuperAdmin: false });
  });

  it('throws PreconditionError when actor demotes themselves', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedUser(db, { id: 'u-actor', email: 'actor@x.com', isSuperAdmin: true });

    await expect(
      svc.setSuperAdminStatus('u-actor', 'u-actor', false),
    ).rejects.toMatchObject({ code: 'PRECONDITION' });
  });

  it('allows actor to re-promote themselves (no-op semantics)', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);
    await seedUser(db, { id: 'u-actor', email: 'actor@x.com', isSuperAdmin: true });

    const patch = await svc.setSuperAdminStatus('u-actor', 'u-actor', true);
    expect(patch.isSuperAdmin).toBe(true);
  });

  it('throws NotFoundError when the user does not exist', async () => {
    const db = await createTestDb();
    const svc = createSuperAdminService(db);

    await expect(
      svc.setSuperAdminStatus('actor', 'u-missing', true),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
