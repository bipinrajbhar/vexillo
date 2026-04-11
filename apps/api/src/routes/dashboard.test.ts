import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createDashboardRouter } from './dashboard';
import type { GetSession, Session } from './dashboard';

// ── Mock helpers ────────────────────────────────────────────────────────────

const ADMIN_SESSION: Session = {
  user: { id: 'u-admin', name: 'Admin', email: 'admin@example.com', role: 'admin' },
};
const VIEWER_SESSION: Session = {
  user: { id: 'u-viewer', name: 'Viewer', email: 'viewer@example.com', role: 'viewer' },
};

const noSession: GetSession = async () => null;
const adminSession: GetSession = async () => ADMIN_SESSION;
const viewerSession: GetSession = async () => VIEWER_SESSION;

// Chainable mock DB — results consumed FIFO from the queue.
// Terminal methods (.limit, .orderBy, .returning, .onConflictDoNothing) pop one entry.
// `await chain` (no explicit terminal, e.g. select().from().where()) pops via `.then`.
function makeMockDb(staticResults: unknown[][] = []) {
  const queue = [...staticResults];

  function consume(): unknown[] {
    return (queue.shift() ?? []) as unknown[];
  }

  // Single shared chain — all builder methods return it so `.then` is always at the end.
  const chain: Record<string, unknown> = {};

  // Thenable: handles `await db.select().from().where()` without an explicit terminal.
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);

  for (const m of [
    'select', 'from', 'where', 'leftJoin', 'rightJoin', 'crossJoin',
    'insert', 'values', 'onConflictDoUpdate', 'update', 'set', 'delete',
  ]) {
    chain[m] = () => chain;
  }

  // Terminal methods return a real Promise so the thenable `.then` is not re-triggered.
  for (const m of ['limit', 'orderBy', 'returning', 'onConflictDoNothing']) {
    chain[m] = () => Promise.resolve(consume());
  }

  return chain as unknown as Parameters<typeof createDashboardRouter>[0];
}

function makeApp(db: Parameters<typeof createDashboardRouter>[0], getSession: GetSession) {
  const app = new Hono();
  app.route('/api/dashboard', createDashboardRouter(db, getSession));
  return app;
}

// ── Auth middleware ─────────────────────────────────────────────────────────

