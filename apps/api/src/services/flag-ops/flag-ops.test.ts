import { describe, it, expect } from 'bun:test';
import * as schema from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { eq, and } from 'drizzle-orm';
import { createTestDb, seedSdk } from '../../lib/pglite-test-helpers';
import { createFlagSnapshots, type FlagSnapshots } from '../../lib/flag-snapshots';
import {
  createInMemoryInterContainerBus,
  createPostgresSnapshotLoader,
} from '../../lib/flag-snapshots/adapters';
import type { OrgContextResolver } from '../../lib/org-context-resolver';
import type { SdkAuthenticator } from '../../lib/sdk-authenticator';
import { createFlagOps, type FlagOps } from './index';

// ── Fakes ────────────────────────────────────────────────────────────────────

function spySdkAuth(): SdkAuthenticator & {
  evictedEnvIds: string[];
  forgottenEnvIds: string[];
} {
  const evictedEnvIds: string[] = [];
  const forgottenEnvIds: string[] = [];
  return {
    authenticate: async () => ({ ok: false, status: 401, reason: 'missing_token' }),
    evictByEnvironment(envId) {
      evictedEnvIds.push(envId);
    },
    forgetEnvironment(envId) {
      forgottenEnvIds.push(envId);
    },
    evictedEnvIds,
    forgottenEnvIds,
  };
}

function spyOrgContext(): OrgContextResolver & {
  invalidations: Array<[string, string]>;
} {
  const invalidations: Array<[string, string]> = [];
  return {
    resolve: async () => {
      throw new Error('not used in flag-ops tests');
    },
    invalidate(orgId, userId) {
      invalidations.push([orgId, userId]);
    },
    invalidations,
  };
}

// ── Wiring helper ────────────────────────────────────────────────────────────

const ACTOR_ID = 'actor-1';

async function setup(): Promise<{
  db: DbClient;
  flagOps: FlagOps;
  flagSnapshots: FlagSnapshots;
  sdkAuth: ReturnType<typeof spySdkAuth>;
  orgContext: ReturnType<typeof spyOrgContext>;
  seed: Awaited<ReturnType<typeof seedSdk>>;
}> {
  const db = await createTestDb();
  const seed = await seedSdk(db, {
    flag: { key: 'feature-a', enabled: false },
  });
  // audit_logs.actor_id FK requires an existing user — seed one for the suite.
  const now = new Date();
  await db.insert(schema.authUser).values({
    id: ACTOR_ID,
    name: 'Actor',
    email: 'actor@x.com',
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const flagSnapshots = createFlagSnapshots({
    loader: createPostgresSnapshotLoader({ db }),
    interContainer: createInMemoryInterContainerBus(),
    fanoutToRegions: () => {},
  });
  const sdkAuth = spySdkAuth();
  const orgContext = spyOrgContext();
  const flagOps = createFlagOps({
    db,
    flagSnapshots: { writer: flagSnapshots.writer },
    sdkAuth,
    orgContext,
  });
  return { db, flagOps, flagSnapshots, sdkAuth, orgContext, seed };
}

async function readAuditLogs(
  db: DbClient,
  orgId: string,
): Promise<Array<{ action: string; targetType: string; targetId: string; metadata: unknown }>> {
  return db
    .select({
      action: schema.auditLogs.action,
      targetType: schema.auditLogs.targetType,
      targetId: schema.auditLogs.targetId,
      metadata: schema.auditLogs.metadata,
    })
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.orgId, orgId));
}

// ── read.* read-through ──────────────────────────────────────────────────────

describe('FlagOps.read.flagsWithStates', () => {
  it('caches the result so a mutation outside FlagOps is not visible until busted', async () => {
    const { db, flagOps, seed } = await setup();

    const first = await flagOps.read.flagsWithStates(seed.orgId);
    expect(first.flags).toHaveLength(1);

    // Mutate the DB outside FlagOps. If the second read served from cache, it
    // will still return the original row — confirming the cache is wired.
    await db.execute(`UPDATE flag_states SET enabled = true` as never);
    const second = await flagOps.read.flagsWithStates(seed.orgId);
    expect(second).toBe(first); // identity equality — same cached object
  });
});

