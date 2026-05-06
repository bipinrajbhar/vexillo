import { describe, it, expect } from 'bun:test';
import * as schema from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { createTestDb } from '../pglite-test-helpers';
import { encryptSecret } from '../okta-crypto';
import { createOrgOAuth } from './org-oauth';
import { signCookieValue, verifyCookieValue } from './cookie-signing';
import { STATE_COOKIE } from './types';
import type { Auth } from '../auth';

// AES-GCM test key — fixed 32-byte hex so the okta-crypto round-trip is
// deterministic across the suite.
process.env.OKTA_SECRET_KEY = 'a'.repeat(64);

const SECRET = 'test-better-auth-secret-32-chars-!!';
const BASE_URL = 'http://localhost:3000';

// ── Auth fake ────────────────────────────────────────────────────────────────

type AuthHooks = {
  findUserByEmail?: (email: string) => Promise<{ user: { id: string; email: string } } | null>;
  createUser?: (input: Record<string, unknown>) => Promise<{ id: string }>;
  createSession?: (userId: string) => Promise<{ token: string }>;
};

function fakeAuth(hooks: AuthHooks = {}): Auth {
  return {
    $context: Promise.resolve({
      secret: SECRET,
      authCookies: {
        sessionToken: {
          name: 'better-auth.session_token',
          attributes: { secure: false, sameSite: 'lax', maxAge: 604800 },
        },
      },
      internalAdapter: {
        findUserByEmail: hooks.findUserByEmail ?? (async () => null),
        createUser:
          hooks.createUser ??
          (async (u: Record<string, unknown>) => ({ id: 'user-new', ...u })),
        createSession:
          hooks.createSession ?? (async () => ({ token: 'mock-session-token' })),
      },
    }),
  } as unknown as Auth;
}

// ── Fetch fake ───────────────────────────────────────────────────────────────

const DISCOVERY_PAYLOAD = {
  authorization_endpoint: 'https://acme.okta.com/oauth2/v1/authorize',
  token_endpoint: 'https://acme.okta.com/oauth2/v1/token',
  userinfo_endpoint: 'https://acme.okta.com/oauth2/v1/userinfo',
};

function fakeFetch(handlers: {
  discovery?: () => Response;
  token?: () => Response;
  userinfo?: () => Response;
}): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('openid-configuration')) {
      return handlers.discovery?.()
        ?? new Response(JSON.stringify(DISCOVERY_PAYLOAD), { status: 200 });
    }
    if (u.includes('/token')) {
      return handlers.token?.()
        ?? new Response(JSON.stringify({ access_token: 'okta-access', token_type: 'Bearer' }), {
          status: 200,
        });
    }
    if (u.includes('/userinfo')) {
      return handlers.userinfo?.()
        ?? new Response(JSON.stringify({ sub: 'okta-sub-1', email: 'a@x.com', name: 'A' }), {
          status: 200,
        });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedOrg(
  db: DbClient,
  attrs: { slug?: string; status?: 'active' | 'suspended'; plaintextSecret?: string } = {},
): Promise<{ id: string; slug: string }> {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: 'Acme',
      slug: attrs.slug ?? 'acme',
      oktaClientId: 'okta-client-id',
      oktaClientSecret: await encryptSecret(attrs.plaintextSecret ?? 'okta-client-secret'),
      oktaIssuer: 'https://acme.okta.com',
      status: attrs.status ?? 'active',
    })
    .returning({ id: schema.organizations.id, slug: schema.organizations.slug });
  return org;
}

function deterministicRandom() {
  return {
    randomUUID: () => 'uuid-deterministic',
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
  };
}

// ── beginAuthorize ───────────────────────────────────────────────────────────