describe('dashboard auth middleware', () => {
  it('returns 401 when no session', async () => {
    const app = makeApp(makeMockDb(), noSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/flags'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('allows authenticated requests through', async () => {
    // No DB results — GET /flags with no data should succeed (empty flag map)
    const app = makeApp(makeMockDb([[/* flags rows */], [/* env rows */]]), adminSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/flags'));
    expect(res.status).toBe(200);
  });
});

// ── GET /api/dashboard/flags ────────────────────────────────────────────────

describe('GET /api/dashboard/flags', () => {
  it('returns flags and environments', async () => {
    const flagRows = [
      { id: 'f1', name: 'My Flag', key: 'my-flag', description: '', createdAt: new Date('2026-01-01'), envSlug: 'prod', enabled: true },
      { id: 'f1', name: 'My Flag', key: 'my-flag', description: '', createdAt: new Date('2026-01-01'), envSlug: 'staging', enabled: false },
    ];
    const envRows = [
      { id: 'e1', name: 'Production', slug: 'prod' },
      { id: 'e2', name: 'Staging', slug: 'staging' },
    ];

    const app = makeApp(makeMockDb([flagRows, envRows]), adminSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/flags'));
    expect(res.status).toBe(200);

    const body = await res.json() as { flags: unknown[]; environments: unknown[] };
    expect(body.flags).toHaveLength(1);
    expect(body.environments).toHaveLength(2);
  });

  it('is accessible to viewers', async () => {
    const app = makeApp(makeMockDb([[], []]), viewerSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/flags'));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/flags ───────────────────────────────────────────────

describe('POST /api/dashboard/flags', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Beta', key: 'beta' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const app = makeApp(makeMockDb(), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('creates a flag and returns 201', async () => {
    const created = { id: 'f-new', name: 'Beta', key: 'beta', description: '', createdAt: new Date() };
    // insert flag → returning [created]; select envs → []; (no flagStates insert needed)
    const app = makeApp(makeMockDb([[created], []]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Beta', key: 'beta' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { flag: { key: string } };
    expect(body.flag.key).toBe('beta');
  });

  it('auto-slugifies name into key', async () => {
    const created = { id: 'f2', name: 'My Feature', key: 'my-feature', description: '', createdAt: new Date() };
    const app = makeApp(makeMockDb([[created], []]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Feature' }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ── PATCH /api/dashboard/flags/:key ────────────────────────────────────────

describe('PATCH /api/dashboard/flags/:key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/my-flag', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(makeMockDb([[/* empty update result */]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/nonexistent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('updates flag and returns 200', async () => {
    const updated = { id: 'f1', name: 'New Name', key: 'my-flag', description: '', createdAt: new Date() };
    const app = makeApp(makeMockDb([[updated]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/my-flag', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { flag: { name: string } };
    expect(body.flag.name).toBe('New Name');
  });
});

// ── DELETE /api/dashboard/flags/:key ───────────────────────────────────────

describe('DELETE /api/dashboard/flags/:key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/my-flag', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(makeMockDb([[/* empty */]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/nonexistent', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes flag and returns 204', async () => {
    const app = makeApp(makeMockDb([[{ id: 'f1' }]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/my-flag', { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── POST /api/dashboard/flags/:key/toggle ──────────────────────────────────

describe('POST /api/dashboard/flags/:key/toggle', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/my-flag/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'e1' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when environmentId is missing', async () => {
    const app = makeApp(makeMockDb(), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/my-flag/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(makeMockDb([[/* no flag */]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/gone/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'e1' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('toggles and returns new enabled state', async () => {
    // select flag → [{ id: 'f1' }]; insert/upsert flagState → [{ enabled: true }]
    const app = makeApp(makeMockDb([[{ id: 'f1' }], [{ enabled: true }]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/flags/my-flag/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'e1' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean };
    expect(body.enabled).toBe(true);
  });
});

// ── GET /api/dashboard/environments ────────────────────────────────────────

describe('GET /api/dashboard/environments', () => {
  it('returns environments list', async () => {
    const envRows = [{ id: 'e1', name: 'Prod', slug: 'prod', allowedOrigins: [], createdAt: new Date(), keyHint: 'sdk-ab…ef' }];
    const app = makeApp(makeMockDb([envRows]), adminSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/environments'));
    expect(res.status).toBe(200);
    const body = await res.json() as { environments: unknown[] };
    expect(body.environments).toHaveLength(1);
  });

  it('is accessible to viewers', async () => {
    const app = makeApp(makeMockDb([[]]), viewerSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/environments'));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/environments ───────────────────────────────────────

describe('POST /api/dashboard/environments', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Staging' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const app = makeApp(makeMockDb(), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('creates environment and returns 201 with raw API key', async () => {
    const created = { id: 'e-new', name: 'Staging', slug: 'staging', allowedOrigins: [], createdAt: new Date() };
    // insert env → [created]; insert apiKeys → []; select flags → []; (no flagStates insert needed)
    const app = makeApp(makeMockDb([[created], [], []]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Staging' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { environment: { slug: string }; apiKey: string };
    expect(body.environment.slug).toBe('staging');
    expect(body.apiKey).toMatch(/^sdk-/);
  });
});

// ── PATCH /api/dashboard/environments/:id ──────────────────────────────────

describe('PATCH /api/dashboard/environments/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/e1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: ['https://example.com'] }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid allowedOrigins', async () => {
    const app = makeApp(makeMockDb(), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/e1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: 'not-an-array' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('updates allowedOrigins and returns 200', async () => {
    const updated = { id: 'e1', allowedOrigins: ['https://example.com'] };
    const app = makeApp(makeMockDb([[updated]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/e1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: ['https://example.com'] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { environment: { allowedOrigins: string[] } };
    expect(body.environment.allowedOrigins).toContain('https://example.com');
  });
});

// ── DELETE /api/dashboard/environments/:id ──────────────────────────────────

describe('DELETE /api/dashboard/environments/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/e1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when environment not found', async () => {
    const app = makeApp(makeMockDb([[/* empty */]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/gone', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes environment and returns 204', async () => {
    const app = makeApp(makeMockDb([[{ id: 'e1' }]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/e1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── POST /api/dashboard/environments/:id/rotate-key ────────────────────────

describe('POST /api/dashboard/environments/:id/rotate-key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/e1/rotate-key', { method: 'POST' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when environment not found', async () => {
    const app = makeApp(makeMockDb([[/* no env */]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/gone/rotate-key', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });

  it('rotates key and returns new raw API key', async () => {
    // select env → [{ id: 'e1' }]; delete → []; insert → []
    const app = makeApp(makeMockDb([[{ id: 'e1' }], [], []]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/environments/e1/rotate-key', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { apiKey: string };
    expect(body.apiKey).toMatch(/^sdk-/);
  });
});

// ── GET /api/dashboard/members ──────────────────────────────────────────────

describe('GET /api/dashboard/members', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/members'));
    expect(res.status).toBe(403);
  });

  it('returns members list for admin', async () => {
    const members = [{ id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'admin', createdAt: new Date() }];
    const app = makeApp(makeMockDb([members]), adminSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/members'));
    expect(res.status).toBe(200);
    const body = await res.json() as { members: unknown[] };
    expect(body.members).toHaveLength(1);
  });
});

// ── PATCH /api/dashboard/members/:id ───────────────────────────────────────

describe('PATCH /api/dashboard/members/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/members/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid role', async () => {
    const app = makeApp(makeMockDb(), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/members/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'superuser' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('updates role and returns 200', async () => {
    const updated = { id: 'u1', role: 'viewer' };
    const app = makeApp(makeMockDb([[updated]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/members/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { member: { role: string } };
    expect(body.member.role).toBe('viewer');
  });
});

// ── DELETE /api/dashboard/members/:id ──────────────────────────────────────

describe('DELETE /api/dashboard/members/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(makeMockDb(), viewerSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/members/u1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when member not found', async () => {
    const app = makeApp(makeMockDb([[/* empty */]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/members/gone', { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes member and returns 204', async () => {
    const app = makeApp(makeMockDb([[{ id: 'u1' }]]), adminSession);
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard/members/u1', { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});
