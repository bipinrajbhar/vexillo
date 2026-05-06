import { describe, it, expect } from 'bun:test';
import { signCookieValue, verifyCookieValue } from './cookie-signing';

const SECRET = 'test-secret-for-cookie-signing-32ch!';

describe('signCookieValue / verifyCookieValue', () => {
  it('round-trips a plain ASCII value', async () => {
    const signed = await signCookieValue('hello', SECRET);
    expect(await verifyCookieValue(decodeURIComponent(signed), SECRET)).toBe('hello');
  });

  it('round-trips a JSON payload', async () => {
    const payload = JSON.stringify({ nonce: 'abc', orgSlug: 'acme', next: '/x' });
    const signed = await signCookieValue(payload, SECRET);
    expect(await verifyCookieValue(decodeURIComponent(signed), SECRET)).toBe(payload);
  });

  it('rejects a tampered value', async () => {
    const signed = await signCookieValue('hello', SECRET);
    const decoded = decodeURIComponent(signed);
    // Flip the value, keep the signature.
    const lastDot = decoded.lastIndexOf('.');
    const tampered = `tampered.${decoded.slice(lastDot + 1)}`;
    expect(await verifyCookieValue(tampered, SECRET)).toBeNull();
  });

  it('rejects a value signed with a different secret', async () => {
    const signed = await signCookieValue('hello', SECRET);
    expect(await verifyCookieValue(decodeURIComponent(signed), 'other-secret')).toBeNull();
  });

  it('rejects a value with no signature delimiter', async () => {
    expect(await verifyCookieValue('no-dot-here', SECRET)).toBeNull();
  });

  it('rejects a malformed signature length', async () => {
    expect(await verifyCookieValue('hello.tooshort=', SECRET)).toBeNull();
  });
});
