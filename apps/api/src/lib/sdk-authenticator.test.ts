import { describe, it, expect } from 'bun:test';
import { createSdkAuthenticator } from './sdk-authenticator';
import { createTestDb, seedSdk } from './pglite-test-helpers';
import { hashKey as defaultHashKey } from './api-key';

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Hash that defers each call until `release()` is called. Lets a test
 * interleave a stale-read refresh (which calls hashKey first) with another
 * operation like `evictByEnvironment` and assert the race outcome.
 */
function deferredHashKey() {
  const pending: Array<{
    token: string;
    resolve: (value: string) => void;
    reject: (err: unknown) => void;
  }> = [];
  return {
    hashKey: (token: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        pending.push({ token, resolve, reject });
      });
    },
    pending: () => pending.length,
    releaseAll: async (): Promise<void> => {
      const batch = pending.splice(0);
      for (const p of batch) {
        const real = await defaultHashKey(p.token);
        p.resolve(real);
      }
    },
    failAll: (): void => {
      const batch = pending.splice(0);
      for (const p of batch) p.reject(new Error('simulated DB blip'));
    },
  };
}

function countingHashKey() {
  let calls = 0;
  return {
    hashKey: async (token: string): Promise<string> => {
      calls++;
      return defaultHashKey(token);
    },
    callCount: () => calls,
  };
}

function manualClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// ── Public surface: header parsing and rejection matrix ─────────────────────

describe('SdkAuthenticator: header parsing and rejection matrix', () => {
  it('returns missing_token (401) when Authorization header is absent', async () => {
    const db = await createTestDb();
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: undefined,
      originHeader: undefined,
    });
    expect(res).toEqual({ ok: false, status: 401, reason: 'missing_token' });
  });

  it('returns missing_token (401) when header has no Bearer prefix', async () => {
    const db = await createTestDb();
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: 'sdk-validkey',
      originHeader: undefined,
    });
    expect(res).toEqual({ ok: false, status: 401, reason: 'missing_token' });
  });

  it('returns missing_token (401) when Bearer prefix is followed by an empty token', async () => {
    const db = await createTestDb();
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: 'Bearer ',
      originHeader: undefined,
    });
    expect(res).toEqual({ ok: false, status: 401, reason: 'missing_token' });
  });

  it('returns invalid_token (401) when the token is unknown to the database', async () => {
    const db = await createTestDb();
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: 'Bearer sdk-doesnotexist',
      originHeader: undefined,
    });
    expect(res).toEqual({ ok: false, status: 401, reason: 'invalid_token' });
  });

  it('returns org_suspended (403) when the org status is "suspended"', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, { orgStatus: 'suspended' });
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(res).toEqual({ ok: false, status: 403, reason: 'org_suspended' });
  });
});

// ── Public surface: origin matching ─────────────────────────────────────────

describe('SdkAuthenticator: origin matching', () => {
  it('echoes "*" when no Origin header is present (server/script request)', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, { allowedOrigins: ['https://app.example.com'] });
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.allowedOriginHeader).toBe('*');
  });

  it('echoes "*" when allowedOrigins contains "*"', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, { allowedOrigins: ['*'] });
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: 'https://anything.example',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.allowedOriginHeader).toBe('*');
  });

  it('echoes the request origin when it appears in the allowlist', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, {
      allowedOrigins: ['https://app.example.com', 'https://other.example'],
    });
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: 'https://app.example.com',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.allowedOriginHeader).toBe('https://app.example.com');
  });

  it('returns origin_forbidden (403) when the request origin is not in the allowlist', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, { allowedOrigins: ['https://app.example.com'] });
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: 'https://evil.example',
    });
    expect(res).toEqual({ ok: false, status: 403, reason: 'origin_forbidden' });
  });

  it('returns origin_forbidden (403) when allowedOrigins is empty and an Origin header is present', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db, { allowedOrigins: [] });
    const auth = createSdkAuthenticator({ db });
    const res = await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: 'https://anywhere.example',
    });
    expect(res).toEqual({ ok: false, status: 403, reason: 'origin_forbidden' });
  });
});

// ── Caching behaviour observed through authenticate() ───────────────────────

describe('SdkAuthenticator: cache hit skips re-hashing', () => {
  it('does not re-hash on a warm cache hit', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    const { hashKey, callCount } = countingHashKey();
    const auth = createSdkAuthenticator({ db, hashKey });

    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(1);

    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(1);
  });
});

