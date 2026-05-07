/**
 * Thin wrappers around the three Okta endpoints used by the OAuth flow:
 * OIDC discovery, token exchange, and userinfo. The `fetch` seam lets tests
 * stub responses without monkey-patching `globalThis.fetch`.
 */

export type OIDCDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
};

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  id_token?: string;
};

export type OktaUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
};

export async function fetchOIDCDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OIDCDiscovery> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${res.status}`);
  return res.json() as Promise<OIDCDiscovery>;
}

export async function exchangeCode(
  args: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    tokenEndpoint: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse | null> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
  });
  const res = await fetchImpl(args.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return null;
  return res.json() as Promise<TokenResponse>;
}

export async function fetchUserInfo(
  userInfoEndpoint: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OktaUserInfo | null> {
  const res = await fetchImpl(userInfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json() as Promise<OktaUserInfo>;
}