describe('beginAuthorize', () => {
  it('returns redirect with a signed state cookie carrying the OAuth state', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
      ...deterministicRandom(),
    });

    const result = await svc.beginAuthorize({ orgSlug: 'acme', next: '/dashboard' });

    expect(result.kind).toBe('redirect');
    if (result.kind !== 'redirect') return;

    const url = new URL(result.location);
    expect(url.origin + url.pathname).toBe('https://acme.okta.com/oauth2/v1/authorize');
    expect(url.searchParams.get('client_id')).toBe('okta-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/auth/org-oauth/callback`);
    expect(url.searchParams.get('state')).toBe('uuid-deterministic');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const stateCookie = result.setCookies.find((c) => c.name === STATE_COOKIE);
    expect(stateCookie).toBeDefined();
    const json = await verifyCookieValue(decodeURIComponent(stateCookie!.value), SECRET);
    expect(json).not.toBeNull();
    const payload = JSON.parse(json!) as Record<string, unknown>;
    expect(payload.nonce).toBe('uuid-deterministic');
    expect(payload.orgSlug).toBe('acme');
    expect(payload.next).toBe('/dashboard');
    expect(typeof payload.codeVerifier).toBe('string');
  });

  it('returns failure org_not_found for an unknown slug', async () => {
    const db = await createTestDb();
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });

    expect(await svc.beginAuthorize({ orgSlug: 'missing', next: '/' })).toEqual({
      kind: 'failure',
      reason: 'org_not_found',
    });
  });

  it('returns failure org_suspended for a suspended org', async () => {
    const db = await createTestDb();
    await seedOrg(db, { status: 'suspended' });
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });

    expect(await svc.beginAuthorize({ orgSlug: 'acme', next: '/' })).toEqual({
      kind: 'failure',
      reason: 'org_suspended',
    });
  });

  it('returns failure oidc_discovery_failed when discovery fetch throws', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: (async () => {
        throw new Error('network error');
      }) as unknown as typeof fetch,
    });

    expect(await svc.beginAuthorize({ orgSlug: 'acme', next: '/' })).toEqual({
      kind: 'failure',
      reason: 'oidc_discovery_failed',
    });
  });
});

// ── completeCallback ─────────────────────────────────────────────────────────

async function buildStateCookie(payload: Record<string, unknown>): Promise<string> {
  const encoded = await signCookieValue(JSON.stringify(payload), SECRET);
  // The route receives the URL-decoded value (Hono's getCookie does the
  // decoding); pass that shape to the service so tests match production.
  return decodeURIComponent(encoded);
}

