import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createSuperAdminRouter } from './superadmin';
import type { GetSession, Session } from './dashboard';

// ── Mock helpers ─────────────────────────────────────────────────────────────

const SUPER_SESSION: Session = {
  user: { id: 'u-super', name: 'Super Admin', email: 'super@example.com', isSuperAdmin: true },
};
const NON_SUPER_SESSION: Session = {
  user: { id: 'u-reg', name: 'Regular User', email: 'user@example.com', isSuperAdmin: false },
};

const noSession: GetSession = async () => null;
const superSession: GetSession = async () => SUPER_SESSION;
const regularSession: GetSession = async () => NON_SUPER_SESSION;

// Chainable mock DB — results consumed FIFO from the queue.
function makeMockDb(staticResults: unknown[][] = []) {
  const queue = [...staticResults];

  function consume(): unknown[] {
    return (queue.shift() ?? []) as unknown[];
  }

  const chain: Record<string, unknown> = {};

  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);

  for (const m of [
    'select', 'from', 'where', 'leftJoin', 'innerJoin',
    'insert', 'values', 'update', 'set', 'delete',
  ]) {
    chain[m] = () => chain;
  }

  for (const m of ['limit', 'orderBy', 'returning', 'onConflictDoNothing']) {
    chain[m] = () => Promise.resolve(consume());
  }

  return chain as unknown as Parameters<typeof createSuperAdminRouter>[0];
}

function makeApp(db: Parameters<typeof createSuperAdminRouter>[0], getSession: GetSession) {
  const app = new Hono();
  app.route('/api/superadmin', createSuperAdminRouter(db, getSession));
  return app;
}

const BASE = 'http://localhost/api/superadmin';

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

// ── Auth middleware ──────────────────────────────────────────────────────────

