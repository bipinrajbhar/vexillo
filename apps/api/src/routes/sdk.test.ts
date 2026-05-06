import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { Scalar } from '@scalar/hono-api-reference';
import { createSdkRouter, SDK_OPENAPI_CONFIG } from './sdk';
import { createFlagBus, createInMemoryInterContainerBus, type FlagBus } from '../lib/flag-bus';
import type { AuthResult, SdkAuthenticator } from '../lib/sdk-authenticator';
import type { FlagSnapshotReader, FlagEvaluator } from '../lib/flag-snapshot-reader';

// ── Stubs ─────────────────────────────────────────────────────────────────────
//
// The route's only contract with its dependencies is the AuthResult discriminated
// union and the FlagSnapshotReader interface. These stubs let us exercise the
// HTTP plumbing without touching the DB or auth caches — orchestration logic
// is covered by the boundary tests in `lib/sdk-authenticator.test.ts` and
// `lib/flag-snapshot-reader.test.ts`.

function stubAuthenticator(result: AuthResult): SdkAuthenticator {
  return {
    authenticate: async () => result,
    evictByEnvironment: () => {},
  };
}

function stubReader(opts: {
  read?: (countryCode: string | null) => string;
  evaluator?: FlagEvaluator;
} = {}): FlagSnapshotReader {
  const read = opts.read ?? (() => JSON.stringify({ flags: [] }));
  const evaluator =
    opts.evaluator ?? ((countryCode, override) => override ?? read(countryCode));
  return {
    read: async (args) => read(args.countryCode),
    openEvaluator: async () => evaluator,
    invalidate: () => {},
  };
}

function makeApp(deps: {
  authenticator: SdkAuthenticator;
  snapshotReader?: FlagSnapshotReader;
  flagBus?: FlagBus;
}) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route(
    '/api/sdk',
    createSdkRouter({
      authenticator: deps.authenticator,
      snapshotReader: deps.snapshotReader ?? stubReader(),
      flagBus:
        deps.flagBus ??
        createFlagBus({
          interContainer: createInMemoryInterContainerBus(),
          fanoutToRegions: () => {},
        }),
    }),
  );
  return app;
}

const okAuth: AuthResult = {
  ok: true,
  environmentId: 'env-1',
  orgId: 'org-1',
  allowedOriginHeader: '*',
};

// ── /health ───────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const app = makeApp({ authenticator: stubAuthenticator(okAuth) });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

// ── /api/sdk/flags — auth-result → status code mapping ────────────────────────

describe('GET /api/sdk/flags: auth result mapping', () => {
  it('returns 401 + Unauthorized body when authenticator rejects with missing_token', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 401, reason: 'missing_token' }),
    });
    const res = await app.fetch(new Request('http://localhost/api/sdk/flags'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 + Unauthorized body when authenticator rejects with invalid_token', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 401, reason: 'invalid_token' }),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-bogus' },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 + Forbidden body when authenticator rejects with org_suspended', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 403, reason: 'org_suspended' }),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 + Forbidden body when authenticator rejects with origin_forbidden', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 403, reason: 'origin_forbidden' }),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey', Origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns CORS * on every error response', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 401, reason: 'missing_token' }),
    });
    const res = await app.fetch(new Request('http://localhost/api/sdk/flags'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ── /api/sdk/flags — successful response shape ────────────────────────────────

describe('GET /api/sdk/flags: success', () => {
  it('returns 200 with the body produced by snapshotReader.read', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator(okAuth),
      snapshotReader: stubReader({
        read: () =>
          JSON.stringify({
            flags: [
              { key: 'feature-a', enabled: true },
              { key: 'feature-b', enabled: false },
            ],
          }),
      }),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      flags: [
        { key: 'feature-a', enabled: true },
        { key: 'feature-b', enabled: false },
      ],
    });
  });

  it('echoes the allowedOriginHeader returned by the authenticator', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ...okAuth, allowedOriginHeader: 'https://app.example' }),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey', Origin: 'https://app.example' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  it('sets s-maxage Cache-Control on success', async () => {
    const app = makeApp({ authenticator: stubAuthenticator(okAuth) });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.headers.get('cache-control')).toBe('s-maxage=300, stale-while-revalidate=60');
  });

  it('forwards the CloudFront-Viewer-Country header to snapshotReader.read', async () => {
    let seenCountry: string | null | undefined;
    const app = makeApp({
      authenticator: stubAuthenticator(okAuth),
      snapshotReader: stubReader({
        read: (countryCode) => {
          seenCountry = countryCode;
          return JSON.stringify({ flags: [] });
        },
      }),
    });
    await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: {
          Authorization: 'Bearer sdk-validkey',
          'CloudFront-Viewer-Country': 'US',
        },
      }),
    );
    expect(seenCountry).toBe('US');
  });

  it('passes null country code when the header is absent', async () => {
    let seenCountry: string | null | undefined;
    const app = makeApp({
      authenticator: stubAuthenticator(okAuth),
      snapshotReader: stubReader({
        read: (countryCode) => {
          seenCountry = countryCode;
          return JSON.stringify({ flags: [] });
        },
      }),
    });
    await app.fetch(
      new Request('http://localhost/api/sdk/flags', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(seenCountry).toBeNull();
  });
});

