/**
 * Public surface of the OrgOAuth module: tagged-union results returned by the
 * three service methods, plus the wire-shaped CookieSpec the route uses to
 * build Set-Cookie headers. The route owns header serialization; this module
 * never imports Hono, Request, or Response.
 */

export type CookieSpec = {
  name: string;
  value: string;
  attrs: {
    maxAge: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax' | 'Strict' | 'None';
    path: string;
  };
};

export type AuthorizeFailureReason =
  | 'org_not_found'
  | 'org_suspended'
  | 'oidc_discovery_failed';

export type CallbackFailureReason =
  | 'idp_error'
  | 'invalid_callback'
  | 'state_missing'
  | 'invalid_state'
  | 'state_mismatch'
  | 'org_not_found'
  | 'org_suspended'
  | 'oidc_discovery_failed'
  | 'okta_config_error'
  | 'token_exchange_failed'
  | 'no_email'
  | 'access_revoked';

export type AuthorizeRequest = { orgSlug: string; next: string };

export type AuthorizeResult =
  | { kind: 'redirect'; location: string; setCookies: CookieSpec[] }
  | { kind: 'failure'; reason: AuthorizeFailureReason };

export type CallbackRequest = {
  code?: string;
  state?: string;
  error?: string;
  stateCookie?: string;
};

export type CallbackResult =
  | { kind: 'redirect'; location: string; setCookies: CookieSpec[] }
  | { kind: 'failure'; reason: CallbackFailureReason; clearCookies: CookieSpec[] };

export type OrgMeta = { name: string; slug: string; status: string };

export type MetaResult =
  | { kind: 'ok'; org: OrgMeta }
  | { kind: 'failure'; reason: 'org_not_found' };

export interface OrgOAuthService {
  beginAuthorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
  completeCallback(req: CallbackRequest): Promise<CallbackResult>;
  getOrgMeta(orgSlug: string): Promise<MetaResult>;
}

export const STATE_COOKIE = 'org_oauth_state';
