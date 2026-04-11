import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createDashboardRouter } from './dashboard';
import type { GetSession, Session } from './dashboard';

// ── Mock helpers ────────────────────────────────────────────────────────────

const ADMIN_SESSION: Session = {
  user: { id: 'u-admin', name: 'Admin', email: 'admin@example.com' },
};
const VIEWER_SESSION: Session = {
  user: { id: 'u-viewer', name: 'Viewer', email: 'viewer@example.com' },
};

const noSession: GetSession = async () => null;
const adminSession: GetSession = async () => ADMIN_SESSION;
const viewerSession: GetSession = async () => VIEWER_SESSION;

// Org + membership fixtures prepended to every authenticated request queue.
const ORG = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  oktaClientId: 'okta-id',
  oktaClientSecret: 'okta-secret',
  oktaIssuer: 'https://acme.okta.com',
  createdAt: new Date(),
};
const ADMIN_MEMBER = [{ role: 'admin' }];
const VIEWER_MEMBER = [{ role: 'viewer' }];

// Chainable mock DB — results consumed FIFO from the queue.
// Terminal methods (.limit, .orderBy, .returning, .onConflictDoNothing) pop one entry.
// `await chain` (no explicit terminal) pops via `.then`.
function makeMockDb(staticResults: unknown[][] = []) {
  const queue = [...staticResults];

  function consume(): unknown[] {
    return (queue.shift() ?? []) as unknown[];
  }

  const chain: Record<string, unknown> = {};

  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);

  for (const m of [
    'select', 'from', 'where', 'leftJoin', 'rightJoin', 'crossJoin', 'innerJoin',
    'insert', 'values', 'onConflictDoUpdate', 'update', 'set', 'delete',
  ]) {
    chain[m] = () => chain;
  }

  for (const m of ['limit', 'orderBy', 'returning', 'onConflictDoNothing']) {
    chain[m] = () => Promise.resolve(consume());
  }

  return chain as unknown as Parameters<typeof createDashboardRouter>[0];
}

// Convenience: prepend org + admin/viewer membership results to the queue.
function adminDb(...rest: unknown[][]): ReturnType<typeof makeMockDb> {
  return makeMockDb([[ORG], ADMIN_MEMBER, ...rest]);
}
function viewerDb(...rest: unknown[][]): ReturnType<typeof makeMockDb> {
  return makeMockDb([[ORG], VIEWER_MEMBER, ...rest]);
}

function makeApp(db: Parameters<typeof createDashboardRouter>[0], getSession: GetSession) {
  const app = new Hono();
  app.route('/api/dashboard', createDashboardRouter(db, getSession));
  return app;
}

const BASE = 'http://localhost/api/dashboard/acme';

// ── Auth middleware ─────────────────────────────────────────────────────────