describe('FlagOps.read.environments', () => {
  it('caches the env list', async () => {
    const { db, flagOps, seed } = await setup();
    const first = await flagOps.read.environments(seed.orgId);
    await db.delete(schema.environments).where(eq(schema.environments.orgId, seed.orgId));
    const second = await flagOps.read.environments(seed.orgId);
    expect(second).toBe(first);
  });
});

// ── commit: audit insertion ──────────────────────────────────────────────────

describe('FlagOps.commit — audit insertion', () => {
  it('writes the matching audit action for each event kind', async () => {
    const { db, flagOps, seed } = await setup();

    await flagOps.commit({
      kind: 'flag.toggled',
      orgId: seed.orgId,
      actorId: 'actor-1',
      flagKey: 'feature-a',
      environmentId: seed.environmentId,
      enabled: true,
    });

    const logs = await readAuditLogs(db, seed.orgId);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('flag.toggle');
    expect(logs[0]!.targetType).toBe('flag');
    expect(logs[0]!.targetId).toBe('feature-a');
  });

  it('uses the caller-provided tx so the audit row rolls back atomically when the tx fails', async () => {
    const { db, flagOps, seed } = await setup();

    await expect(
      db.transaction(async (tx) => {
        await flagOps.commit(
          {
            kind: 'flag.created',
            orgId: seed.orgId,
            actorId: 'actor-1',
            flagId: 'pretend-flag-id',
            flagKey: 'rollback-me',
            name: 'Rollback Me',
          },
          tx as unknown as DbClient,
        );
        throw new Error('caller-side rollback');
      }),
    ).rejects.toThrow('caller-side rollback');

    const logs = await readAuditLogs(db, seed.orgId);
    expect(logs).toHaveLength(0);
  });
});

// ── commit: flag.toggled — publish + cache bust + listener fan-out ──────────

describe('FlagOps.commit — flag.toggled', () => {
  it('publishes a fresh snapshot that the FlagSnapshots reader returns', async () => {
    const { db, flagOps, flagSnapshots, seed } = await setup();

    // Toggle the underlying state to true via raw SQL — FlagOps.commit will
    // re-query and broadcast the new state.
    await db
      .update(schema.flagStates)
      .set({ enabled: true })
      .where(
        and(
          eq(schema.flagStates.environmentId, seed.environmentId),
        ),
      );

    await flagOps.commit({
      kind: 'flag.toggled',
      orgId: seed.orgId,
      actorId: 'actor-1',
      flagKey: 'feature-a',
      environmentId: seed.environmentId,
      enabled: true,
    });

    const served = await flagSnapshots.reader.serve({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
    });
    const parsed = JSON.parse(served) as { flags: Array<{ key: string; enabled: boolean }> };
    expect(parsed.flags[0]).toEqual({ key: 'feature-a', enabled: true });
  });

  it('busts the flagsWithStates cache so the next read re-queries', async () => {
    const { db, flagOps, seed } = await setup();

    const first = await flagOps.read.flagsWithStates(seed.orgId);
    const envSlug = first.environments[0]!.slug;
    expect(first.flags[0]!.states[envSlug]).toBe(false);

    // Update the row + commit the toggled event → cache busts.
    await db.update(schema.flagStates).set({ enabled: true });
    await flagOps.commit({
      kind: 'flag.toggled',
      orgId: seed.orgId,
      actorId: 'actor-1',
      flagKey: 'feature-a',
      environmentId: seed.environmentId,
      enabled: true,
    });

    const second = await flagOps.read.flagsWithStates(seed.orgId);
    expect(second).not.toBe(first); // cache was busted
    expect(second.flags[0]!.states[envSlug]).toBe(true);
  });

  it('delivers a frame to a registered SSE listener', async () => {
    const { db, flagOps, flagSnapshots, seed } = await setup();

    const frames: string[] = [];
    const session = await flagSnapshots.reader.openSession({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
      onFrame: (json) => frames.push(json),
    });

    await db.update(schema.flagStates).set({ enabled: true });
    await flagOps.commit({
      kind: 'flag.toggled',
      orgId: seed.orgId,
      actorId: 'actor-1',
      flagKey: 'feature-a',
      environmentId: seed.environmentId,
      enabled: true,
    });

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toEqual({
      flags: [{ key: 'feature-a', enabled: true }],
    });
    session.close();
  });
});

