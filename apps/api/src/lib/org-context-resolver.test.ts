import { describe, it, expect } from 'bun:test';
import { createOrgContextResolver } from './org-context-resolver';
import { NotFoundError, ForbiddenError } from '../services/dashboard-service';
import type { OrgRow } from '../services/dashboard-service';
import type { DbClient } from '@vexillo/db';

// ── DB stub ──────────────────────────────────────────────────────────────────
//
// queryOrgBySlug and queryUserOrgRole both use:
//   db.select().from(...).where(...).limit(1)
// Each call to .limit() consumes one item from the queue.

function makeDb(sequence: unknown[][]): { db: DbClient; limitCallCount: () => number } {
  const queue = [...sequence];
  let count = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin']) {
    chain[m] = () => chain;
  }
  chain.limit = () => {
    count++;
    return Promise.resolve(queue.shift() ?? []);
  };
  return { db: chain as unknown as DbClient, limitCallCount: () => count };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG: OrgRow = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  oktaClientId: '',
  oktaClientSecret: '',
  oktaIssuer: '',
  createdAt: new Date(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrgContextResolver', () => {
  it('throws NotFoundError for an unknown slug', async () => {
    const { db } = makeDb([
      [], // queryOrgBySlug returns no rows
    ]);
    const resolver = createOrgContextResolver({ db });
    await expect(resolver.resolve('unknown', 'u-1')).rejects.toThrow(NotFoundError);
    await expect(resolver.resolve('unknown', 'u-1')).rejects.toMatchObject({ message: 'Organization not found' });
  });

  it('throws ForbiddenError for a suspended org', async () => {
    const suspended = { ...ORG, status: 'suspended' };
    const { db } = makeDb([
      [suspended], // queryOrgBySlug
      // queryUserOrgRole should NOT be called
      [suspended], // second call
    ]);
    const resolver = createOrgContextResolver({ db });
    await expect(resolver.resolve('acme', 'u-1')).rejects.toThrow(ForbiddenError);
    await expect(resolver.resolve('acme', 'u-1')).rejects.toMatchObject({ message: 'Organization suspended' });
  });

  it('throws ForbiddenError when user is not a member', async () => {
    const { db } = makeDb([
      [ORG],  // queryOrgBySlug
      [],     // queryUserOrgRole returns no rows
    ]);
    const resolver = createOrgContextResolver({ db });
    const err = await resolver.resolve('acme', 'u-outsider').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe('Not a member of this organization');
  });

  it('returns org and role on success', async () => {
    const { db } = makeDb([
      [ORG],            // queryOrgBySlug
      [{ role: 'admin' }], // queryUserOrgRole
    ]);
    const resolver = createOrgContextResolver({ db });
    const ctx = await resolver.resolve('acme', 'u-1');
    expect(ctx.org.id).toBe('org-1');
    expect(ctx.role).toBe('admin');
  });

  it('returns cached result on second call without querying the DB again', async () => {
    const { db, limitCallCount } = makeDb([
      [ORG],            // queryOrgBySlug — first resolve
      [{ role: 'admin' }], // queryUserOrgRole — first resolve
    ]);
    const resolver = createOrgContextResolver({ db });

    const ctx1 = await resolver.resolve('acme', 'u-1');
    const ctx2 = await resolver.resolve('acme', 'u-1'); // cache hit

    expect(ctx1).toBe(ctx2); // same object reference
    expect(limitCallCount()).toBe(2); // only 2 limit() calls total
  });

  it('uses separate cache entries for different users', async () => {
    const { db, limitCallCount } = makeDb([
      [ORG],               // queryOrgBySlug for u-1
      [{ role: 'admin' }], // queryUserOrgRole for u-1
      [ORG],               // queryOrgBySlug for u-2
      [{ role: 'viewer' }], // queryUserOrgRole for u-2
    ]);
    const resolver = createOrgContextResolver({ db });

    const ctx1 = await resolver.resolve('acme', 'u-1');
    const ctx2 = await resolver.resolve('acme', 'u-2');

    expect(ctx1.role).toBe('admin');
    expect(ctx2.role).toBe('viewer');
    expect(limitCallCount()).toBe(4); // no cross-user cache sharing
  });

  it('re-fetches from DB after invalidation', async () => {
    const { db, limitCallCount } = makeDb([
      [ORG],                 // first resolve: queryOrgBySlug
      [{ role: 'admin' }],   // first resolve: queryUserOrgRole
      [ORG],                 // after invalidation: queryOrgBySlug
      [{ role: 'viewer' }],  // after invalidation: queryUserOrgRole (role changed)
    ]);
    const resolver = createOrgContextResolver({ db });

    const ctx1 = await resolver.resolve('acme', 'u-1');
    expect(ctx1.role).toBe('admin');

    resolver.invalidate('org-1', 'u-1');

    const ctx2 = await resolver.resolve('acme', 'u-1');
    expect(ctx2.role).toBe('viewer');
    expect(limitCallCount()).toBe(4);
  });

  it('invalidate is a no-op when the org has never been resolved', () => {
    const { db } = makeDb([]);
    const resolver = createOrgContextResolver({ db });
    expect(() => resolver.invalidate('org-never-seen', 'u-1')).not.toThrow();
  });
});