describe('dashboard auth middleware', () => {
  it('returns 401 when no session', async () => {
    const app = makeApp(makeMockDb(), noSession);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('allows authenticated requests through', async () => {
    const app = makeApp(adminDb([/* flags rows */], [/* env rows */]), adminSession);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(200);
  });
});

// ── Org middleware ──────────────────────────────────────────────────────────

describe('org middleware', () => {
  it('returns 404 when org slug not found', async () => {
    const app = makeApp(makeMockDb([[/* no org */]]), adminSession);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/nonexistent/flags'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('returns 403 when org is suspended', async () => {
    const suspended = { ...ORG, status: 'suspended' };
    const app = makeApp(makeMockDb([[suspended]]), adminSession);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization suspended' });
  });

  it('returns 403 when user is not a member', async () => {
    const app = makeApp(makeMockDb([[ORG], [/* no membership */]]), adminSession);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not a member of this organization' });
  });
});

// ── GET /api/dashboard/:orgSlug/context ────────────────────────────────────

describe('GET /api/dashboard/:orgSlug/context', () => {
  it('returns org info and user role', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(new Request(`${BASE}/context`));
    expect(res.status).toBe(200);
    const body = await res.json() as { org: { slug: string }; role: string };
    expect(body.org.slug).toBe('acme');
    expect(body.role).toBe('admin');
  });
});

// ── GET /api/dashboard/:orgSlug/flags ──────────────────────────────────────

describe('GET /api/dashboard/:orgSlug/flags', () => {
  it('returns flags and environments', async () => {
    const flagRows = [
      { id: 'f1', name: 'My Flag', key: 'my-flag', description: '', createdAt: new Date('2026-01-01'), envSlug: 'prod', enabled: true },
      { id: 'f1', name: 'My Flag', key: 'my-flag', description: '', createdAt: new Date('2026-01-01'), envSlug: 'staging', enabled: false },
    ];
    const envRows = [
      { id: 'e1', name: 'Production', slug: 'prod' },
      { id: 'e2', name: 'Staging', slug: 'staging' },
    ];

    const app = makeApp(adminDb(flagRows, envRows), adminSession);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(200);

    const body = await res.json() as { flags: unknown[]; environments: unknown[] };
    expect(body.flags).toHaveLength(1);
    expect(body.environments).toHaveLength(2);
  });

  it('is accessible to viewers', async () => {
    const app = makeApp(viewerDb([], []), viewerSession);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/:orgSlug/flags ─────────────────────────────────────

describe('POST /api/dashboard/:orgSlug/flags', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Beta', key: 'beta' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('creates a flag and returns 201', async () => {
    const created = { id: 'f-new', name: 'Beta', key: 'beta', description: '', createdAt: new Date() };
    // select envs → [e1]; insert flag → returning [created]; insert flagStates.onConflictDoNothing → []
    const app = makeApp(adminDb([{ id: 'e1' }], [created], []), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags`, {
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
    const app = makeApp(adminDb([{ id: 'e1' }], [created], []), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Feature' }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ── PATCH /api/dashboard/:orgSlug/flags/:key ───────────────────────────────

describe('PATCH /api/dashboard/:orgSlug/flags/:key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(adminDb([]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/nonexistent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('updates flag and returns 200', async () => {
    const updated = { id: 'f1', name: 'New Name', key: 'my-flag', description: '', createdAt: new Date() };
    const app = makeApp(adminDb([updated]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag`, {
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

// ── DELETE /api/dashboard/:orgSlug/flags/:key ──────────────────────────────

describe('DELETE /api/dashboard/:orgSlug/flags/:key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(adminDb([]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/nonexistent`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes flag and returns 204', async () => {
    const app = makeApp(adminDb([{ id: 'f1' }]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── POST /api/dashboard/:orgSlug/flags/:key/toggle ─────────────────────────

describe('POST /api/dashboard/:orgSlug/flags/:key/toggle', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'e1' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when environmentId is missing', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(adminDb([/* no flag */]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/gone/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'e1' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('toggles and returns new enabled state', async () => {
    // select flag → [{ id: 'f1' }]; insert/upsert flagState → [{ enabled: true }]
    const app = makeApp(adminDb([{ id: 'f1' }], [{ enabled: true }]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/toggle`, {
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

// ── GET /api/dashboard/:orgSlug/environments ───────────────────────────────

describe('GET /api/dashboard/:orgSlug/environments', () => {
  it('returns environments list', async () => {
    const envRows = [{ id: 'e1', name: 'Prod', slug: 'prod', allowedOrigins: [], createdAt: new Date(), keyHint: 'sdk-ab…ef' }];
    const app = makeApp(adminDb(envRows), adminSession);
    const res = await app.fetch(new Request(`${BASE}/environments`));
    expect(res.status).toBe(200);
    const body = await res.json() as { environments: unknown[] };
    expect(body.environments).toHaveLength(1);
  });

  it('is accessible to viewers', async () => {
    const app = makeApp(viewerDb([]), viewerSession);
    const res = await app.fetch(new Request(`${BASE}/environments`));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/:orgSlug/environments ──────────────────────────────

describe('POST /api/dashboard/:orgSlug/environments', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Staging' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('creates environment and returns 201 with raw API key', async () => {
    const created = { id: 'e-new', name: 'Staging', slug: 'staging', allowedOrigins: [], createdAt: new Date() };
    // insert env → [created]; insert apiKeys → []; select flags → []
    const app = makeApp(adminDb([created], [], []), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments`, {
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

// ── PATCH /api/dashboard/:orgSlug/environments/:id ─────────────────────────

describe('PATCH /api/dashboard/:orgSlug/environments/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: ['https://example.com'] }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid allowedOrigins', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedOrigins: 'not-an-array' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('updates allowedOrigins and returns 200', async () => {
    const updated = { id: 'e1', allowedOrigins: ['https://example.com'] };
    const app = makeApp(adminDb([updated]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1`, {
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

// ── DELETE /api/dashboard/:orgSlug/environments/:id ────────────────────────

describe('DELETE /api/dashboard/:orgSlug/environments/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when environment not found', async () => {
    const app = makeApp(adminDb([]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/gone`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes environment and returns 204', async () => {
    const app = makeApp(adminDb([{ id: 'e1' }]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── POST /api/dashboard/:orgSlug/environments/:id/rotate-key ───────────────

describe('POST /api/dashboard/:orgSlug/environments/:id/rotate-key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1/rotate-key`, { method: 'POST' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when environment not found', async () => {
    const app = makeApp(adminDb([/* no env */]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/gone/rotate-key`, { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });

  it('rotates key and returns new raw API key', async () => {
    // select env → [{ id: 'e1' }]; delete → []; insert → []
    const app = makeApp(adminDb([{ id: 'e1' }], [], []), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1/rotate-key`, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { apiKey: string };
    expect(body.apiKey).toMatch(/^sdk-/);
  });
});

// ── GET /api/dashboard/:orgSlug/members ────────────────────────────────────

describe('GET /api/dashboard/:orgSlug/members', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(new Request(`${BASE}/members`));
    expect(res.status).toBe(403);
  });

  it('returns members list for admin', async () => {
    const members = [{ id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'admin', createdAt: new Date() }];
    const app = makeApp(adminDb(members), adminSession);
    const res = await app.fetch(new Request(`${BASE}/members`));
    expect(res.status).toBe(200);
    const body = await res.json() as { members: unknown[] };
    expect(body.members).toHaveLength(1);
  });
});

// ── PATCH /api/dashboard/:orgSlug/members/:userId ──────────────────────────

describe('PATCH /api/dashboard/:orgSlug/members/:userId', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid role', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'superuser' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 when demoting the last admin', async () => {
    // last-admin check: no other admins
    const app = makeApp(adminDb([{ userId: 'u-admin' }], []), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u-admin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Cannot demote the last admin' });
  });

  it('updates role and returns 200 when another admin exists', async () => {
    // last-admin check: two admins exist, so we can demote
    const updated = { userId: 'u1', role: 'viewer' };
    const app = makeApp(adminDb([{ userId: 'u-admin' }, { userId: 'u1' }], [updated]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, {
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

// ── DELETE /api/dashboard/:orgSlug/members/:userId ─────────────────────────

describe('DELETE /api/dashboard/:orgSlug/members/:userId', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when member not found', async () => {
    // membership lookup → empty
    const app = makeApp(adminDb([/* empty membership */]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/gone`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 when removing the last admin', async () => {
    // membership → [{ role: 'admin' }]; admins list → [{ userId: 'u1' }] (only 1)
    const app = makeApp(adminDb([{ role: 'admin' }], [{ userId: 'u1' }]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Cannot remove the last admin' });
  });

  it('removes member and returns 204', async () => {
    // membership → [{ role: 'viewer' }]; delete (no returning needed — awaited via .then)
    const app = makeApp(adminDb([{ role: 'viewer' }], []), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── POST /api/dashboard/:orgSlug/invites ────────────────────────────────────

describe('POST /api/dashboard/:orgSlug/invites', () => {
  const INVITE_STUB = {
    id: 'inv-1',
    email: 'bob@example.com',
    role: 'viewer',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };

  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bob@example.com', role: 'viewer' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing email', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: '', role: 'viewer' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid role', async () => {
    const app = makeApp(adminDb(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bob@example.com', role: 'superuser' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 when email already belongs to an existing user', async () => {
    // user-exists check: select.limit → [{ id: 'u1' }] — user found, blocked
    const app = makeApp(adminDb([{ id: 'u1' }]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'existing@example.com', role: 'viewer' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'User already has an account' });
  });

  it('creates invite and returns 201 with token', async () => {
    // user-exists check: select.limit → [] (no user); delete existing invites → [];
    // insert.values.returning → [INVITE_STUB]
    const app = makeApp(adminDb([], [], [INVITE_STUB]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bob@example.com', role: 'viewer' }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { invite: { token: string; email: string } };
    expect(body.invite.email).toBe('bob@example.com');
    // token is a 64-char hex string
    expect(body.invite.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── GET /api/dashboard/:orgSlug/invites ─────────────────────────────────────

describe('GET /api/dashboard/:orgSlug/invites', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(new Request(`${BASE}/invites`));
    expect(res.status).toBe(403);
  });

  it('returns pending invites for admin', async () => {
    const pending = [
      { id: 'inv-1', email: 'bob@example.com', role: 'viewer', expiresAt: new Date(), createdAt: new Date() },
    ];
    const app = makeApp(adminDb(pending), adminSession);
    const res = await app.fetch(new Request(`${BASE}/invites`));
    expect(res.status).toBe(200);
    const body = await res.json() as { invites: unknown[] };
    expect(body.invites).toHaveLength(1);
  });
});

// ── DELETE /api/dashboard/:orgSlug/invites/:id ───────────────────────────────

describe('DELETE /api/dashboard/:orgSlug/invites/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerDb(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites/inv-1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when invite not found', async () => {
    // delete.returning → [] (nothing deleted)
    const app = makeApp(adminDb([]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites/inv-gone`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes invite and returns 204', async () => {
    // delete.returning → [{ id: 'inv-1' }]
    const app = makeApp(adminDb([{ id: 'inv-1' }]), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/invites/inv-1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});
