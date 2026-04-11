import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { createSdkRouter } from './sdk';

// Minimal mock DB that satisfies the shape used by createSdkRouter.
// All queries return empty arrays — used for error-path tests.
function makeMockDb(overrides: Record<string, unknown> = {}) {
  const base = {
    select: () => base,
    from: () => base,
    where: () => base,
    limit: () => Promise.resolve([]),
    leftJoin: () => base,
    innerJoin: () => base,
    orderBy: () => Promise.resolve([]),
  };
  return { ...base, ...overrides } as unknown as Parameters<typeof createSdkRouter>[0];
}

// Queue-based mock DB for the happy-path tests that drive through multiple
// sequential DB queries. Results are consumed FIFO; `limit` and `orderBy`
// are the terminal methods used by createSdkRouter.
function makeSdkQueueDb(results: unknown[][]) {
  const queue = [...results];

  function consume(): unknown[] {
    return (queue.shift() ?? []) as unknown[];
  }

  const chain: Record<string, unknown> = {};

  // Thenable handles `await db.select()…` patterns with no explicit terminal.
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);

  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin']) {
    chain[m] = () => chain;
  }

  for (const m of ['limit', 'orderBy']) {
    chain[m] = () => Promise.resolve(consume());
  }

  return chain as unknown as Parameters<typeof createSdkRouter>[0];
}

function makeApp(db: Parameters<typeof createSdkRouter>[0]) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/api/sdk', createSdkRouter(db));
  return app;
}

// App wired up with the same secureHeaders config as index.ts
function makeSecureApp(db: Parameters<typeof createSdkRouter>[0]) {
  const app = new Hono();
  app.use(
    secureHeaders({
      xFrameOptions: 'DENY',
      referrerPolicy: 'strict-origin-when-cross-origin',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      xContentTypeOptions: true,
      xXssProtection: true,
      xDnsPrefetchControl: true,
      xDownloadOptions: true,
      xPermittedCrossDomainPolicies: true,
      originAgentCluster: true,
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/api/sdk', createSdkRouter(db));
  return app;
}

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const app = makeApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/sdk/flags', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = makeApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/api/sdk/flags'));
    expect(res.status).toBe(401);
  });

  it('returns 401 when Bearer token is not found in DB', async () => {
    // DB returns empty array for api key lookup → 401
    const app = makeApp(makeMockDb());
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-unknownkey' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns CORS headers on 401', async () => {
    const app = makeApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/api/sdk/flags'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 403 when API key is valid but environment no longer exists', async () => {
    // Queue: apiKey lookup returns a match, environment lookup returns empty.
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }], // apiKeys query
      [],                            // environments+org query → 403
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 403 when the organization is suspended', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }],                                          // apiKeys query
      [{ id: 'env-1', allowedOrigins: [], orgStatus: 'suspended' }],        // environments+org query
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 200 with flag states, CORS *, and Cache-Control on a valid key (no Origin header)', async () => {
    // No Origin header → server/script request → always allowed, CORS * returned.
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }],                                    // apiKeys
      [{ id: 'env-1', allowedOrigins: [] }],                           // environments
      [{ key: 'feature-a', enabled: true }, { key: 'feature-b', enabled: false }], // flags
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('s-maxage=30, stale-while-revalidate=60');
    const body = await res.json() as { flags: Array<{ key: string; enabled: boolean }> };
    expect(body.flags).toEqual([
      { key: 'feature-a', enabled: true },
      { key: 'feature-b', enabled: false },
    ]);
  });

  it('returns an empty flags array when no flags exist', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }],
      [{ id: 'env-1', allowedOrigins: [] }],
      [], // no flags
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { flags: unknown[] };
    expect(body.flags).toEqual([]);
  });

  // ── CORS allowlist enforcement ──────────────────────────────────────────────

  it('returns 403 when Origin is present but allowedOrigins is empty', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }],
      [{ id: 'env-1', allowedOrigins: [] }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          Origin: 'https://example.com',
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when Origin is not in the allowedOrigins list', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }],
      [{ id: 'env-1', allowedOrigins: ['https://allowed.com'] }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          Origin: 'https://notallowed.com',
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('reflects the matching origin back when it is in allowedOrigins', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }],
      [{ id: 'env-1', allowedOrigins: ['https://myapp.com'] }],
      [],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          Origin: 'https://myapp.com',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://myapp.com');
  });

  it('returns * when allowedOrigins contains the wildcard and Origin is present', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1' }],
      [{ id: 'env-1', allowedOrigins: ['*'] }],
      [],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          Origin: 'https://anyone.com',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('OPTIONS /api/sdk/flags', () => {
  it('returns 204 with CORS headers', async () => {
    const app = makeApp(makeMockDb());
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('GET /api/sdk/flags/stream', () => {
  it('returns SSE content-type', async () => {
    const app = makeApp(makeMockDb());
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream'),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // Cancel the stream immediately to avoid dangling intervals in tests
    await res.body?.cancel();
  });
});

describe('Security headers', () => {
  it('sets X-Frame-Options: DENY on all responses', async () => {
    const app = makeSecureApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('sets X-Content-Type-Options: nosniff on all responses', async () => {
    const app = makeSecureApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets Strict-Transport-Security on all responses', async () => {
    const app = makeSecureApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('sets Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const app = makeSecureApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
  });

  it('does not clobber CORS headers on SDK routes', async () => {
    const app = makeSecureApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/api/sdk/flags'));
    // SDK always emits CORS * — secureHeaders must not remove it
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // Security headers still present
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
