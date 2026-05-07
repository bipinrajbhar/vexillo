import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  STATE_COOKIE,
  type AuthorizeFailureReason,
  type CookieSpec,
  type OrgOAuthService,
} from '../lib/org-oauth';

const AUTHZ_STATUS = {
  org_not_found: 404,
  org_suspended: 403,
  oidc_discovery_failed: 502,
} as const satisfies Record<AuthorizeFailureReason, number>;

const AUTHZ_MESSAGES: Record<AuthorizeFailureReason, string> = {
  org_not_found: 'Organization not found',
  org_suspended: 'Organization suspended',
  oidc_discovery_failed: 'Failed to fetch Okta configuration',
};

function setCookieHeader(c: CookieSpec): string {
  const a = c.attrs;
  let h = `${c.name}=${c.value}; Path=${a.path}; Max-Age=${a.maxAge}`;
  if (a.httpOnly) h += '; HttpOnly';
  if (a.secure) h += '; Secure';
  h += `; SameSite=${a.sameSite}`;
  return h;
}

function redirect(location: string, cookies: CookieSpec[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', setCookieHeader(cookie));
  return new Response(null, { status: 302, headers });
}

export function createOrgOAuthRouter(service: OrgOAuthService) {
  const router = new Hono();

  /** GET /:orgSlug/authorize?next=<url> — kicks off the PKCE flow. */
  router.get('/:orgSlug/authorize', async (c) => {
    const result = await service.beginAuthorize({
      orgSlug: c.req.param('orgSlug'),
      next: c.req.query('next') ?? '/',
    });
    if (result.kind === 'failure') {
      return c.json(
        { error: AUTHZ_MESSAGES[result.reason] },
        AUTHZ_STATUS[result.reason],
      );
    }
    return redirect(result.location, result.setCookies);
  });

  /**
   * GET|POST /callback — Okta sends params via query (`response_mode=query`)
   * or POST body (`response_mode=form_post`). We support both so either app
   * type works.
   */
  router.on(['GET', 'POST'], '/callback', async (c) => {
    const body = c.req.method === 'POST' ? await c.req.parseBody() : undefined;
    const pick = (k: string): string | undefined =>
      c.req.method === 'POST'
        ? (body?.[k] as string | undefined)
        : c.req.query(k);

    const result = await service.completeCallback({
      code: pick('code'),
      state: pick('state'),
      error: pick('error'),
      stateCookie: getCookie(c, STATE_COOKIE),
    });

    if (result.kind === 'redirect') {
      return redirect(result.location, result.setCookies);
    }
    return redirect(`/?error=${encodeURIComponent(result.reason)}`, result.clearCookies);
  });

  /** GET /:orgSlug/meta — public org name + status for the sign-in page. */
  router.get('/:orgSlug/meta', async (c) => {
    const result = await service.getOrgMeta(c.req.param('orgSlug'));
    if (result.kind === 'ok') return c.json({ org: result.org });
    return c.json({ error: 'Organization not found' }, 404);
  });

  return router;
}
