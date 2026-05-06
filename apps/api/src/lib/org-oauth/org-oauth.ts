import { queryOrgBySlug } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import type { Auth } from '../auth';
import { decryptSecret } from '../okta-crypto';
import {
  computeCodeChallenge,
  generateCodeVerifier,
} from './pkce';
import { signCookieValue, verifyCookieValue } from './cookie-signing';
import {
  exchangeCode,
  fetchOIDCDiscovery,
  fetchUserInfo,
  type OIDCDiscovery,
} from './okta-http';
import { createJitProvisioner, type JitProvisioner } from './jit-provisioner';
import {
  STATE_COOKIE,
  type AuthorizeRequest,
  type AuthorizeResult,
  type CallbackRequest,
  type CallbackResult,
  type CookieSpec,
  type MetaResult,
  type OrgOAuthService,
} from './types';

/**
 * Narrowed view over BetterAuth's `auth.$context`. The orchestration code
 * only needs four members; capturing them in this adapter keeps the rest of
 * the BetterAuth surface out of the test boundary.
 */
type AuthCtxAdapter = {
  secret: string;
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  createUser(input: { email: string; name: string }): Promise<{ id: string }>;
  createSession(userId: string): Promise<{ token: string }>;
  sessionCookie: {
    name: string;
    attrs: {
      secure?: boolean | null;
      sameSite?: string | boolean | null;
      maxAge?: number | null;
    };
  };
};

async function resolveAuthCtx(auth: Auth): Promise<AuthCtxAdapter> {
  const ctx = await auth.$context;
  return {
    secret: ctx.secret,
    findUserByEmail: async (email) => {
      const found = await ctx.internalAdapter.findUserByEmail(email);
      return found ? { id: found.user.id } : null;
    },
    createUser: async (input) => {
      const created = await ctx.internalAdapter.createUser({
        email: input.email,
        name: input.name,
        emailVerified: true,
      });
      return { id: created.id };
    },
    createSession: async (userId) => {
      const session = await ctx.internalAdapter.createSession(userId);
      return { token: session.token };
    },
    sessionCookie: {
      name: ctx.authCookies.sessionToken.name,
      attrs: ctx.authCookies.sessionToken.attributes,
    },
  };
}

type OAuthState = {
  nonce: string;
  orgSlug: string;
  next: string;
  codeVerifier: string;
};

const STATE_TTL_SECONDS = 600; // 10 minutes
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

// OIDC discovery cache. Issuer endpoints are stable for an issuer URL — they
// only change when an Okta admin reconfigures the auth server. The TTL absorbs
// the two-call sign-in flow (authorize + callback within STATE_TTL_SECONDS)
// while keeping genuine reconfigurations bounded to one hour.
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
// On a fetch failure, prefer serving a stale-but-recent entry over failing
// closed mid-sign-in. A 30-second Okta blip otherwise kills every in-flight
// auth.
const DISCOVERY_STALE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Wall clock — injected so TTL/grace can be advanced explicitly in tests. */
export interface Clock {
  now(): number;
}

export type OrgOAuthDeps = {
  db: DbClient;
  auth: Auth;
  baseUrl: string;
  superAdminEmails: string;

  // Optional seams — swap in tests for determinism. Production resolves to the
  // platform defaults at construction time.
  fetch?: typeof fetch;
  randomUUID?: () => string;
  randomBytes?: (n: number) => Uint8Array;
  jitProvisioner?: JitProvisioner;
  clock?: Clock;
};

interface DiscoveryCacheEntry {
  discovery: OIDCDiscovery;
  fetchedAt: number;
}