// ── commit: env.* — SDK auth eviction is mandatory ──────────────────────────

describe('FlagOps.commit — env.key_rotated', () => {
  it('evicts the SDK auth cache for that environment + busts envsCache', async () => {
    const { flagOps, sdkAuth, seed } = await setup();

    // Prime the envs cache.
    await flagOps.read.environments(seed.orgId);

    await flagOps.commit({
      kind: 'env.key_rotated',
      orgId: seed.orgId,
      actorId: 'actor-1',
      environmentId: seed.environmentId,
    });

    expect(sdkAuth.evictedEnvIds).toEqual([seed.environmentId]);
  });
});

describe('FlagOps.commit — env.origins_updated', () => {
  it('evicts the SDK auth cache for that environment', async () => {
    const { flagOps, sdkAuth, seed } = await setup();

    await flagOps.commit({
      kind: 'env.origins_updated',
      orgId: seed.orgId,
      actorId: 'actor-1',
      environmentId: seed.environmentId,
      allowedOrigins: ['https://app.example'],
    });

    expect(sdkAuth.evictedEnvIds).toEqual([seed.environmentId]);
  });
});

describe('FlagOps.commit — env.deleted', () => {
  it('forgets the environment in the SDK authenticator (cleans up the generations table)', async () => {
    const { flagOps, sdkAuth, seed } = await setup();

    await flagOps.commit({
      kind: 'env.deleted',
      orgId: seed.orgId,
      actorId: 'actor-1',
      environmentId: seed.environmentId,
    });

    expect(sdkAuth.forgottenEnvIds).toEqual([seed.environmentId]);
    // env.deleted is a stronger statement than evict — `forget` reclaims the
    // generations-table entry. We deliberately don't also call evict here.
    expect(sdkAuth.evictedEnvIds).toEqual([]);
  });
});

// ── commit: member.* — OrgContext eviction is mandatory ─────────────────────

describe('FlagOps.commit — member events', () => {
  it.each(['member.role_updated', 'member.removed', 'member.restored'] as const)(
    '%s evicts the OrgContextResolver entry for the (orgId, userId) pair',
    async (kind) => {
      const { flagOps, orgContext, seed } = await setup();

      const event =
        kind === 'member.role_updated'
          ? {
              kind,
              orgId: seed.orgId,
              actorId: 'actor-1',
              userId: 'u-target',
              role: 'viewer' as const,
            }
          : {
              kind,
              orgId: seed.orgId,
              actorId: 'actor-1',
              userId: 'u-target',
            };

      await flagOps.commit(event);

      expect(orgContext.invalidations).toEqual([[seed.orgId, 'u-target']]);
    },
  );

  it('busts both members and removedMembers caches after a membership mutation', async () => {
    const { db, flagOps, seed } = await setup();
    // Seed a member to populate both caches.
    const now = new Date();
    await db.insert(schema.authUser).values({
      id: 'u-1',
      name: 'A',
      email: 'a@x.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.organizationMembers).values({
      orgId: seed.orgId,
      userId: 'u-1',
      role: 'admin',
    });

    const firstMembers = await flagOps.read.members(seed.orgId);
    const firstRemoved = await flagOps.read.removedMembers(seed.orgId);

    // Cache hit confirms wiring.
    expect(await flagOps.read.members(seed.orgId)).toBe(firstMembers);

    await flagOps.commit({
      kind: 'member.removed',
      orgId: seed.orgId,
      actorId: 'actor-1',
      userId: 'u-1',
    });

    expect(await flagOps.read.members(seed.orgId)).not.toBe(firstMembers);
    expect(await flagOps.read.removedMembers(seed.orgId)).not.toBe(firstRemoved);
  });
});
