import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { Scalar } from '@scalar/hono-api-reference';
import { createSdkRouter, SDK_OPENAPI_CONFIG } from './sdk';

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

// Convenience: a valid merged auth row for env-1 / org-1.
function authRow(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: 'env-1',
    orgId: 'org-1',
    allowedOrigins: [],
    orgStatus: 'active',
    ...overrides,
  };
}

function makeApp(db: Parameters<typeof createSdkRouter>[0]) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/api/sdk', createSdkRouter(db));
  return app;
}

function makeDocsApp(db: Parameters<typeof createSdkRouter>[0]) {
  const sdkRouter = createSdkRouter(db);
  const app = new Hono();
  app.route('/api/sdk', sdkRouter);
  app.get('/openapi.json', (c) => c.json(sdkRouter.getOpenAPIDocument(SDK_OPENAPI_CONFIG)));
  app.get('/api/docs', Scalar({ url: '/api/openapi.json' }));
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
    // Merged auth query returns empty array → 401
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

  it('returns 401 when API key or environment is not found', async () => {
    // Merged auth query (apiKey JOIN env JOIN org) returns empty when any
    // part of the chain is missing — indistinguishable at the query level.
    const db = makeSdkQueueDb([
      [], // merged auth query → not found
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 403 when the organization is suspended', async () => {
    const db = makeSdkQueueDb([
      [authRow({ orgStatus: 'suspended' })], // merged auth query
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
      [authRow()],                                                                          // merged auth
      [{ key: 'feature-a', enabled: true }, { key: 'feature-b', enabled: false }],        // flags
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
      [authRow()], // merged auth
      [],          // flags (empty)
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
      [authRow()], // merged auth, allowedOrigins: []
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
      [authRow({ allowedOrigins: ['https://allowed.com'] })], // merged auth
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
      [authRow({ allowedOrigins: ['https://myapp.com'] })], // merged auth
      [],                                                    // flags
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
      [authRow({ allowedOrigins: ['*'] })], // merged auth
      [],                                   // flags
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

  // ── Country targeting (CloudFront-Viewer-Country header) ───────────────────

  it('returns enabled: true for a country in allowedCountries', async () => {
    const db = makeSdkQueueDb([
      [authRow()],
      [{ key: 'geo-flag', enabled: false, allowedCountries: ['US', 'CA'] }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-key', 'CloudFront-Viewer-Country': 'US' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { flags: Array<{ key: string; enabled: boolean }> };
    expect(body.flags).toEqual([{ key: 'geo-flag', enabled: true }]);
  });

  it('returns enabled: false for a country not in allowedCountries', async () => {
    const db = makeSdkQueueDb([
      [authRow()],
      [{ key: 'geo-flag', enabled: true, allowedCountries: ['US'] }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-key', 'CloudFront-Viewer-Country': 'DE' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { flags: Array<{ key: string; enabled: boolean }> };
    expect(body.flags).toEqual([{ key: 'geo-flag', enabled: false }]);
  });

  it('falls back to envEnabled when CloudFront-Viewer-Country header is absent', async () => {
    const db = makeSdkQueueDb([
      [authRow()],
      [{ key: 'geo-flag', enabled: true, allowedCountries: ['US'] }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-key' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { flags: Array<{ key: string; enabled: boolean }> };
    expect(body.flags).toEqual([{ key: 'geo-flag', enabled: true }]);
  });

  it('returns envEnabled when no country rules are configured (empty allowedCountries)', async () => {
    const db = makeSdkQueueDb([
      [authRow()],
      [{ key: 'plain-flag', enabled: false, allowedCountries: [] }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-key', 'CloudFront-Viewer-Country': 'US' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { flags: Array<{ key: string; enabled: boolean }> };
    expect(body.flags).toEqual([{ key: 'plain-flag', enabled: false }]);
  });

  // ── In-process flag cache ───────────────────────────────────────────────────

  it('serves flags from in-process cache on subsequent requests for the same environment', async () => {
    const db = makeSdkQueueDb([
      [authRow()],                               // request 1: merged auth
      [{ key: 'feature-a', enabled: true }],    // request 1: flags DB hit (populates cache)
      [authRow()],                               // request 2: merged auth
      // no flags entry — if cache is bypassed, queue returns [] and assertion fails
    ]);
    const app = makeApp(db);

    const makeReq = () =>
      app.fetch(new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-key' },
      }));

    const res1 = await makeReq();
    expect(res1.status).toBe(200);
    expect((await res1.json() as { flags: unknown[] }).flags).toEqual([
      { key: 'feature-a', enabled: true },
    ]);

    const res2 = await makeReq();
    expect(res2.status).toBe(200);
    expect((await res2.json() as { flags: unknown[] }).flags).toEqual([
      { key: 'feature-a', enabled: true },
    ]);
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
  it('returns 401 when Authorization header is missing', async () => {
    const app = makeApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/api/sdk/flags/stream'));
    expect(res.status).toBe(401);
  });

  it('returns 401 when Bearer token is not found in DB', async () => {
    const app = makeApp(makeMockDb());
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: { Authorization: 'Bearer unknown-key' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when organization is suspended', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1', orgId: 'org-1', allowedOrigins: [], orgStatus: 'suspended' }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when Origin is not in allowedOrigins', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1', orgId: 'org-1', allowedOrigins: ['https://allowed.com'], orgStatus: 'active' }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          Origin: 'https://notallowed.com',
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns SSE stream with initial flag snapshot on valid auth', async () => {
    const db = makeSdkQueueDb([
      [{ environmentId: 'env-1', orgId: 'org-1', allowedOrigins: [], orgStatus: 'active' }],
      [{ key: 'feat-a', enabled: true }, { key: 'feat-b', enabled: false }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(dataLine.slice(6)) as {
      flags: Array<{ key: string; enabled: boolean }>;
    };
    expect(payload.flags).toEqual([
      { key: 'feat-a', enabled: true },
      { key: 'feat-b', enabled: false },
    ]);
    await reader.cancel();
  });

  it('applies geo evaluation to initial snapshot when CloudFront-Viewer-Country header is present', async () => {
    const db = makeSdkQueueDb([
      [authRow()],
      [{ key: 'geo-flag', enabled: false, allowedCountries: ['US', 'CA'] }],
    ]);
    const app = makeApp(db);
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          'CloudFront-Viewer-Country': 'US',
        },
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(dataLine.slice(6)) as {
      flags: Array<{ key: string; enabled: boolean }>;
    };
    expect(payload.flags).toEqual([{ key: 'geo-flag', enabled: true }]);
    await reader.cancel();
  });

  it('applies per-connection geo evaluation when streamRegistry broadcasts a country-rules update', async () => {
    let capturedSend: ((payload: string) => void) | null = null;
    const mockRegistry = {
      register: (_envId: string, send: (payload: string) => void) => {
        capturedSend = send;
        return () => {};
      },
      broadcast: () => {},
    };

    const db = makeSdkQueueDb([
      [authRow()],
      [{ key: 'geo-flag', enabled: false, allowedCountries: [] }],
    ]);
    const sdkRouter = createSdkRouter(db, mockRegistry as Parameters<typeof createSdkRouter>[1]);
    const app = new Hono();
    app.get('/health', (c) => c.json({ status: 'ok' }));
    app.route('/api/sdk', sdkRouter);

    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          'CloudFront-Viewer-Country': 'US',
        },
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();

    // Consume the initial snapshot (no rules yet → geo-flag disabled)
    const { value: initVal } = await reader.read();
    const initText = new TextDecoder().decode(initVal);
    const initData = JSON.parse(initText.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as {
      flags: Array<{ key: string; enabled: boolean }>;
    };
    expect(initData.flags).toEqual([{ key: 'geo-flag', enabled: false }]);

    // Simulate a country-rules update: geo-flag now whitelists US
    capturedSend!(JSON.stringify({ flags: [{ key: 'geo-flag', enabled: false, allowedCountries: ['US'] }] }));

    // The update should be geo-evaluated: US is in the list → enabled: true
    const { value: updVal } = await reader.read();
    const updText = new TextDecoder().decode(updVal);
    const updData = JSON.parse(updText.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as {
      flags: Array<{ key: string; enabled: boolean }>;
    };
    expect(updData.flags).toEqual([{ key: 'geo-flag', enabled: true }]);

    await reader.cancel();
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

describe('GET /openapi.json', () => {
  it('returns 200 with application/json content-type', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('includes /flags path with GET method', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty('/flags');
    expect((paths['/flags'] as Record<string, unknown>)).toHaveProperty('get');
  });

  it('includes /flags/stream path with GET method', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty('/flags/stream');
    expect((paths['/flags/stream'] as Record<string, unknown>)).toHaveProperty('get');
  });

  it('includes BearerAuth security scheme in components', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const securitySchemes = (
      (spec.components as Record<string, unknown>)?.securitySchemes as Record<string, unknown>
    );
    expect(securitySchemes).toHaveProperty('BearerAuth');
    expect((securitySchemes.BearerAuth as Record<string, unknown>).type).toBe('http');
    expect((securitySchemes.BearerAuth as Record<string, unknown>).scheme).toBe('bearer');
  });

  it('/flags GET operation requires BearerAuth security', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const flagsGet = (paths['/flags'] as Record<string, unknown>).get as Record<string, unknown>;
    const security = flagsGet.security as Array<Record<string, unknown>>;
    expect(security.some((s) => 'BearerAuth' in s)).toBe(true);
  });

  it('/flags/stream GET operation requires BearerAuth security', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const streamGet = (paths['/flags/stream'] as Record<string, unknown>).get as Record<string, unknown>;
    const security = streamGet.security as Array<Record<string, unknown>>;
    expect(security.some((s) => 'BearerAuth' in s)).toBe(true);
  });

  it('/flags GET operation has 200, 401, and 403 response codes', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const responses = (
      (paths['/flags'] as Record<string, unknown>).get as Record<string, unknown>
    ).responses as Record<string, unknown>;
    expect(responses).toHaveProperty('200');
    expect(responses).toHaveProperty('401');
    expect(responses).toHaveProperty('403');
  });

  it('/flags GET has operationId getFlags', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const flagsGet = (paths['/flags'] as Record<string, unknown>).get as Record<string, unknown>;
    expect(flagsGet.operationId).toBe('getFlags');
  });

  it('/flags/stream GET has operationId getFlagsStream', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    const spec = await res.json() as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const streamGet = (
      paths['/flags/stream'] as Record<string, unknown>
    ).get as Record<string, unknown>;
    expect(streamGet.operationId).toBe('getFlagsStream');
  });
});

describe('GET /api/docs', () => {
  it('returns 200 with text/html content-type', async () => {
    const app = makeDocsApp(makeMockDb());
    const res = await app.fetch(new Request('http://localhost/api/docs'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
