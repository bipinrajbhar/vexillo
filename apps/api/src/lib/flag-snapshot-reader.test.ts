import { describe, it, expect } from 'bun:test';
import { createFlagSnapshotReader } from './flag-snapshot-reader';
import { createFlagBus, createInMemoryInterContainerBus } from './flag-bus';
import { createTestDb, seedSdk } from './pglite-test-helpers';

function makeBus() {
  return createFlagBus({
    interContainer: createInMemoryInterContainerBus(),
    fanoutToRegions: () => {},
  });
}

describe('FlagSnapshotReader.read', () => {
  it('returns env-evaluated flags from the DB on a cold miss', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'feat-a', enabled: true },
    });
    const reader = createFlagSnapshotReader({ db, flagBus: makeBus() });

    const result = await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
    });
    expect(JSON.parse(result)).toEqual({
      flags: [{ key: 'feat-a', enabled: true }],
    });
  });

  it('returns enabled: true when the country matches and env toggle is on', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'geo', enabled: true, allowedCountries: ['US', 'CA'] },
    });
    const reader = createFlagSnapshotReader({ db, flagBus: makeBus() });

    const result = await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: 'US',
    });
    expect(JSON.parse(result)).toEqual({
      flags: [{ key: 'geo', enabled: true }],
    });
  });

  it('returns enabled: false when the country is not in the allowlist', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'geo', enabled: true, allowedCountries: ['US'] },
    });
    const reader = createFlagSnapshotReader({ db, flagBus: makeBus() });

    const result = await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: 'GB',
    });
    expect(JSON.parse(result)).toEqual({
      flags: [{ key: 'geo', enabled: false }],
    });
  });

  it('falls back to the env toggle when countryCode is null', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'geo', enabled: true, allowedCountries: ['US'] },
    });
    const reader = createFlagSnapshotReader({ db, flagBus: makeBus() });

    const result = await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
    });
    expect(JSON.parse(result)).toEqual({
      flags: [{ key: 'geo', enabled: true }],
    });
  });

  it('serves a warm hit from the snapshot cache without re-querying the DB', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'feat-a', enabled: true },
    });
    const bus = makeBus();
    const reader = createFlagSnapshotReader({ db, flagBus: bus });

    await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
    });

    // Mutate the DB row directly. If the second read hits the DB the result
    // would change; if it serves from cache it stays at the original value.
    await db.execute(`UPDATE flag_states SET enabled = false` as never);

    const result = await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
    });
    expect(JSON.parse(result)).toEqual({
      flags: [{ key: 'feat-a', enabled: true }],
    });
  });
});

describe('FlagSnapshotReader.openEvaluator', () => {
  it('returns an evaluator that applies the captured-but-late country code', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'geo', enabled: true, allowedCountries: ['US'] },
    });
    const reader = createFlagSnapshotReader({ db, flagBus: makeBus() });

    const evaluate = await reader.openEvaluator({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
    });

    expect(JSON.parse(evaluate('US'))).toEqual({
      flags: [{ key: 'geo', enabled: true }],
    });
    expect(JSON.parse(evaluate('GB'))).toEqual({
      flags: [{ key: 'geo', enabled: false }],
    });
    expect(JSON.parse(evaluate(null))).toEqual({
      flags: [{ key: 'geo', enabled: true }],
    });
  });

  it('applies rawPayloadOverride against the original country code (SSE re-evaluation contract)', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'geo', enabled: true, allowedCountries: [] },
    });
    const reader = createFlagSnapshotReader({ db, flagBus: makeBus() });

    const evaluate = await reader.openEvaluator({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
    });

    // Initial: no country rules → US viewer sees enabled: true
    expect(JSON.parse(evaluate('US'))).toEqual({
      flags: [{ key: 'geo', enabled: true }],
    });

    // FlagBus delivers an updated payload that adds a US-only allowlist.
    // The override is evaluated against the same captured country code.
    const overridePayload = JSON.stringify({
      flags: [{ key: 'geo', enabled: true, allowedCountries: ['US'] }],
    });
    expect(JSON.parse(evaluate('US', overridePayload))).toEqual({
      flags: [{ key: 'geo', enabled: true }],
    });
    expect(JSON.parse(evaluate('GB', overridePayload))).toEqual({
      flags: [{ key: 'geo', enabled: false }],
    });
  });
});

describe('FlagSnapshotReader.invalidate', () => {
  it('forces the next read to bypass the cache and re-query the DB', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      flag: { key: 'feat-a', enabled: true },
    });
    const reader = createFlagSnapshotReader({ db, flagBus: makeBus() });

    const first = await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
    });
    expect(JSON.parse(first).flags[0].enabled).toBe(true);

    await db.execute(`UPDATE flag_states SET enabled = false` as never);

    reader.invalidate(seed.environmentId);

    const second = await reader.read({
      orgId: seed.orgId,
      environmentId: seed.environmentId,
      countryCode: null,
    });
    expect(JSON.parse(second).flags[0].enabled).toBe(false);
  });
});
