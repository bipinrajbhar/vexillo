import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { createOrgOAuthRouter } from './org-oauth';
import type { Auth } from '../lib/auth';

// ── Mock DB ───────────────────────────────────────────────────────────────────

// Chainable mock DB — results consumed FIFO from the queue.
function makeMockDb(staticResults: unknown[][] = []) {
  const queue = [...staticResults];

  function consume(): unknown[] {
    return (queue.shift() ?? []) as unknown[];
  }

  const chain: Record<string, unknown> = {};

  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);

  for (const m of [
    'select', 'from', 'where', 'leftJoin', 'innerJoin',
    'insert', 'values', 'update', 'set', 'delete',
  ]) {
    chain[m] = () => chain;
  }

  for (const m of ['limit', 'orderBy', 'returning', 'onConflictDoNothing']) {
    chain[m] = () => Promise.resolve(consume());
  }

  return chain as unknown as Parameters<typeof createOrgOAuthRouter>[0];
}

// ── Mock Auth ─────────────────────────────────────────────────────────────────

const MOCK_SECRET = 'test-secret-for-org-oauth-signing-32ch!';

function makeMockAuth(overrides?: {
  findUserByEmail?: (email: string) => Promise<{ user: { id: string; email: string; name: string; isSuperAdmin?: boolean }; accounts: [] } | null>;
  createUser?: (user: Record<string, unknown>) => Promise<{ id: string } & Record<string, unknown>>;
  createSession?: (userId: string) => Promise<{ token: string }>;
}): Auth {
  return {
    $context: Promise.resolve({
      secret: MOCK_SECRET,
      authCookies: {
        sessionToken: {
          name: 'better-auth.session_token',
          attributes: {
            secure: false,
            sameSite: 'lax',
            path: '/',
            httpOnly: true,
            maxAge: 604800,
          },
        },
      },
      internalAdapter: {
        findUserByEmail: overrides?.findUserByEmail ?? (async () => null),
        createUser: overrides?.createUser ?? (async (u) => ({ id: 'user-new', ...u })),
        createSession: overrides?.createSession ?? (async () => ({ token: 'mock-session-token' })),
      },
    }),
  } as unknown as Auth;
}

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(
  db: Parameters<typeof createOrgOAuthRouter>[0],
  auth: Auth,
) {
  const app = new Hono();
  app.route('/api/auth/org-oauth', createOrgOAuthRouter(db, auth));
  return app;
}

const BASE = 'http://localhost/api/auth/org-oauth';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ACTIVE_ORG = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  oktaClientId: 'okta-client-id',
  oktaClientSecret: 'okta-client-secret',
  oktaIssuer: 'https://acme.okta.com',
  createdAt: new Date(),
};

const SUSPENDED_ORG = { ...ACTIVE_ORG, status: 'suspended' };

const MOCK_DISCOVERY = {
  authorization_endpoint: 'https://acme.okta.com/oauth2/v1/authorize',
  token_endpoint: 'https://acme.okta.com/oauth2/v1/token',
  userinfo_endpoint: 'https://acme.okta.com/oauth2/v1/userinfo',
};

// ── GET /:orgSlug/authorize ────────────────────────────────────────────────────

