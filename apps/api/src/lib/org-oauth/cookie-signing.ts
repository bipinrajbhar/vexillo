/**
 * HMAC-SHA256 cookie signing in better-call's `serializeSignedCookie` format,
 * so cookies set here are accepted by BetterAuth's `getSignedCookie`.
 *
 * Wire format:
 *   Set-Cookie value:  encodeURIComponent(`${value}.${base64(HMAC-SHA256(value, secret))}`)
 *   Reading back:      browser URL-decodes; better-call's parseCookies calls
 *                      decodeURIComponent on each value, then getSignedCookie
 *                      splits on the last `.` and re-verifies.
 */

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
export async function signCookieValue(value: string, secret: string): Promise<string> {
  const signature = await makeSignature(value, secret);
  return encodeURIComponent(`${value}.${signature}`);
}

/**
 * Verifies a cookie value that has already been URL-decoded by the cookie
 * parser. Returns the original `value` (before the trailing `.signature`) on
 * success, or null on any verification failure.
 */
export async function verifyCookieValue(
  decoded: string,
  secret: string,
): Promise<string | null> {
  const lastDot = decoded.lastIndexOf('.');
  if (lastDot < 1) return null;
  const value = decoded.slice(0, lastDot);
  const signature = decoded.slice(lastDot + 1);
  // HMAC-SHA256 produces 32 bytes → 44-char base64 ending in '='
  if (signature.length !== 44 || !signature.endsWith('=')) return null;
  const expected = await makeSignature(value, secret);
  return expected === signature ? value : null;
}
