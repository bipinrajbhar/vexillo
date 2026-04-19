import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createRegionFanout, parseSecondaryUrls } from './region-fanout';

describe('createRegionFanout', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns a no-op when no secondary URLs are configured', () => {
    const mockFetch = mock(async () => new Response());
    globalThis.fetch = mockFetch;

    const fanout = createRegionFanout([], 'secret');
    fanout('env-1', '{"flags":[]}');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs to /internal/flag-change on each secondary URL', async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    globalThis.fetch = async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: url.toString(), options: options ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const fanout = createRegionFanout(['https://eu.example.com', 'https://ap.example.com'], 'my-secret');
    fanout('env-1', '{"flags":[]}');

    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://eu.example.com/internal/flag-change');
    expect(calls[1].url).toBe('https://ap.example.com/internal/flag-change');
  });

  it('sends the correct method, headers, and body', async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    globalThis.fetch = async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: url.toString(), options: options ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const fanout = createRegionFanout(['https://eu.example.com'], 'super-secret');
    fanout('env-42', '{"flags":[{"key":"f","enabled":true}]}');

    await new Promise((r) => setTimeout(r, 0));

    const { options } = calls[0];
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>)['X-Internal-Secret']).toBe('super-secret');
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body as string)).toEqual({
      envId: 'env-42',
      payload: '{"flags":[{"key":"f","enabled":true}]}',
    });
  });

  it('does not throw when a secondary region is unreachable (fire-and-forget)', () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const fanout = createRegionFanout(['https://eu.example.com'], 'secret');

    expect(() => fanout('env-1', '{}')).not.toThrow();
  });
});

describe('parseSecondaryUrls', () => {
  it('returns empty array for undefined', () => {
    expect(parseSecondaryUrls(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseSecondaryUrls('')).toEqual([]);
  });

  it('parses a single URL', () => {
    expect(parseSecondaryUrls('https://eu.example.com')).toEqual(['https://eu.example.com']);
  });

  it('parses multiple comma-separated URLs', () => {
    expect(parseSecondaryUrls('https://eu.example.com,https://ap.example.com')).toEqual([
      'https://eu.example.com',
      'https://ap.example.com',
    ]);
  });

  it('trims whitespace around URLs', () => {
    expect(parseSecondaryUrls(' https://eu.example.com , https://ap.example.com ')).toEqual([
      'https://eu.example.com',
      'https://ap.example.com',
    ]);
  });
});