describe('completeCallback', () => {
  it('returns failure invalid_callback when code or state is missing', async () => {
    const db = await createTestDb();
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });

    const result = await svc.completeCallback({});
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.reason).toBe('invalid_callback');
  });

  it('returns failure state_missing when stateCookie is absent', async () => {
    const db = await createTestDb();
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });

    const result = await svc.completeCallback({ code: 'c', state: 's' });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.reason).toBe('state_missing');
  });

  it('returns failure invalid_state for a tampered state cookie', async () => {
    const db = await createTestDb();
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });

    const result = await svc.completeCallback({
      code: 'c',
      state: 's',
      stateCookie: 'tampered.deadbeef',
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.reason).toBe('invalid_state');
  });

  it('returns failure state_mismatch when nonce in state cookie does not match query state', async () => {
    const db = await createTestDb();
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });
    const stateCookie = await buildStateCookie({
      nonce: 'expected-nonce',
      orgSlug: 'acme',
      next: '/',
      codeVerifier: 'v',
    });

    const result = await svc.completeCallback({
      code: 'c',
      state: 'wrong-nonce',
      stateCookie,
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.reason).toBe('state_mismatch');
  });

  it('returns failure token_exchange_failed when the token endpoint rejects', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({
        token: () => new Response('bad', { status: 400 }),
      }),
    });
    const stateCookie = await buildStateCookie({
      nonce: 'n', orgSlug: 'acme', next: '/', codeVerifier: 'v',
    });

    const result = await svc.completeCallback({ code: 'c', state: 'n', stateCookie });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.reason).toBe('token_exchange_failed');
  });

  it('returns failure no_email when userinfo lacks an email', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({
        userinfo: () =>
          new Response(JSON.stringify({ sub: 'okta-sub-1' }), { status: 200 }),
      }),
    });
    const stateCookie = await buildStateCookie({
      nonce: 'n', orgSlug: 'acme', next: '/', codeVerifier: 'v',
    });

    const result = await svc.completeCallback({ code: 'c', state: 'n', stateCookie });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.reason).toBe('no_email');
  });

  it('returns failure access_revoked when JIT provisioner rejects', async () => {
    const db = await createTestDb();
    const org = await seedOrg(db);
    // Pre-seed the user as removed so the JIT provisioner returns access_revoked.
    const now = new Date();
    await db.insert(schema.authUser).values({
      id: 'u-existing',
      name: 'A',
      email: 'a@x.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.organizationMembers).values({
      orgId: org.id,
      userId: 'u-existing',
      role: 'viewer',
      removedAt: new Date(),
    });

    const svc = createOrgOAuth({
      db,
      auth: fakeAuth({
        findUserByEmail: async () => ({ user: { id: 'u-existing', email: 'a@x.com' } }),
      }),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });
    const stateCookie = await buildStateCookie({
      nonce: 'n', orgSlug: 'acme', next: '/', codeVerifier: 'v',
    });

    const result = await svc.completeCallback({ code: 'c', state: 'n', stateCookie });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') expect(result.reason).toBe('access_revoked');
  });

  it('happy path: redirects to next, sets signed session cookie + clears state cookie', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    // Pre-seed the user so the FK constraint is satisfied — the JIT provisioner
    // will insert a membership row, and that requires authUser to exist. The
    // fake `findUserByEmail` returns this id so we skip the `createUser` path.
    const now = new Date();
    await db.insert(schema.authUser).values({
      id: 'u-existing',
      name: 'A',
      email: 'a@x.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    let createdSessionFor: string | undefined;
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth({
        findUserByEmail: async () => ({ user: { id: 'u-existing', email: 'a@x.com' } }),
        createSession: async (userId) => {
          createdSessionFor = userId;
          return { token: 'session-token-xyz' };
        },
      }),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });
    const stateCookie = await buildStateCookie({
      nonce: 'n', orgSlug: 'acme', next: '/landing', codeVerifier: 'v',
    });

    const result = await svc.completeCallback({ code: 'c', state: 'n', stateCookie });

    expect(result.kind).toBe('redirect');
    if (result.kind !== 'redirect') return;
    expect(result.location).toBe('/landing');
    expect(createdSessionFor).toBe('u-existing');

    const session = result.setCookies.find(
      (cc) => cc.name === 'better-auth.session_token',
    );
    expect(session).toBeDefined();
    const verified = await verifyCookieValue(decodeURIComponent(session!.value), SECRET);
    expect(verified).toBe('session-token-xyz');

    const cleared = result.setCookies.find((cc) => cc.name === STATE_COOKIE);
    expect(cleared?.attrs.maxAge).toBe(0);
  });
});

// ── getOrgMeta ───────────────────────────────────────────────────────────────

describe('getOrgMeta', () => {
  it('returns org name + slug + status', async () => {
    const db = await createTestDb();
    await seedOrg(db, { slug: 'acme' });
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });

    const result = await svc.getOrgMeta('acme');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.org).toEqual({ name: 'Acme', slug: 'acme', status: 'active' });
    }
  });

  it('returns failure org_not_found for an unknown slug', async () => {
    const db = await createTestDb();
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fakeFetch({}),
    });

    expect(await svc.getOrgMeta('missing')).toEqual({
      kind: 'failure',
      reason: 'org_not_found',
    });
  });
});

// ── OIDC discovery cache ─────────────────────────────────────────────────────