describe('SdkAuthenticator.evictByEnvironment', () => {
  it('forces re-hashing on the next authenticate call for that environment', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    const { hashKey, callCount } = countingHashKey();
    const auth = createSdkAuthenticator({ db, hashKey });

    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(1);

    auth.evictByEnvironment(seed.environmentId);

    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(2);
  });

  it('does not affect tokens for other environments', async () => {
    const db = await createTestDb();
    const seedA = await seedSdk(db);
    const seedB = await seedSdk(db);
    const { hashKey, callCount } = countingHashKey();
    const auth = createSdkAuthenticator({ db, hashKey });

    await auth.authenticate({ authorizationHeader: `Bearer ${seedA.apiKey}`, originHeader: undefined });
    await auth.authenticate({ authorizationHeader: `Bearer ${seedB.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(2);

    auth.evictByEnvironment(seedA.environmentId);

    await auth.authenticate({ authorizationHeader: `Bearer ${seedA.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(3);

    // envB's token still warm.
    await auth.authenticate({ authorizationHeader: `Bearer ${seedB.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(3);
  });
});

describe('SdkAuthenticator.forgetEnvironment', () => {
  it('forces re-hashing AND returns invalid_token after the env row is deleted', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    const { hashKey, callCount } = countingHashKey();
    const auth = createSdkAuthenticator({ db, hashKey });

    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(1);

    // Simulate FlagOps env.deleted: drop the row, then call forget.
    await db.execute(`DELETE FROM api_keys` as never);
    auth.forgetEnvironment(seed.environmentId);

    const res = await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(res).toEqual({ ok: false, status: 401, reason: 'invalid_token' });
    expect(callCount()).toBe(2); // re-hashed on the synchronous re-validate
  });

  it('is a no-op when called for an environment that was never authenticated', async () => {
    const db = await createTestDb();
    const auth = createSdkAuthenticator({ db });
    expect(() => auth.forgetEnvironment('env-never-seen')).not.toThrow();
  });
});

// ── Race-safety: eviction during in-flight refresh ──────────────────────────

describe('SdkAuthenticator: eviction during a stale-read refresh', () => {
  it('does not repopulate the cache from a refresh that started before evict', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    const clock = manualClock(0);
    const deferred = deferredHashKey();
    const auth = createSdkAuthenticator({
      db,
      hashKey: deferred.hashKey,
      ttlMs: 100,
      now: clock.now,
    });

    // First call — cold-miss, immediately resolves the deferred so the slot
    // gets populated.
    const cold = auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    await deferred.releaseAll();
    expect(await cold).toMatchObject({ ok: true });

    // Advance past the TTL and trigger a stale-read refresh.
    clock.advance(150);
    const stale = auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(await stale).toMatchObject({ ok: true }); // served from stale slot

    // The background refresh is now waiting on the deferred hashKey. Evict
    // before it resolves.
    expect(deferred.pending()).toBeGreaterThan(0);
    auth.evictByEnvironment(seed.environmentId);

    // Now resolve the pending refresh. Its post-load generation check should
    // reject the result, leaving no usable cached slot.
    await deferred.releaseAll();
    await new Promise((r) => setTimeout(r, 0)); // let microtasks drain

    // Next call has to re-validate synchronously (no usable cached slot).
    const after = auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    // hashKey is deferred — there must be a pending call from the synchronous
    // re-validate. If the orphaned refresh had repopulated, this would have
    // served from cache and not added a new pending call.
    expect(deferred.pending()).toBe(1);
    await deferred.releaseAll();
    expect(await after).toMatchObject({ ok: true });
  });
});

// ── Refresh failure: dead flag forces re-validate ───────────────────────────

describe('SdkAuthenticator: stale-read refresh failure marks slot dead', () => {
  it('falls through to the synchronous DB path on the next call when the previous refresh threw', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    const clock = manualClock(0);
    const deferred = deferredHashKey();
    const auth = createSdkAuthenticator({
      db,
      hashKey: deferred.hashKey,
      ttlMs: 100,
      now: clock.now,
    });

    // Cold-miss populate.
    const cold = auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    await deferred.releaseAll();
    await cold;

    // Advance past TTL → stale read fires a background refresh.
    clock.advance(150);
    const stale = auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(await stale).toMatchObject({ ok: true }); // served stale

    // Background refresh's hashKey is pending — fail it.
    deferred.failAll();
    await new Promise((r) => setTimeout(r, 0)); // let .catch() run

    // Next call: slot is dead → synchronous re-validate fires another hashKey.
    const after = auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(deferred.pending()).toBe(1);
    await deferred.releaseAll();
    expect(await after).toMatchObject({ ok: true });
  });
});

// ── SWR via injected clock ──────────────────────────────────────────────────

describe('SdkAuthenticator: SWR + injected clock', () => {
  it('serves stale and refreshes in the background when ttl has elapsed', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    const clock = manualClock(0);
    const { hashKey, callCount } = countingHashKey();
    const auth = createSdkAuthenticator({
      db,
      hashKey,
      ttlMs: 100,
      now: clock.now,
    });

    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(1);

    // Within TTL: warm hit.
    clock.advance(50);
    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    expect(callCount()).toBe(1);

    // Past TTL: stale-served immediately + background refresh fires.
    clock.advance(100);
    await auth.authenticate({ authorizationHeader: `Bearer ${seed.apiKey}`, originHeader: undefined });
    // Let the fire-and-forget refresh's microtask chain settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(callCount()).toBe(2);
  });
});
