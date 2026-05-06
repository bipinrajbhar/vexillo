import { describe, it, expect } from 'bun:test';
import { eq, and } from 'drizzle-orm';
import { organizations, organizationMembers } from '@vexillo/db';
import { createOrgContextResolver } from './org-context-resolver';
import { NotFoundError, ForbiddenError } from './domain-errors';
import { createTestDb, seedOrgWithMember } from './pglite-test-helpers';

describe('OrgContextResolver', () => {
  it('returns org and role on the happy path', async () => {
    const db = await createTestDb();
    const { orgId, userId, slug } = await seedOrgWithMember(db, { role: 'admin' });
    const resolver = createOrgContextResolver({ db });

    const ctx = await resolver.resolve(slug, userId);
    expect(ctx.org.id).toBe(orgId);
    expect(ctx.role).toBe('admin');
  });

  it('throws NotFoundError for an unknown slug', async () => {
    const db = await createTestDb();
    const { userId } = await seedOrgWithMember(db);
    const resolver = createOrgContextResolver({ db });

    await expect(resolver.resolve('does-not-exist', userId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError when the org is suspended', async () => {
    const db = await createTestDb();
    const { userId, slug } = await seedOrgWithMember(db, { status: 'suspended' });
    const resolver = createOrgContextResolver({ db });

    await expect(resolver.resolve(slug, userId)).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: 'Organization suspended',
    });
  });

  it('throws ForbiddenError when the caller is not a member', async () => {
    const db = await createTestDb();
    const { slug } = await seedOrgWithMember(db);
    const resolver = createOrgContextResolver({ db });

    await expect(resolver.resolve(slug, 'outsider')).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: 'Not a member of this organization',
    });
  });

  // ── The assertions that the cached implementation could not make ─────────────

  it('reflects a suspension on the very next resolve()', async () => {
    const db = await createTestDb();
    const { orgId, userId, slug } = await seedOrgWithMember(db);
    const resolver = createOrgContextResolver({ db });

    await resolver.resolve(slug, userId); // would have populated the old cache

    await db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, orgId));

    await expect(resolver.resolve(slug, userId)).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: 'Organization suspended',
    });
  });

  it('reflects a role change on the very next resolve()', async () => {
    const db = await createTestDb();
    const { orgId, userId, slug } = await seedOrgWithMember(db, { role: 'admin' });
    const resolver = createOrgContextResolver({ db });

    expect((await resolver.resolve(slug, userId)).role).toBe('admin');

    await db
      .update(organizationMembers)
      .set({ role: 'viewer' })
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));

    expect((await resolver.resolve(slug, userId)).role).toBe('viewer');
  });

  it('reflects member removal on the very next resolve()', async () => {
    const db = await createTestDb();
    const { orgId, userId, slug } = await seedOrgWithMember(db);
    const resolver = createOrgContextResolver({ db });

    await resolver.resolve(slug, userId);

    await db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));

    await expect(resolver.resolve(slug, userId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('invalidate() is a documented no-op', async () => {
    const db = await createTestDb();
    const { orgId, userId } = await seedOrgWithMember(db);
    const resolver = createOrgContextResolver({ db });

    expect(() => resolver.invalidate(orgId, userId)).not.toThrow();
    expect(() => resolver.invalidate('never-seen', 'never-seen')).not.toThrow();
  });
});