describe('OIDC discovery cache', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  function manualClock(start = 0) {
    let t = start;
    return {
      clock: { now: () => t },
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  function discoveryFetch(opts: { onCall: () => void; failAfter?: number }): typeof fetch {
    let calls = 0;
    return (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('openid-configuration')) {
        calls += 1;
        opts.onCall();
        if (opts.failAfter !== undefined && calls > opts.failAfter) {
          throw new Error('discovery network failure');
        }
        return new Response(JSON.stringify(DISCOVERY_PAYLOAD), { status: 200 });
      }
      // Token / userinfo are out of scope for these tests.
      return new Response('not used', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('serves cached discovery on the second beginAuthorize within TTL', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    let calls = 0;
    const { clock } = manualClock(0);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: discoveryFetch({ onCall: () => (calls += 1) }),
      clock,
      ...deterministicRandom(),
    });

    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });

    expect(calls).toBe(1);
  });

  it('refetches discovery after TTL expires', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    let calls = 0;
    const { clock, advance } = manualClock(0);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: discoveryFetch({ onCall: () => (calls += 1) }),
      clock,
      ...deterministicRandom(),
    });

    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    advance(HOUR_MS + 1);
    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });

    expect(calls).toBe(2);
  });

  it('serves stale discovery within the grace window when the fetch fails', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    let calls = 0;
    const { clock, advance } = manualClock(0);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      // First call seeds the cache; subsequent calls fail.
      fetch: discoveryFetch({ onCall: () => (calls += 1), failAfter: 1 }),
      clock,
      ...deterministicRandom(),
    });

    // Prime the cache.
    const first = await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    expect(first.kind).toBe('redirect');

    // Past TTL but within grace, with the network failing — must still redirect.
    advance(HOUR_MS + 1);
    const second = await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    expect(second.kind).toBe('redirect');
    expect(calls).toBe(2); // refetch was attempted once after TTL
  });

  it('returns oidc_discovery_failed once the stale grace window has passed', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    const { clock, advance } = manualClock(0);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: discoveryFetch({ onCall: () => {}, failAfter: 1 }),
      clock,
      ...deterministicRandom(),
    });

    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    advance(DAY_MS + 1);

    expect(await svc.beginAuthorize({ orgSlug: 'acme', next: '/' })).toEqual({
      kind: 'failure',
      reason: 'oidc_discovery_failed',
    });
  });

  it('invalidateIssuer evicts the named issuer; the next call refetches', async () => {
    const db = await createTestDb();
    await seedOrg(db);
    let calls = 0;
    const { clock } = manualClock(0);
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: discoveryFetch({ onCall: () => (calls += 1) }),
      clock,
      ...deterministicRandom(),
    });

    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    expect(calls).toBe(1);

    svc.invalidateIssuer('https://acme.okta.com');
    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });

    expect(calls).toBe(2);
  });

  it('invalidateIssuer leaves entries for other issuers in place', async () => {
    const db = await createTestDb();
    await seedOrg(db, { slug: 'acme' });
    const [other] = await db
      .insert(schema.organizations)
      .values({
        name: 'Other',
        slug: 'other',
        oktaClientId: 'other-id',
        oktaClientSecret: await encryptSecret('other-secret'),
        oktaIssuer: 'https://other.okta.com',
        status: 'active',
      })
      .returning({ id: schema.organizations.id, slug: schema.organizations.slug });
    void other;

    const callsByIssuer: Record<string, number> = {};
    const { clock } = manualClock(0);
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('openid-configuration')) {
        const issuer = u.replace('/.well-known/openid-configuration', '');
        callsByIssuer[issuer] = (callsByIssuer[issuer] ?? 0) + 1;
        return new Response(JSON.stringify(DISCOVERY_PAYLOAD), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const svc = createOrgOAuth({
      db,
      auth: fakeAuth(),
      baseUrl: BASE_URL,
      superAdminEmails: '',
      fetch: fetchImpl,
      clock,
      ...deterministicRandom(),
    });

    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    await svc.beginAuthorize({ orgSlug: 'other', next: '/' });
    expect(callsByIssuer).toEqual({
      'https://acme.okta.com': 1,
      'https://other.okta.com': 1,
    });

    svc.invalidateIssuer('https://acme.okta.com');
    await svc.beginAuthorize({ orgSlug: 'acme', next: '/' });
    await svc.beginAuthorize({ orgSlug: 'other', next: '/' });

    expect(callsByIssuer).toEqual({
      'https://acme.okta.com': 2,
      'https://other.okta.com': 1,
    });
  });
});
