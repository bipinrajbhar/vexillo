import { describe, it, expect } from 'bun:test';
import { createSdkAuthenticator } from './sdk-authenticator';
import { createAuthCache } from './auth-cache';
import { createTestDb, seedSdk } from './pglite-test-helpers';

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

describe('SdkAuthenticator: caching', () => {
  it('serves a warm cache hit without re-running the auth query', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    let hashCalls = 0;
    const auth = createSdkAuthenticator({
      db,
      hashKey: async (token) => {
        hashCalls++;
        const data = new TextEncoder().encode(token);
        const buf = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      },
    });

    await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(hashCalls).toBe(1);

    await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    // Warm hit: the cache is keyed by raw token, so no second hash is needed.
    expect(hashCalls).toBe(1);
  });

  it('evictByEnvironment removes every cached entry for that environment', async () => {
    const db = await createTestDb();
    const seed = await seedSdk(db);
    const cache = createAuthCache();
    const auth = createSdkAuthenticator({ db, authCache: cache });

    await auth.authenticate({
      authorizationHeader: `Bearer ${seed.apiKey}`,
      originHeader: undefined,
    });
    expect(cache.get(seed.apiKey)).not.toBeNull();

    auth.evictByEnvironment(seed.environmentId);
    expect(cache.get(seed.apiKey)).toBeNull();
  });

  it('evictByEnvironment does not remove entries for other environments', async () => {
    const db = await createTestDb();
    const seedA = await seedSdk(db);
    const seedB = await seedSdk(db);
    const cache = createAuthCache();
    const auth = createSdkAuthenticator({ db, authCache: cache });

    await auth.authenticate({
      authorizationHeader: `Bearer ${seedA.apiKey}`,
      originHeader: undefined,
    });
    await auth.authenticate({
      authorizationHeader: `Bearer ${seedB.apiKey}`,
      originHeader: undefined,
    });

    auth.evictByEnvironment(seedA.environmentId);
    expect(cache.get(seedA.apiKey)).toBeNull();
    expect(cache.get(seedB.apiKey)).not.toBeNull();
  });
});
