import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { organizations } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import type { Auth } from '../lib/auth';

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function computeCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ── Cookie signing — matches better-call's serializeSignedCookie format ───────
//
// Set-Cookie value:  encodeURIComponent(`${value}.${base64(HMAC-SHA256(value, secret))}`)
// Reading back:      Cookie header is decoded by the browser;
//                    better-call's parseCookies calls decodeURIComponent on each value,
//                    then getSignedCookie splits on the last `.` and re-verifies.

async function makeSignature(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Produces the encoded cookie value, compatible with better-call's setSignedCookie. */
async function signCookieValue(value: string, secret: string): Promise<string> {
  const signature = await makeSignature(value, secret);
  return encodeURIComponent(`${value}.${signature}`);
}

/**
 * Verifies a cookie value that was already URL-decoded by the cookie parser.
 * Returns the original `value` (before the trailing `.signature`) on success, or null on failure.
 */
async function verifyCookieValue(decoded: string, secret: string): Promise<string | null> {
  const lastDot = decoded.lastIndexOf('.');
  if (lastDot < 1) return null;
  const value = decoded.slice(0, lastDot);
  const signature = decoded.slice(lastDot + 1);
  // HMAC-SHA256 produces 32 bytes → 44-char base64 ending in '='
  if (signature.length !== 44 || !signature.endsWith('=')) return null;
  const expected = await makeSignature(value, secret);
  return expected === signature ? value : null;
}

// ── OIDC discovery ────────────────────────────────────────────────────────────

type OIDCDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

export async function fetchOIDCDiscovery(issuer: string): Promise<OIDCDiscovery> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${res.status}`);
  return res.json() as Promise<OIDCDiscovery>;
}

// ── Token exchange ────────────────────────────────────────────────────────────

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  id_token?: string;
};

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  tokenEndpoint: string,
): Promise<TokenResponse | null> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return null;
  return res.json() as Promise<TokenResponse>;
}

// ── Userinfo ──────────────────────────────────────────────────────────────────

type OktaUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
};

export async function fetchUserInfo(
  userInfoEndpoint: string,
  accessToken: string,
): Promise<OktaUserInfo | null> {
  const res = await fetch(userInfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json() as Promise<OktaUserInfo>;
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

const STATE_COOKIE = 'org_oauth_state';

function buildCookieHeader(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly?: boolean; secure?: boolean; sameSite?: string; path?: string },
): string {
  const { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = opts;
  let h = `${name}=${value}; Path=${path}; Max-Age=${maxAge}`;
  if (httpOnly) h += '; HttpOnly';
  if (secure) h += '; Secure';
  if (sameSite) h += `; SameSite=${sameSite}`;
  return h;
}

// ── State payload stored in the signed cookie ────────────────────────────────

type OAuthState = {
  nonce: string;
  orgSlug: string;
  next: string;
  codeVerifier: string;
};

// ── Router ────────────────────────────────────────────────────────────────────

export function createOrgOAuthRouter(db: DbClient, auth: Auth) {
  const router = new Hono();

  /**
   * GET /api/auth/org-oauth/:orgSlug/authorize?next=<url>
   *
   * Initiates a PKCE authorization code flow against the organization's own
   * Okta tenant.  Stores `{nonce, orgSlug, next, codeVerifier}` in a
   * short-lived, HMAC-signed cookie and redirects the browser to Okta.
   */
  router.get('/:orgSlug/authorize', async (c) => {
    const orgSlug = c.req.param('orgSlug');
    const next = c.req.query('next') ?? '/';

    // Resolve org
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1);

    if (!org) return c.json({ error: 'Organization not found' }, 404);
    if (org.status === 'suspended') return c.json({ error: 'Organization suspended' }, 403);

    // OIDC discovery
    let discovery: OIDCDiscovery;
    try {
      discovery = await fetchOIDCDiscovery(org.oktaIssuer);
    } catch {
      return c.json({ error: 'Failed to fetch Okta configuration' }, 502);
    }

    // PKCE
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);

    // Nonce for CSRF protection
    const nonce = crypto.randomUUID();

    // Sign and store the full OAuth state in a short-lived cookie
    const ctx = await auth.$context;
    const statePayload: OAuthState = { nonce, orgSlug, next, codeVerifier };
    const signedState = await signCookieValue(JSON.stringify(statePayload), ctx.secret);

    // Callback URL (Okta redirects here after sign-in)
    const baseUrl = process.env.BETTER_AUTH_URL!;
    const callbackUrl = `${baseUrl}/api/auth/org-oauth/callback`;

    // Build Okta authorization URL
    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('client_id', org.oktaClientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('response_mode', 'query'); // force GET redirect, not form_post
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('state', nonce);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const isSecure = baseUrl.startsWith('https');
    const stateCookieHeader = buildCookieHeader(STATE_COOKIE, signedState, {
      maxAge: 600, // 10 minutes
      httpOnly: true,
      secure: isSecure,
      sameSite: 'Lax',
    });

    const headers = new Headers({
      'Location': authUrl.toString(),
      'Set-Cookie': stateCookieHeader,
    });
    return new Response(null, { status: 302, headers });
  });

  /**
   * GET /api/auth/org-oauth/callback?code=&state=
   *
   * Handles the Okta redirect.  Verifies the CSRF nonce from the state cookie,
   * exchanges the authorization code for tokens, upserts the user in
   * BetterAuth's DB, creates a BetterAuth session, and sets the signed
   * `better-auth.session_token` cookie before redirecting the browser to `next`.
   */
  router.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state'); // the nonce we sent
    const error = c.req.query('error');

    const fail = (msg: string) =>
      new Response(null, { status: 302, headers: { Location: `/?error=${encodeURIComponent(msg)}` } });

    if (error) return fail(error);
    if (!code || !state) return fail('invalid_callback');

    // Verify signed state cookie
    const rawCookie = getCookie(c, STATE_COOKIE);
    if (!rawCookie) return fail('state_missing');

    const ctx = await auth.$context;
    const stateJson = await verifyCookieValue(rawCookie, ctx.secret);
    if (!stateJson) return fail('invalid_state');

    let parsed: OAuthState;
    try {
      parsed = JSON.parse(stateJson) as OAuthState;
    } catch {
      return fail('invalid_state');
    }

    if (state !== parsed.nonce) return fail('state_mismatch');

    // Consume state cookie (clear it)
    const clearStateCookie = buildCookieHeader(STATE_COOKIE, '', { maxAge: 0 });

    // Resolve org
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, parsed.orgSlug))
      .limit(1);

    if (!org) return fail('org_not_found');
    if (org.status === 'suspended') return fail('org_suspended');

    // OIDC discovery
    let discovery: OIDCDiscovery;
    try {
      discovery = await fetchOIDCDiscovery(org.oktaIssuer);
    } catch {
      return fail('oidc_discovery_failed');
    }

    // Exchange authorization code for tokens
    const baseUrl = process.env.BETTER_AUTH_URL!;
    const callbackUrl = `${baseUrl}/api/auth/org-oauth/callback`;

    const tokens = await exchangeCode(
      org.oktaClientId,
      org.oktaClientSecret,
      code,
      parsed.codeVerifier,
      callbackUrl,
      discovery.token_endpoint,
    );
    if (!tokens) return fail('token_exchange_failed');

    // Get user info from Okta
    const userInfo = await fetchUserInfo(discovery.userinfo_endpoint, tokens.access_token);
    if (!userInfo?.email) return fail('no_email');

    // Upsert user in BetterAuth's DB
    const existing = await ctx.internalAdapter.findUserByEmail(userInfo.email);
    let userId: string;

    if (existing) {
      userId = existing.user.id;
    } else {
      const name =
        userInfo.name ??
        (userInfo.given_name || userInfo.family_name
          ? `${userInfo.given_name ?? ''} ${userInfo.family_name ?? ''}`.trim()
          : userInfo.email);
      const newUser = await ctx.internalAdapter.createUser({
        email: userInfo.email,
        name,
        emailVerified: true,
      });
      userId = newUser.id;
    }

    // Create BetterAuth session
    const session = await ctx.internalAdapter.createSession(userId);

    // Build the signed session cookie in the exact format that better-call's
    // getSignedCookie / BetterAuth's getSession expects.
    const signedToken = await signCookieValue(session.token, ctx.secret);
    const cookieName = ctx.authCookies.sessionToken.name;
    const cookieAttrs = ctx.authCookies.sessionToken.attributes;
    const maxAge = typeof cookieAttrs.maxAge === 'number' ? cookieAttrs.maxAge : 60 * 60 * 24 * 7;
    const isSecure = baseUrl.startsWith('https');

    const sessionCookieHeader = buildCookieHeader(cookieName, signedToken, {
      maxAge,
      httpOnly: true,
      secure: isSecure || !!cookieAttrs.secure,
      sameSite: typeof cookieAttrs.sameSite === 'string' ? cookieAttrs.sameSite : 'Lax',
    });

    const headers = new Headers({
      Location: parsed.next || '/',
    });
    headers.append('Set-Cookie', sessionCookieHeader);
    headers.append('Set-Cookie', clearStateCookie);
    return new Response(null, { status: 302, headers });
  });

  /**
   * GET /api/auth/org-oauth/:orgSlug/meta
   *
   * Public endpoint that returns the org's display name and status.
   * Used by the org-specific sign-in page to show the org name.
   */
  router.get('/:orgSlug/meta', async (c) => {
    const orgSlug = c.req.param('orgSlug');
    const [org] = await db
      .select({
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status,
      })
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1);

    if (!org) return c.json({ error: 'Organization not found' }, 404);
    return c.json({ org });
  });

  return router;
}
