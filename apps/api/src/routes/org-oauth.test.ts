import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createOrgOAuthRouter } from './org-oauth';
import { STATE_COOKIE, type OrgOAuthService } from '../lib/org-oauth';

// The route's only job is HTTP plumbing: serializing CookieSpec into Set-Cookie
// headers, dispatching GET vs POST callback bodies, and mapping authorize
// failure reasons to status codes / error reasons to /?error= redirects.
// Domain behavior — PKCE, OIDC discovery, token exchange, JIT provisioning —
// is covered by the boundary tests in lib/org-oauth/. This file uses an
// in-memory stub service so the assertions stay focused on the HTTP boundary.

const ALL_REJECT: OrgOAuthService = {
  beginAuthorize: async () => ({ kind: 'failure', reason: 'org_not_found' }),
  completeCallback: async () => ({
    kind: 'failure',
    reason: 'invalid_callback',
    clearCookies: [],
  }),
  getOrgMeta: async () => ({ kind: 'failure', reason: 'org_not_found' }),
  invalidateIssuer: () => {},
};

function stubService(overrides: Partial<OrgOAuthService> = {}): OrgOAuthService {
  return { ...ALL_REJECT, ...overrides };
}

function makeApp(svc: OrgOAuthService): Hono {
  const app = new Hono();
  app.route('/api/auth/org-oauth', createOrgOAuthRouter(svc));
  return app;
}

const BASE = 'http://localhost/api/auth/org-oauth';

// ── /:orgSlug/authorize ──────────────────────────────────────────────────────

describe('GET /:orgSlug/authorize', () => {
  it('serializes CookieSpec into a Set-Cookie header on the redirect response', async () => {
    const app = makeApp(
      stubService({
        beginAuthorize: async () => ({
          kind: 'redirect',
          location: 'https://idp/oauth?x=1',
          setCookies: [
            {
              name: STATE_COOKIE,
              value: 'signed-state',
              attrs: { maxAge: 600, httpOnly: true, secure: false, sameSite: 'Lax', path: '/' },
            },
          ],
        }),
      }),
    );

    const res = await app.fetch(new Request(`${BASE}/acme/authorize`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp/oauth?x=1');
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${STATE_COOKIE}=signed-state`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
  });

  it('maps org_not_found → 404', async () => {
    const app = makeApp(
      stubService({
        beginAuthorize: async () => ({ kind: 'failure', reason: 'org_not_found' }),
      }),
    );
    const res = await app.fetch(new Request(`${BASE}/missing/authorize`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('maps org_suspended → 403', async () => {
    const app = makeApp(
      stubService({
        beginAuthorize: async () => ({ kind: 'failure', reason: 'org_suspended' }),
      }),
    );
    const res = await app.fetch(new Request(`${BASE}/x/authorize`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization suspended' });
  });

  it('maps oidc_discovery_failed → 502', async () => {
    const app = makeApp(
      stubService({
        beginAuthorize: async () => ({ kind: 'failure', reason: 'oidc_discovery_failed' }),
      }),
    );
    const res = await app.fetch(new Request(`${BASE}/x/authorize`));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to fetch Okta configuration' });
  });

  it('forwards the next= query param to the service', async () => {
    let seenNext: string | undefined;
    const app = makeApp(
      stubService({
        beginAuthorize: async (req) => {
          seenNext = req.next;
          return { kind: 'failure', reason: 'org_not_found' };
        },
      }),
    );
    await app.fetch(new Request(`${BASE}/acme/authorize?next=%2Fdashboard`));
    expect(seenNext).toBe('/dashboard');
  });
});

// ── /callback ────────────────────────────────────────────────────────────────

describe('on(GET|POST) /callback', () => {
  it('dispatches GET query params to the service', async () => {
    let seen: { code?: string; state?: string; stateCookie?: string } | undefined;
    const app = makeApp(
      stubService({
        completeCallback: async (req) => {
          seen = { code: req.code, state: req.state, stateCookie: req.stateCookie };
          return { kind: 'failure', reason: 'invalid_state', clearCookies: [] };
        },
      }),
    );

    await app.fetch(
      new Request(`${BASE}/callback?code=abc&state=def`, {
        headers: { Cookie: `${STATE_COOKIE}=cookie-val` },
      }),
    );

    expect(seen?.code).toBe('abc');
    expect(seen?.state).toBe('def');
    expect(seen?.stateCookie).toBe('cookie-val');
  });

  it('dispatches POST form bodies to the service', async () => {
    let seen: { code?: string; state?: string } | undefined;
    const app = makeApp(
      stubService({
        completeCallback: async (req) => {
          seen = { code: req.code, state: req.state };
          return { kind: 'failure', reason: 'invalid_state', clearCookies: [] };
        },
      }),
    );

    await app.fetch(
      new Request(`${BASE}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'code=postcode&state=poststate',
      }),
    );

    expect(seen?.code).toBe('postcode');
    expect(seen?.state).toBe('poststate');
  });

  it('redirects to /?error=<reason> on failure', async () => {
    const app = makeApp(
      stubService({
        completeCallback: async () => ({
          kind: 'failure',
          reason: 'access_revoked',
          clearCookies: [
            {
              name: STATE_COOKIE,
              value: '',
              attrs: { maxAge: 0, httpOnly: true, secure: false, sameSite: 'Lax', path: '/' },
            },
          ],
        }),
      }),
    );

    const res = await app.fetch(new Request(`${BASE}/callback?code=c&state=s`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?error=access_revoked');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('redirects to next + sets all cookies on the success path', async () => {
    const app = makeApp(
      stubService({
        completeCallback: async () => ({
          kind: 'redirect',
          location: '/landing',
          setCookies: [
            {
              name: 'better-auth.session_token',
              value: 'signed-token',
              attrs: { maxAge: 604800, httpOnly: true, secure: false, sameSite: 'Lax', path: '/' },
            },
            {
              name: STATE_COOKIE,
              value: '',
              attrs: { maxAge: 0, httpOnly: true, secure: false, sameSite: 'Lax', path: '/' },
            },
          ],
        }),
      }),
    );

    const res = await app.fetch(new Request(`${BASE}/callback?code=c&state=s`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/landing');
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('better-auth.session_token=signed-token');
    expect(setCookie).toContain(`${STATE_COOKIE}=`);
  });
});

// ── /:orgSlug/meta ───────────────────────────────────────────────────────────

describe('GET /:orgSlug/meta', () => {
  it('returns the org meta on success', async () => {
    const app = makeApp(
      stubService({
        getOrgMeta: async () => ({
          kind: 'ok',
          org: { name: 'Acme', slug: 'acme', status: 'active' },
        }),
      }),
    );

    const res = await app.fetch(new Request(`${BASE}/acme/meta`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      org: { name: 'Acme', slug: 'acme', status: 'active' },
    });
  });

  it('maps org_not_found → 404', async () => {
    const app = makeApp(stubService());
    const res = await app.fetch(new Request(`${BASE}/missing/meta`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });
});