export function createOrgOAuth(deps: OrgOAuthDeps): OrgOAuthService {
  const {
    db,
    auth,
    baseUrl,
    fetch: fetchImpl = fetch,
    randomUUID = () => crypto.randomUUID(),
    randomBytes,
  } = deps;

  const isSecure = baseUrl.startsWith('https');
  const callbackUrl = `${baseUrl}/api/auth/org-oauth/callback`;
  const superAdminEmails = parseSuperAdminEmails(deps.superAdminEmails);
  const provisioner = deps.jitProvisioner ?? createJitProvisioner({ db });
  const clock: Clock = deps.clock ?? { now: () => Date.now() };

  const discoveryCache = new Map<string, DiscoveryCacheEntry>();

  function clearStateCookie(): CookieSpec {
    return {
      name: STATE_COOKIE,
      value: '',
      attrs: {
        maxAge: 0,
        httpOnly: true,
        secure: isSecure,
        sameSite: 'Lax',
        path: '/',
      },
    };
  }

  async function loadDiscovery(issuer: string): Promise<OIDCDiscovery | null> {
    const now = clock.now();
    const cached = discoveryCache.get(issuer);

    if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) {
      return cached.discovery;
    }

    try {
      const fresh = await fetchOIDCDiscovery(issuer, fetchImpl);
      discoveryCache.set(issuer, { discovery: fresh, fetchedAt: now });
      return fresh;
    } catch {
      // Serve stale within the grace window rather than failing closed in the
      // middle of a sign-in. A discovery doc that worked recently almost
      // certainly still points at valid Okta endpoints; if it doesn't, the
      // failure surfaces downstream as token_exchange_failed (a clearer
      // signal than oidc_discovery_failed for the user mid-flow).
      if (cached && now - cached.fetchedAt < DISCOVERY_STALE_GRACE_MS) {
        return cached.discovery;
      }
      return null;
    }
  }

  function invalidateIssuer(issuer: string): void {
    discoveryCache.delete(issuer);
  }

  return {
    async beginAuthorize({ orgSlug, next }: AuthorizeRequest): Promise<AuthorizeResult> {
      const org = await queryOrgBySlug(db, orgSlug);
      if (!org) return { kind: 'failure', reason: 'org_not_found' };
      if (org.status === 'suspended') return { kind: 'failure', reason: 'org_suspended' };

      const discovery = await loadDiscovery(org.oktaIssuer);
      if (!discovery) return { kind: 'failure', reason: 'oidc_discovery_failed' };

      const codeVerifier = generateCodeVerifier(randomBytes);
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const nonce = randomUUID();

      const ctx = await resolveAuthCtx(auth);
      const statePayload: OAuthState = { nonce, orgSlug, next, codeVerifier };
      const signedState = await signCookieValue(JSON.stringify(statePayload), ctx.secret);

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set('client_id', org.oktaClientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('response_mode', 'query'); // force GET redirect
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('redirect_uri', callbackUrl);
      authUrl.searchParams.set('state', nonce);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      return {
        kind: 'redirect',
        location: authUrl.toString(),
        setCookies: [
          {
            name: STATE_COOKIE,
            value: signedState,
            attrs: {
              maxAge: STATE_TTL_SECONDS,
              httpOnly: true,
              secure: isSecure,
              sameSite: 'Lax',
              path: '/',
            },
          },
        ],
      };
    },

    async completeCallback(req: CallbackRequest): Promise<CallbackResult> {
      const fail = (reason: CallbackResult & { kind: 'failure' }): CallbackResult => ({
        kind: 'failure',
        reason: reason.reason,
        clearCookies: [clearStateCookie()],
      });

      if (req.error) return fail({ kind: 'failure', reason: 'idp_error', clearCookies: [] });
      if (!req.code || !req.state) {
        return fail({ kind: 'failure', reason: 'invalid_callback', clearCookies: [] });
      }
      if (!req.stateCookie) {
        return fail({ kind: 'failure', reason: 'state_missing', clearCookies: [] });
      }

      const ctx = await resolveAuthCtx(auth);
      const stateJson = await verifyCookieValue(req.stateCookie, ctx.secret);
      if (!stateJson) {
        return fail({ kind: 'failure', reason: 'invalid_state', clearCookies: [] });
      }

      let parsed: OAuthState;
      try {
        parsed = JSON.parse(stateJson) as OAuthState;
      } catch {
        return fail({ kind: 'failure', reason: 'invalid_state', clearCookies: [] });
      }

      if (req.state !== parsed.nonce) {
        return fail({ kind: 'failure', reason: 'state_mismatch', clearCookies: [] });
      }

      const org = await queryOrgBySlug(db, parsed.orgSlug);
      if (!org) return fail({ kind: 'failure', reason: 'org_not_found', clearCookies: [] });
      if (org.status === 'suspended') {
        return fail({ kind: 'failure', reason: 'org_suspended', clearCookies: [] });
      }

      const discovery = await loadDiscovery(org.oktaIssuer);
      if (!discovery) {
        return fail({ kind: 'failure', reason: 'oidc_discovery_failed', clearCookies: [] });
      }

      let oktaClientSecret: string;
      try {
        oktaClientSecret = await decryptSecret(org.oktaClientSecret);
      } catch {
        return fail({ kind: 'failure', reason: 'okta_config_error', clearCookies: [] });
      }

      const tokens = await exchangeCode(
        {
          clientId: org.oktaClientId,
          clientSecret: oktaClientSecret,
          code: req.code,
          codeVerifier: parsed.codeVerifier,
          redirectUri: callbackUrl,
          tokenEndpoint: discovery.token_endpoint,
        },
        fetchImpl,
      );
      if (!tokens) {
        return fail({ kind: 'failure', reason: 'token_exchange_failed', clearCookies: [] });
      }

      const userInfo = await fetchUserInfo(
        discovery.userinfo_endpoint,
        tokens.access_token,
        fetchImpl,
      );
      if (!userInfo?.email) {
        return fail({ kind: 'failure', reason: 'no_email', clearCookies: [] });
      }

      const email = userInfo.email;
      const existing = await ctx.findUserByEmail(email);
      const userId = existing
        ? existing.id
        : (await ctx.createUser({ email, name: deriveName(userInfo) })).id;

      const provisionResult = await provisioner.provision({
        org: { id: org.id },
        identity: { userId, email },
        superAdminEmails,
      });

      if (!provisionResult.ok) {
        return fail({
          kind: 'failure',
          reason: provisionResult.reason,
          clearCookies: [],
        });
      }

      const session = await ctx.createSession(userId);
      const signedToken = await signCookieValue(session.token, ctx.secret);

      const sessionAttrs = ctx.sessionCookie.attrs;
      const sessionMaxAge =
        typeof sessionAttrs.maxAge === 'number' ? sessionAttrs.maxAge : DEFAULT_SESSION_TTL_SECONDS;

      return {
        kind: 'redirect',
        location: parsed.next || '/',
        setCookies: [
          {
            name: ctx.sessionCookie.name,
            value: signedToken,
            attrs: {
              maxAge: sessionMaxAge,
              httpOnly: true,
              secure: isSecure || sessionAttrs.secure === true,
              sameSite: normalizeSameSite(sessionAttrs.sameSite),
              path: '/',
            },
          },
          clearStateCookie(),
        ],
      };
    },

    async getOrgMeta(orgSlug): Promise<MetaResult> {
      const org = await queryOrgBySlug(db, orgSlug);
      if (!org) return { kind: 'failure', reason: 'org_not_found' };
      return {
        kind: 'ok',
        org: { name: org.name, slug: org.slug, status: org.status },
      };
    },

    invalidateIssuer,
  };
}

function parseSuperAdminEmails(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function deriveName(userInfo: {
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
}): string {
  if (userInfo.name) return userInfo.name;
  const composed = `${userInfo.given_name ?? ''} ${userInfo.family_name ?? ''}`.trim();
  if (composed) return composed;
  return userInfo.email ?? 'Unknown';
}

function normalizeSameSite(v: string | boolean | null | undefined): 'Lax' | 'Strict' | 'None' {
  if (typeof v !== 'string') return 'Lax';
  const lower = v.toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'none') return 'None';
  return 'Lax';
}