// ── OPTIONS preflight ────────────────────────────────────────────────────────

describe('OPTIONS /api/sdk/flags', () => {
  it('returns 204 with CORS headers without consulting the authenticator', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 401, reason: 'missing_token' }),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ── /api/sdk/flags/stream — SSE transport ────────────────────────────────────

describe('GET /api/sdk/flags/stream', () => {
  it('rejects with 401 when authenticator returns missing_token', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 401, reason: 'missing_token' }),
    });
    const res = await app.fetch(new Request('http://localhost/api/sdk/flags/stream'));
    expect(res.status).toBe(401);
  });

  it('rejects with 403 when authenticator returns org_suspended', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator({ ok: false, status: 403, reason: 'org_suspended' }),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: { Authorization: 'Bearer sdk-validkey' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('emits the SSE response with the initial frame from the snapshot reader', async () => {
    const app = makeApp({
      authenticator: stubAuthenticator(okAuth),
      snapshotReader: stubReader({
        read: () => JSON.stringify({ flags: [{ key: 'feat-a', enabled: true }] }),
      }),
    });
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
    expect(JSON.parse(dataLine.slice(6))).toEqual({
      flags: [{ key: 'feat-a', enabled: true }],
    });
    await reader.cancel();
  });

  it('routes flagBus payloads through the connection-bound evaluator', async () => {
    const flagBus = createFlagBus({
      interContainer: createInMemoryInterContainerBus(),
      fanoutToRegions: () => {},
    });

    const evaluatorCalls: Array<{ countryCode: string | null; override: string | undefined }> = [];
    const evaluator: FlagEvaluator = (countryCode, override) => {
      evaluatorCalls.push({ countryCode, override });
      return override
        ? JSON.stringify({ flags: [{ key: 'feat-a', enabled: true }] })
        : JSON.stringify({ flags: [{ key: 'feat-a', enabled: false }] });
    };

    const app = makeApp({
      authenticator: stubAuthenticator(okAuth),
      snapshotReader: stubReader({ evaluator }),
      flagBus,
    });

    const res = await app.fetch(
      new Request('http://localhost/api/sdk/flags/stream', {
        headers: { Authorization: 'Bearer sdk-validkey', 'CloudFront-Viewer-Country': 'US' },
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const { value: initVal } = await reader.read();
    const initText = new TextDecoder().decode(initVal);
    expect(JSON.parse(initText.split('\n').find((l) => l.startsWith('data: '))!.slice(6))).toEqual({
      flags: [{ key: 'feat-a', enabled: false }],
    });

    // Bus delivers a fresh raw payload — the route's listener should pass it
    // to the evaluator as `override`, not call snapshotReader.read again.
    await flagBus.publishLocal('env-1', JSON.stringify({ flags: ['ignored'] }));

    const { value: updVal } = await reader.read();
    const updText = new TextDecoder().decode(updVal);
    expect(JSON.parse(updText.split('\n').find((l) => l.startsWith('data: '))!.slice(6))).toEqual({
      flags: [{ key: 'feat-a', enabled: true }],
    });

    expect(evaluatorCalls.length).toBeGreaterThanOrEqual(2);
    expect(evaluatorCalls[0]).toEqual({ countryCode: 'US', override: undefined });
    expect(evaluatorCalls[1]?.override).toBe(JSON.stringify({ flags: ['ignored'] }));
    expect(evaluatorCalls[1]?.countryCode).toBe('US');

    await reader.cancel();
  });
});

// ── Security headers integration ────────────────────────────────────────────

function makeSecureApp() {
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
  app.route(
    '/api/sdk',
    createSdkRouter({
      authenticator: stubAuthenticator({ ok: false, status: 401, reason: 'missing_token' }),
      snapshotReader: stubReader(),
      flagBus: createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: () => {},
      }),
    }),
  );
  return app;
}

describe('Security headers', () => {
  it('sets X-Frame-Options: DENY on all responses', async () => {
    const res = await makeSecureApp().fetch(new Request('http://localhost/health'));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('sets X-Content-Type-Options: nosniff on all responses', async () => {
    const res = await makeSecureApp().fetch(new Request('http://localhost/health'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets Strict-Transport-Security on all responses', async () => {
    const res = await makeSecureApp().fetch(new Request('http://localhost/health'));
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('sets Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const res = await makeSecureApp().fetch(new Request('http://localhost/health'));
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('does not clobber CORS headers on SDK error responses', async () => {
    const res = await makeSecureApp().fetch(new Request('http://localhost/api/sdk/flags'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// ── OpenAPI document & docs ──────────────────────────────────────────────────

function makeDocsApp() {
  const sdkRouter = createSdkRouter({
    authenticator: stubAuthenticator({ ok: false, status: 401, reason: 'missing_token' }),
    snapshotReader: stubReader(),
    flagBus: createFlagBus({
      interContainer: createInMemoryInterContainerBus(),
      fanoutToRegions: () => {},
    }),
  });
  const app = new Hono();
  app.route('/api/sdk', sdkRouter);
  app.get('/openapi.json', (c) => c.json(sdkRouter.getOpenAPIDocument(SDK_OPENAPI_CONFIG)));
  app.get('/api/docs', Scalar({ url: '/api/openapi.json' }));
  return app;
}

describe('GET /openapi.json', () => {
  it('returns 200 with application/json content-type', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('includes /flags path with GET method', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty('/flags');
    expect(paths['/flags'] as Record<string, unknown>).toHaveProperty('get');
  });

  it('includes /flags/stream path with GET method', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toHaveProperty('/flags/stream');
    expect(paths['/flags/stream'] as Record<string, unknown>).toHaveProperty('get');
  });

  it('includes BearerAuth security scheme in components', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const securitySchemes = (spec.components as Record<string, unknown>)
      ?.securitySchemes as Record<string, unknown>;
    expect(securitySchemes).toHaveProperty('BearerAuth');
    expect((securitySchemes.BearerAuth as Record<string, unknown>).type).toBe('http');
    expect((securitySchemes.BearerAuth as Record<string, unknown>).scheme).toBe('bearer');
  });

  it('/flags GET operation requires BearerAuth security', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const flagsGet = (paths['/flags'] as Record<string, unknown>).get as Record<string, unknown>;
    const security = flagsGet.security as Array<Record<string, unknown>>;
    expect(security.some((s) => 'BearerAuth' in s)).toBe(true);
  });

  it('/flags/stream GET operation requires BearerAuth security', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const streamGet = (paths['/flags/stream'] as Record<string, unknown>).get as Record<string, unknown>;
    const security = streamGet.security as Array<Record<string, unknown>>;
    expect(security.some((s) => 'BearerAuth' in s)).toBe(true);
  });

  it('/flags GET operation has 200, 401, and 403 response codes', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const responses = ((paths['/flags'] as Record<string, unknown>).get as Record<string, unknown>)
      .responses as Record<string, unknown>;
    expect(responses).toHaveProperty('200');
    expect(responses).toHaveProperty('401');
    expect(responses).toHaveProperty('403');
  });

  it('/flags GET has operationId getFlags', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const flagsGet = (paths['/flags'] as Record<string, unknown>).get as Record<string, unknown>;
    expect(flagsGet.operationId).toBe('getFlags');
  });

  it('/flags/stream GET has operationId getFlagsStream', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/openapi.json'));
    const spec = (await res.json()) as Record<string, unknown>;
    const paths = spec.paths as Record<string, unknown>;
    const streamGet = (paths['/flags/stream'] as Record<string, unknown>).get as Record<string, unknown>;
    expect(streamGet.operationId).toBe('getFlagsStream');
  });
});

describe('GET /api/docs', () => {
  it('returns 200 with text/html content-type', async () => {
    const res = await makeDocsApp().fetch(new Request('http://localhost/api/docs'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
