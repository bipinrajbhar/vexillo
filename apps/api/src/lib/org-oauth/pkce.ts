/**
 * RFC 7636 PKCE helpers. The verifier is a 32-byte random URL-safe base64
 * string; the challenge is base64url(SHA-256(verifier)). Tests inject
 * `randomBytes` for deterministic verifier values.
 */

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function generateCodeVerifier(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  return base64url(randomBytes(32));
}

export async function computeCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}
