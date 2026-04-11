import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { createSdkRouter } from './sdk';

// Minimal mock DB that satisfies the shape used by createSdkRouter
function makeMockDb(overrides: Record<string, unknown> = {}) {
  const base = {
    select: () => base,
    from: () => base,
    where: () => base,
    limit: () => Promise.resolve([]),
    leftJoin: () => base,
    orderBy: () => Promise.resolve([]),
  };
  return { ...base, ...overrides } as unknown as Parameters<typeof createSdkRouter>[0];
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