describe('superadmin auth middleware', () => {
  it('returns 401 when no session', async () => {
    const app = makeApp(makeMockDb(), noSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 for non-super-admin', async () => {
    const app = makeApp(makeMockDb(), regularSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('allows super-admin through', async () => {
    const app = makeApp(makeMockDb([[ORG]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(200);
  });
});

// ── GET /api/superadmin/orgs ─────────────────────────────────────────────────

describe('GET /api/superadmin/orgs', () => {
  it('returns empty list', async () => {
    const app = makeApp(makeMockDb([[/* no orgs */]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(200);
    const body = await res.json() as { orgs: unknown[] };
    expect(body.orgs).toHaveLength(0);
  });

  it('returns list of orgs', async () => {
    const app = makeApp(makeMockDb([[ORG]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(200);
    const body = await res.json() as { orgs: unknown[] };
    expect(body.orgs).toHaveLength(1);
  });
});

// ── POST /api/superadmin/orgs ────────────────────────────────────────────────

describe('POST /api/superadmin/orgs', () => {
  it('returns 400 when name is missing', async () => {
    const app = makeApp(makeMockDb(), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'acme',
        oktaClientId: 'id',
        oktaClientSecret: 'secret',
        oktaIssuer: 'https://acme.okta.com',
      }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name is required' });
  });

  it('returns 400 when oktaClientId is missing', async () => {
    const app = makeApp(makeMockDb(), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme',
        slug: 'acme',
        oktaClientSecret: 'secret',
        oktaIssuer: 'https://acme.okta.com',
      }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'oktaClientId is required' });
  });

  it('returns 400 when oktaClientSecret is missing', async () => {
    const app = makeApp(makeMockDb(), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme',
        slug: 'acme',
        oktaClientId: 'id',
        oktaIssuer: 'https://acme.okta.com',
      }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'oktaClientSecret is required' });
  });

  it('returns 400 when oktaIssuer is missing', async () => {
    const app = makeApp(makeMockDb(), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme',
        slug: 'acme',
        oktaClientId: 'id',
        oktaClientSecret: 'secret',
      }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'oktaIssuer is required' });
  });

  it('creates org and returns 201', async () => {
    const created = { ...ORG, id: 'org-new' };
    const app = makeApp(makeMockDb([[created]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme',
        slug: 'acme',
        oktaClientId: 'okta-id',
        oktaClientSecret: 'okta-secret',
        oktaIssuer: 'https://acme.okta.com',
      }),
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { org: { slug: string } };
    expect(body.org.slug).toBe('acme');
  });

  it('auto-derives slug from name', async () => {
    const created = { ...ORG, name: 'My Company', slug: 'my-company', id: 'org-new' };
    const app = makeApp(makeMockDb([[created]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'My Company',
        oktaClientId: 'okta-id',
        oktaClientSecret: 'okta-secret',
        oktaIssuer: 'https://myco.okta.com',
      }),
    }));
    expect(res.status).toBe(201);
  });
});

// ── GET /api/superadmin/orgs/:slug ───────────────────────────────────────────

describe('GET /api/superadmin/orgs/:slug', () => {
  it('returns 404 when org not found', async () => {
    const app = makeApp(makeMockDb([[]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/nonexistent`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('returns org detail with member count', async () => {
    // limit(1) pops [ORG]; then() pops [{ memberCount: 3 }]
    const app = makeApp(makeMockDb([[ORG], [{ memberCount: 3 }]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme`));
    expect(res.status).toBe(200);
    const body = await res.json() as { org: { slug: string; memberCount: number } };
    expect(body.org.slug).toBe('acme');
    expect(body.org.memberCount).toBe(3);
  });

  it('returns zero member count when no members', async () => {
    const app = makeApp(makeMockDb([[ORG], []]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme`));
    expect(res.status).toBe(200);
    const body = await res.json() as { org: { memberCount: number } };
    expect(body.org.memberCount).toBe(0);
  });
});

// ── PATCH /api/superadmin/orgs/:slug ────────────────────────────────────────

describe('PATCH /api/superadmin/orgs/:slug', () => {
  it('returns 400 when no fields provided', async () => {
    const app = makeApp(makeMockDb(), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No fields to update' });
  });

  it('returns 400 when name is set to empty string', async () => {
    const app = makeApp(makeMockDb(), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name cannot be empty' });
  });

  it('returns 404 when org not found', async () => {
    const app = makeApp(makeMockDb([[]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/nonexistent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('updates org name and returns 200', async () => {
    const updated = { ...ORG, name: 'Acme Corp' };
    const app = makeApp(makeMockDb([[updated]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { org: { name: string } };
    expect(body.org.name).toBe('Acme Corp');
  });
});

// ── POST /api/superadmin/orgs/:slug/suspend ──────────────────────────────────

describe('POST /api/superadmin/orgs/:slug/suspend', () => {
  it('returns 404 when org not found', async () => {
    const app = makeApp(makeMockDb([[]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/nonexistent/suspend`, { method: 'POST' }));
    expect(res.status).toBe(404);
  });

  it('suspends org and returns status', async () => {
    const app = makeApp(makeMockDb([[{ id: 'org-1', status: 'suspended' }]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme/suspend`, { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('suspended');
  });
});

// ── POST /api/superadmin/orgs/:slug/unsuspend ────────────────────────────────

describe('POST /api/superadmin/orgs/:slug/unsuspend', () => {
  it('returns 404 when org not found', async () => {
    const app = makeApp(makeMockDb([[]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/nonexistent/unsuspend`, { method: 'POST' }));
    expect(res.status).toBe(404);
  });

  it('unsuspends org and returns active status', async () => {
    const app = makeApp(makeMockDb([[{ id: 'org-1', status: 'active' }]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme/unsuspend`, { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('active');
  });
});

// ── DELETE /api/superadmin/orgs/:slug ────────────────────────────────────────

describe('DELETE /api/superadmin/orgs/:slug', () => {
  it('returns 404 when org not found', async () => {
    const app = makeApp(makeMockDb([[]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/nonexistent`, { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('deletes org and returns 204', async () => {
    const app = makeApp(makeMockDb([[{ id: 'org-1' }]]), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs/acme`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
  });
});