describe('GET /api/auth/org-oauth/:orgSlug/authorize', () => {
  it('returns 404 when org not found', async () => {
    const app = makeApp(makeMockDb([[]]), makeMockAuth());
    const res = await app.fetch(new Request(`${BASE}/nonexistent/authorize`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('returns 403 when org is suspended', async () => {
    const app = makeApp(makeMockDb([[SUSPENDED_ORG]]), makeMockAuth());
    const res = await app.fetch(new Request(`${BASE}/acme/authorize`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization suspended' });
  });

  it('returns 502 when OIDC discovery fails', async () => {
    // Org found, but fetch throws
    let fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => { throw new Error('network error'); }) as unknown as typeof globalThis.fetch,
    );
    try {
      const app = makeApp(makeMockDb([[ACTIVE_ORG]]), makeMockAuth());
      const res = await app.fetch(new Request(`${BASE}/acme/authorize`));
      expect(res.status).toBe(502);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('redirects to Okta with correct query params when org is valid', async () => {
    let fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async (url: string | URL | Request) => {
        if (String(url).includes('openid-configuration')) {
          return new Response(JSON.stringify(MOCK_DISCOVERY), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    );
    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      const app = makeApp(makeMockDb([[ACTIVE_ORG]]), makeMockAuth());
      const res = await app.fetch(new Request(`${BASE}/acme/authorize?next=/org/acme/flags`));

      expect(res.status).toBe(302);
      const location = res.headers.get('Location')!;
      const authUrl = new URL(location);

      expect(authUrl.origin + authUrl.pathname).toBe('https://acme.okta.com/oauth2/v1/authorize');
      expect(authUrl.searchParams.get('client_id')).toBe('okta-client-id');
      expect(authUrl.searchParams.get('response_type')).toBe('code');
      expect(authUrl.searchParams.get('scope')).toBe('openid email profile');
      expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/org-oauth/callback');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
      expect(authUrl.searchParams.get('state')).toBeTruthy(); // nonce
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sets a signed org_oauth_state cookie on valid org', async () => {
    let fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify(MOCK_DISCOVERY), {
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof globalThis.fetch,
    );
    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      const app = makeApp(makeMockDb([[ACTIVE_ORG]]), makeMockAuth());
      const res = await app.fetch(new Request(`${BASE}/acme/authorize?next=/org/acme/flags`));

      expect(res.status).toBe(302);
      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie).toContain('org_oauth_state=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Max-Age=600');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── GET /callback ─────────────────────────────────────────────────────────────

describe('GET /api/auth/org-oauth/callback', () => {
  it('redirects with error when code is missing', async () => {
    const app = makeApp(makeMockDb(), makeMockAuth());
    const res = await app.fetch(new Request(`${BASE}/callback?state=some-nonce`));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('error=invalid_callback');
  });

  it('redirects with error when state cookie is absent', async () => {
    const app = makeApp(makeMockDb(), makeMockAuth());
    const res = await app.fetch(new Request(`${BASE}/callback?code=abc&state=some-nonce`));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('error=state_missing');
  });

  it('redirects with error when state cookie signature is invalid', async () => {
    const app = makeApp(makeMockDb(), makeMockAuth());
    const res = await app.fetch(
      new Request(`${BASE}/callback?code=abc&state=some-nonce`, {
        headers: { Cookie: 'org_oauth_state=tampered-value-without-valid-signature' },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('error=invalid_state');
  });

  it('redirects with error when state nonce does not match cookie', async () => {
    // Build a valid signed cookie with nonce "correct-nonce", but send state="wrong-nonce"
    const { signedCookieForTest } = await buildTestStateCookie({
      nonce: 'correct-nonce',
      orgSlug: 'acme',
      next: '/org/acme/flags',
      codeVerifier: 'cv123',
    });
    const app = makeApp(makeMockDb(), makeMockAuth());
    const res = await app.fetch(
      new Request(`${BASE}/callback?code=abc&state=wrong-nonce`, {
        headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('error=state_mismatch');
  });

  it('returns error when org is not found after state verification', async () => {
    const { signedCookieForTest, nonce } = await buildTestStateCookie({
      nonce: 'nonce-abc',
      orgSlug: 'ghost-org',
      next: '/',
      codeVerifier: 'cv',
    });
    // DB returns empty (org not found) — limit(1) on limit pops []
    const app = makeApp(makeMockDb([[]]), makeMockAuth());
    const res = await app.fetch(
      new Request(`${BASE}/callback?code=abc&state=${nonce}`, {
        headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('error=org_not_found');
  });

  it('creates session and sets session cookie on successful auth', async () => {
    const { signedCookieForTest, nonce } = await buildTestStateCookie({
      nonce: 'nonce-xyz',
      orgSlug: 'acme',
      next: '/org/acme/flags',
      codeVerifier: 'verifier123',
    });

    let fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('openid-configuration')) {
          return new Response(JSON.stringify(MOCK_DISCOVERY), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('/token')) {
          return new Response(
            JSON.stringify({ access_token: 'mock-access-token', token_type: 'Bearer' }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (urlStr.includes('/userinfo')) {
          return new Response(
            JSON.stringify({ sub: 'user-sub', email: 'alice@acme.com', name: 'Alice' }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    );

    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      const sessionToken = 'generated-session-token-abc';
      const auth = makeMockAuth({
        findUserByEmail: async () => null, // new user
        createUser: async () => ({ id: 'user-new', email: 'alice@acme.com', name: 'Alice' }),
        createSession: async () => ({ token: sessionToken }),
      });

      const app = makeApp(makeMockDb([[ACTIVE_ORG]]), auth);
      const res = await app.fetch(
        new Request(`${BASE}/callback?code=authcode&state=${nonce}`, {
          headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
        }),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/org/acme/flags');

      // Session cookie should be set
      const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('Set-Cookie') ?? ''];
      const sessionCookie = cookies.find((c) => c.startsWith('better-auth.session_token='));
      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie).toContain('HttpOnly');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses existing user when email already registered', async () => {
    const { signedCookieForTest, nonce } = await buildTestStateCookie({
      nonce: 'nonce-existing',
      orgSlug: 'acme',
      next: '/',
      codeVerifier: 'cv',
    });

    let fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('openid-configuration'))
          return new Response(JSON.stringify(MOCK_DISCOVERY), { headers: { 'Content-Type': 'application/json' } });
        if (urlStr.includes('/token'))
          return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }), { headers: { 'Content-Type': 'application/json' } });
        if (urlStr.includes('/userinfo'))
          return new Response(JSON.stringify({ sub: 'sub', email: 'bob@acme.com', name: 'Bob' }), { headers: { 'Content-Type': 'application/json' } });
        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    );

    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      let createUserCalled = false;
      const auth = makeMockAuth({
        findUserByEmail: async () => ({ user: { id: 'existing-user', email: 'bob@acme.com', name: 'Bob' }, accounts: [] }),
        createUser: async () => { createUserCalled = true; return { id: 'should-not-be-called' }; },
        createSession: async () => ({ token: 'sess-tok' }),
      });

      const app = makeApp(makeMockDb([[ACTIVE_ORG]]), auth);
      await app.fetch(
        new Request(`${BASE}/callback?code=code&state=${nonce}`, {
          headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
        }),
      );

      expect(createUserCalled).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── SUPER_ADMIN_EMAILS auto-promotion + post-auth redirect ────────────────────

describe('SUPER_ADMIN_EMAILS auto-promotion and redirect', () => {
  // Shared fetch mock: returns discovery, token, and userinfo for alice@acme.com
  function mockFetchForAlice() {
    return spyOn(globalThis, 'fetch').mockImplementation(
      (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('openid-configuration'))
          return new Response(JSON.stringify(MOCK_DISCOVERY), { headers: { 'Content-Type': 'application/json' } });
        if (urlStr.includes('/token'))
          return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }), { headers: { 'Content-Type': 'application/json' } });
        if (urlStr.includes('/userinfo'))
          return new Response(JSON.stringify({ sub: 'sub', email: 'alice@acme.com', name: 'Alice' }), { headers: { 'Content-Type': 'application/json' } });
        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    );
  }

  it('promotes user and redirects to /admin when email matches SUPER_ADMIN_EMAILS', async () => {
    const { signedCookieForTest, nonce } = await buildTestStateCookie({
      nonce: 'nonce-promote',
      orgSlug: 'acme',
      next: '/org/acme/flags',
      codeVerifier: 'cv',
    });

    let fetchSpy = mockFetchForAlice();

    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      process.env.SUPER_ADMIN_EMAILS = 'alice@acme.com,other@example.com';

      // DB queue: [ACTIVE_ORG for org lookup, [] for update call]
      const db = makeMockDb([[ACTIVE_ORG], []]);
      // Track whether the update chain was awaited
      const originalUpdate = (db as unknown as Record<string, unknown>).update;
      let capturedUpdate = false;
      (db as unknown as Record<string, unknown>).update = (...args: unknown[]) => {
        capturedUpdate = true;
        return (originalUpdate as (...a: unknown[]) => unknown)(...args);
      };

      const auth = makeMockAuth({
        findUserByEmail: async () => null, // new user
        createUser: async () => ({ id: 'user-alice', email: 'alice@acme.com', name: 'Alice' }),
        createSession: async () => ({ token: 'sess-tok' }),
      });

      const app = makeApp(db, auth);
      const res = await app.fetch(
        new Request(`${BASE}/callback?code=code&state=${nonce}`, {
          headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
        }),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/admin');
      expect(capturedUpdate).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.SUPER_ADMIN_EMAILS;
    }
  });

  it('does not promote and redirects to next when email does not match SUPER_ADMIN_EMAILS', async () => {
    const { signedCookieForTest, nonce } = await buildTestStateCookie({
      nonce: 'nonce-no-promote',
      orgSlug: 'acme',
      next: '/org/acme/flags',
      codeVerifier: 'cv',
    });

    let fetchSpy = mockFetchForAlice();

    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      process.env.SUPER_ADMIN_EMAILS = 'notmatch@example.com';

      const db = makeMockDb([[ACTIVE_ORG]]);
      let updateCalled = false;
      const originalUpdate = (db as unknown as Record<string, unknown>).update;
      (db as unknown as Record<string, unknown>).update = (...args: unknown[]) => {
        updateCalled = true;
        return (originalUpdate as (...a: unknown[]) => unknown)(...args);
      };

      const auth = makeMockAuth({
        findUserByEmail: async () => null,
        createUser: async () => ({ id: 'user-alice', email: 'alice@acme.com', name: 'Alice' }),
        createSession: async () => ({ token: 'sess-tok' }),
      });

      const app = makeApp(db, auth);
      const res = await app.fetch(
        new Request(`${BASE}/callback?code=code&state=${nonce}`, {
          headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
        }),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/org/acme/flags');
      expect(updateCalled).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.SUPER_ADMIN_EMAILS;
    }
  });

  it('redirects existing super admin to /admin without email match', async () => {
    const { signedCookieForTest, nonce } = await buildTestStateCookie({
      nonce: 'nonce-existing-sa',
      orgSlug: 'acme',
      next: '/org/acme/flags',
      codeVerifier: 'cv',
    });

    let fetchSpy = mockFetchForAlice();

    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      // SUPER_ADMIN_EMAILS does not contain alice's email
      process.env.SUPER_ADMIN_EMAILS = 'someone-else@example.com';

      const auth = makeMockAuth({
        findUserByEmail: async () => ({
          user: { id: 'user-alice', email: 'alice@acme.com', name: 'Alice', isSuperAdmin: true },
          accounts: [],
        }),
        createSession: async () => ({ token: 'sess-tok' }),
      });

      const app = makeApp(makeMockDb([[ACTIVE_ORG]]), auth);
      const res = await app.fetch(
        new Request(`${BASE}/callback?code=code&state=${nonce}`, {
          headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
        }),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/admin');
    } finally {
      fetchSpy.mockRestore();
      delete process.env.SUPER_ADMIN_EMAILS;
    }
  });

  it('promotion is idempotent — already-super-admin user re-signs in without error', async () => {
    const { signedCookieForTest, nonce } = await buildTestStateCookie({
      nonce: 'nonce-idem',
      orgSlug: 'acme',
      next: '/',
      codeVerifier: 'cv',
    });

    let fetchSpy = mockFetchForAlice();

    try {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      process.env.SUPER_ADMIN_EMAILS = 'alice@acme.com';

      // DB: org lookup + update call
      const db = makeMockDb([[ACTIVE_ORG], []]);
      const auth = makeMockAuth({
        findUserByEmail: async () => ({
          user: { id: 'user-alice', email: 'alice@acme.com', name: 'Alice', isSuperAdmin: true },
          accounts: [],
        }),
        createSession: async () => ({ token: 'sess-tok' }),
      });

      const app = makeApp(db, auth);
      const res = await app.fetch(
        new Request(`${BASE}/callback?code=code&state=${nonce}`, {
          headers: { Cookie: `org_oauth_state=${signedCookieForTest}` },
        }),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/admin');
    } finally {
      fetchSpy.mockRestore();
      delete process.env.SUPER_ADMIN_EMAILS;
    }
  });
});

// ── GET /:orgSlug/meta ────────────────────────────────────────────────────────

describe('GET /api/auth/org-oauth/:orgSlug/meta', () => {
  it('returns 404 when org not found', async () => {
    const app = makeApp(makeMockDb([[]]), makeMockAuth());
    const res = await app.fetch(new Request(`${BASE}/ghost/meta`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('returns org name and status without secrets', async () => {
    const orgRow = { name: 'Acme', slug: 'acme', status: 'active' };
    const app = makeApp(makeMockDb([[orgRow]]), makeMockAuth());
    const res = await app.fetch(new Request(`${BASE}/acme/meta`));
    expect(res.status).toBe(200);
    const body = await res.json() as { org: typeof orgRow };
    expect(body.org.name).toBe('Acme');
    expect(body.org.slug).toBe('acme');
    expect(body.org.status).toBe('active');
  });
});

// ── Test helper — produce a valid signed state cookie ─────────────────────────

/**
 * Replicates the signing done by the authorize endpoint so that test cases
 * for the callback can provide a legitimate state cookie without needing to
 * call the authorize endpoint first.
 */
async function buildTestStateCookie(state: {
  nonce: string;
  orgSlug: string;
  next: string;
  codeVerifier: string;
}): Promise<{ signedCookieForTest: string; nonce: string }> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(MOCK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const value = JSON.stringify(state);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // The cookie header value is encodeURIComponent(`${value}.${signature}`)
  // but Hono's getCookie will decode it before returning to our handler.
  // To simulate what Hono sees after decoding, we pass the raw decoded form
  // to getCookie by setting the Cookie header with the ENCODED form.
  // So signedCookieForTest is what goes into the Cookie header (encoded).
  const signedCookieForTest = encodeURIComponent(`${value}.${signature}`);
  return { signedCookieForTest, nonce: state.nonce };
}
