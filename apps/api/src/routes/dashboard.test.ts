import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { createDashboardRouter } from './dashboard';
import type { GetSession, Session } from './dashboard';
import type { DashboardService, OrgRow } from '../services/dashboard-service';
import { NotFoundError, ConflictError, PreconditionError, ForbiddenError, createDashboardService } from '../services/dashboard-service';
import type { DbClient } from '@vexillo/db';

// ── Session fixtures ─────────────────────────────────────────────────────────

const ADMIN_SESSION: Session = {
  user: { id: 'u-admin', name: 'Admin', email: 'admin@example.com' },
};
const VIEWER_SESSION: Session = {
  user: { id: 'u-viewer', name: 'Viewer', email: 'viewer@example.com' },
};

const noSession: GetSession = async () => null;
const adminSession: GetSession = async () => ADMIN_SESSION;
const viewerSession: GetSession = async () => VIEWER_SESSION;

// ── Org fixtures ─────────────────────────────────────────────────────────────

const ORG: OrgRow = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  oktaClientId: 'okta-id',
  oktaClientSecret: 'encrypted-secret',
  oktaIssuer: 'https://acme.okta.com',
  createdAt: new Date(),
};

// ── Mock service factory ─────────────────────────────────────────────────────
//
// Returns a DashboardService where every method throws by default.
// Pass `overrides` to configure the behaviour needed for each test.

function makeMockService(overrides: Partial<DashboardService> = {}): DashboardService {
  const notImplemented = (name: string) => () => {
    throw new Error(`Mock service method not implemented: ${name}`);
  };

  return {
    resolveOrgContext: notImplemented('resolveOrgContext') as DashboardService['resolveOrgContext'],
    getMyOrgs: notImplemented('getMyOrgs') as DashboardService['getMyOrgs'],
    getFlagsWithStates: notImplemented('getFlagsWithStates') as DashboardService['getFlagsWithStates'],
    createFlag: notImplemented('createFlag') as DashboardService['createFlag'],
    updateFlag: notImplemented('updateFlag') as DashboardService['updateFlag'],
    deleteFlag: notImplemented('deleteFlag') as DashboardService['deleteFlag'],
    toggleFlag: notImplemented('toggleFlag') as DashboardService['toggleFlag'],
    updateCountryRules: notImplemented('updateCountryRules') as DashboardService['updateCountryRules'],
    getEnvironments: notImplemented('getEnvironments') as DashboardService['getEnvironments'],
    createEnvironment: notImplemented('createEnvironment') as DashboardService['createEnvironment'],
    updateEnvironmentOrigins: notImplemented('updateEnvironmentOrigins') as DashboardService['updateEnvironmentOrigins'],
    deleteEnvironment: notImplemented('deleteEnvironment') as DashboardService['deleteEnvironment'],
    rotateEnvironmentKey: notImplemented('rotateEnvironmentKey') as DashboardService['rotateEnvironmentKey'],
    getMembers: notImplemented('getMembers') as DashboardService['getMembers'],
    getRemovedMembers: notImplemented('getRemovedMembers') as DashboardService['getRemovedMembers'],
    updateMemberRole: notImplemented('updateMemberRole') as DashboardService['updateMemberRole'],
    removeMember: notImplemented('removeMember') as DashboardService['removeMember'],
    restoreMember: notImplemented('restoreMember') as DashboardService['restoreMember'],
    ...overrides,
  };
}

// Convenience: an adminCtx-resolving service (most tests need this to pass the org middleware).
function adminService(overrides: Partial<DashboardService> = {}): DashboardService {
  return makeMockService({
    resolveOrgContext: async () => ({ org: ORG, role: 'admin' }),
    ...overrides,
  });
}

function viewerService(overrides: Partial<DashboardService> = {}): DashboardService {
  return makeMockService({
    resolveOrgContext: async () => ({ org: ORG, role: 'viewer' }),
    ...overrides,
  });
}

function makeApp(service: DashboardService, getSession: GetSession) {
  const app = new Hono();
  app.route('/api/dashboard', createDashboardRouter(service, getSession));
  return app;
}

const BASE = 'http://localhost/api/dashboard/acme';

// ── Auth middleware ──────────────────────────────────────────────────────────

describe('dashboard auth middleware', () => {
  it('returns 401 when no session', async () => {
    const app = makeApp(makeMockService(), noSession);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('allows authenticated requests through', async () => {
    const app = makeApp(
      adminService({ getFlagsWithStates: async () => ({ flags: [], environments: [] }) }),
      adminSession,
    );
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(200);
  });
});

// ── Org middleware ───────────────────────────────────────────────────────────

describe('org middleware', () => {
  it('returns 404 when org slug not found', async () => {
    const app = makeApp(
      makeMockService({ resolveOrgContext: async () => null }),
      adminSession,
    );
    const res = await app.fetch(new Request('http://localhost/api/dashboard/nonexistent/flags'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('returns 403 when org is suspended', async () => {
    const suspended = { ...ORG, status: 'suspended' };
    const app = makeApp(
      makeMockService({ resolveOrgContext: async () => ({ org: suspended, role: 'admin' }) }),
      adminSession,
    );
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization suspended' });
  });

  it('returns 403 when user is not a member', async () => {
    const app = makeApp(
      makeMockService({ resolveOrgContext: async () => ({ org: ORG, role: null }) }),
      adminSession,
    );
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not a member of this organization' });
  });
});

// ── GET /api/dashboard/:orgSlug/context ─────────────────────────────────────

describe('GET /api/dashboard/:orgSlug/context', () => {
  it('returns org info and user role', async () => {
    const app = makeApp(adminService(), adminSession);
    const res = await app.fetch(new Request(`${BASE}/context`));
    expect(res.status).toBe(200);
    const body = await res.json() as { org: { slug: string }; role: string };
    expect(body.org.slug).toBe('acme');
    expect(body.role).toBe('admin');
  });
});

// ── GET /api/dashboard/:orgSlug/flags ───────────────────────────────────────

describe('GET /api/dashboard/:orgSlug/flags', () => {
  it('returns flags and environments', async () => {
    const flags = [{ id: 'f1', name: 'My Flag', key: 'my-flag', description: '', createdAt: new Date(), createdByName: null, states: { prod: true, staging: false }, countryRules: {} }];
    const environments = [{ id: 'e1', name: 'Production', slug: 'prod' }, { id: 'e2', name: 'Staging', slug: 'staging' }];

    const app = makeApp(
      adminService({ getFlagsWithStates: async () => ({ flags, environments }) }),
      adminSession,
    );
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(200);

    const body = await res.json() as { flags: unknown[]; environments: unknown[] };
    expect(body.flags).toHaveLength(1);
    expect(body.environments).toHaveLength(2);
  });

  it('is accessible to viewers', async () => {
    const app = makeApp(
      viewerService({ getFlagsWithStates: async () => ({ flags: [], environments: [] }) }),
      viewerSession,
    );
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/:orgSlug/flags ──────────────────────────────────────

describe('POST /api/dashboard/:orgSlug/flags', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
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
    const app = makeApp(adminService(), adminSession);
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
    const created = { id: 'f-new', orgId: 'org-1', name: 'Beta', key: 'beta', description: '', createdAt: new Date(), createdByUserId: 'u1' };
    const app = makeApp(
      adminService({ createFlag: async () => created }),
      adminSession,
    );
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
    const created = { id: 'f2', orgId: 'org-1', name: 'My Feature', key: 'my-feature', description: '', createdAt: new Date(), createdByUserId: 'u1' };
    const app = makeApp(
      adminService({ createFlag: async () => created }),
      adminSession,
    );
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

// ── PATCH /api/dashboard/:orgSlug/flags/:key ────────────────────────────────

describe('PATCH /api/dashboard/:orgSlug/flags/:key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
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
    const app = makeApp(
      adminService({ updateFlag: async () => { throw new NotFoundError('Flag not found'); } }),
      adminSession,
    );
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
    const updated = { id: 'f1', orgId: 'org-1', name: 'New Name', key: 'my-flag', description: '', createdAt: new Date(), createdByUserId: 'u1' };
    const app = makeApp(
      adminService({ updateFlag: async () => updated }),
      adminSession,
    );
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

// ── DELETE /api/dashboard/:orgSlug/flags/:key ───────────────────────────────

describe('DELETE /api/dashboard/:orgSlug/flags/:key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(
      adminService({ deleteFlag: async () => { throw new NotFoundError('Flag not found'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/flags/nonexistent`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes flag and returns 204', async () => {
    const app = makeApp(
      adminService({ deleteFlag: async () => undefined }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── POST /api/dashboard/:orgSlug/flags/:key/toggle ──────────────────────────

describe('POST /api/dashboard/:orgSlug/flags/:key/toggle', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
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
    const app = makeApp(adminService(), adminSession);
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
    const app = makeApp(
      adminService({ toggleFlag: async () => { throw new NotFoundError('Flag not found'); } }),
      adminSession,
    );
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
    const app = makeApp(
      adminService({ toggleFlag: async () => ({ enabled: true }) }),
      adminSession,
    );
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

// ── PUT /api/dashboard/:orgSlug/flags/:key/environments/:envId/country-rules ─

describe('PUT /api/dashboard/:orgSlug/flags/:key/environments/:envId/country-rules', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/environments/env-1/country-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countries: ['US'] }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when countries is not an array', async () => {
    const app = makeApp(adminService(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/environments/env-1/country-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countries: 'US' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when countries contains non-strings', async () => {
    const app = makeApp(adminService(), adminSession);
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/environments/env-1/country-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countries: ['US', 42] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when flag not found', async () => {
    const app = makeApp(
      adminService({ updateCountryRules: async () => { throw new NotFoundError('Flag not found'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/flags/gone/environments/env-1/country-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countries: ['US'] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 with updated country list', async () => {
    const app = makeApp(
      adminService({ updateCountryRules: async () => ({ countries: ['CA', 'US'] }) }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/environments/env-1/country-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countries: ['CA', 'US'] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { countries: string[] };
    expect(body.countries).toEqual(['CA', 'US']);
  });

  it('accepts an empty array to clear all rules', async () => {
    const app = makeApp(
      adminService({ updateCountryRules: async () => ({ countries: [] }) }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/flags/my-flag/environments/env-1/country-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countries: [] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { countries: string[] };
    expect(body.countries).toEqual([]);
  });
});

// ── GET /api/dashboard/:orgSlug/environments ────────────────────────────────

describe('GET /api/dashboard/:orgSlug/environments', () => {
  it('returns environments list', async () => {
    const envRows = [{ id: 'e1', name: 'Prod', slug: 'prod', allowedOrigins: [], createdAt: new Date(), keyHint: 'sdk-ab…ef' }];
    const app = makeApp(
      adminService({ getEnvironments: async () => envRows }),
      adminSession,
    );
    const res = await app.fetch(new Request(`${BASE}/environments`));
    expect(res.status).toBe(200);
    const body = await res.json() as { environments: unknown[] };
    expect(body.environments).toHaveLength(1);
  });

  it('is accessible to viewers', async () => {
    const app = makeApp(
      viewerService({ getEnvironments: async () => [] }),
      viewerSession,
    );
    const res = await app.fetch(new Request(`${BASE}/environments`));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/:orgSlug/environments ───────────────────────────────

describe('POST /api/dashboard/:orgSlug/environments', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
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
    const app = makeApp(
      adminService({ createEnvironment: async () => { throw new PreconditionError('Invalid name'); } }),
      adminSession,
    );
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
    const created = { id: 'e-new', orgId: 'org-1', name: 'Staging', slug: 'staging', allowedOrigins: [] as string[], createdAt: new Date() };
    const app = makeApp(
      adminService({ createEnvironment: async () => ({ environment: created, apiKey: 'sdk-test-key-create' }) }),
      adminSession,
    );
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

// ── PATCH /api/dashboard/:orgSlug/environments/:id ──────────────────────────

describe('PATCH /api/dashboard/:orgSlug/environments/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
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
    const app = makeApp(adminService(), adminSession);
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
    const app = makeApp(
      adminService({ updateEnvironmentOrigins: async () => updated }),
      adminSession,
    );
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

// ── DELETE /api/dashboard/:orgSlug/environments/:id ─────────────────────────

describe('DELETE /api/dashboard/:orgSlug/environments/:id', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when environment not found', async () => {
    const app = makeApp(
      adminService({ deleteEnvironment: async () => { throw new NotFoundError('Environment not found'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/environments/gone`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes environment and returns 204', async () => {
    const app = makeApp(
      adminService({ deleteEnvironment: async () => undefined }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── POST /api/dashboard/:orgSlug/environments/:id/rotate-key ────────────────

describe('POST /api/dashboard/:orgSlug/environments/:id/rotate-key', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1/rotate-key`, { method: 'POST' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when environment not found', async () => {
    const app = makeApp(
      adminService({ rotateEnvironmentKey: async () => { throw new NotFoundError('Environment not found'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/environments/gone/rotate-key`, { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });

  it('rotates key and returns new raw API key', async () => {
    const app = makeApp(
      adminService({ rotateEnvironmentKey: async () => ({ apiKey: 'sdk-test-key-rotated' }) }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/environments/e1/rotate-key`, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { apiKey: string };
    expect(body.apiKey).toMatch(/^sdk-/);
  });
});

// ── GET /api/dashboard/:orgSlug/members ─────────────────────────────────────

describe('GET /api/dashboard/:orgSlug/members', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
    const res = await app.fetch(new Request(`${BASE}/members`));
    expect(res.status).toBe(403);
  });

  it('returns members list for admin', async () => {
    const members = [{ id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'admin', createdAt: new Date(), isSuperAdmin: false }];
    const app = makeApp(
      adminService({ getMembers: async () => members }),
      adminSession,
    );
    const res = await app.fetch(new Request(`${BASE}/members`));
    expect(res.status).toBe(200);
    const body = await res.json() as { members: unknown[] };
    expect(body.members).toHaveLength(1);
  });
});

// ── PATCH /api/dashboard/:orgSlug/members/:userId ───────────────────────────

describe('PATCH /api/dashboard/:orgSlug/members/:userId', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when targeting a super admin', async () => {
    const app = makeApp(
      adminService({ updateMemberRole: async () => { throw new ForbiddenError('Cannot change role of a super admin'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/members/u-superadmin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Cannot change role of a super admin' });
  });

  it('returns 400 for invalid role', async () => {
    const app = makeApp(
      adminService({ updateMemberRole: async () => { throw new PreconditionError('Role must be admin or viewer'); } }),
      adminSession,
    );
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
    const app = makeApp(
      adminService({ updateMemberRole: async () => { throw new ConflictError('Cannot demote the last admin'); } }),
      adminSession,
    );
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
    const app = makeApp(
      adminService({ updateMemberRole: async () => ({ userId: 'u1', role: 'viewer' }) }),
      adminSession,
    );
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

// ── DELETE /api/dashboard/:orgSlug/members/:userId ──────────────────────────

describe('DELETE /api/dashboard/:orgSlug/members/:userId', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession);
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when member not found', async () => {
    const app = makeApp(
      adminService({ removeMember: async () => { throw new NotFoundError('Member not found'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/members/gone`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when targeting a super admin', async () => {
    const app = makeApp(
      adminService({ removeMember: async () => { throw new ForbiddenError('Cannot remove a super admin from an org'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/members/u-superadmin`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Cannot remove a super admin from an org' });
  });

  it('returns 409 when removing the last admin', async () => {
    const app = makeApp(
      adminService({ removeMember: async () => { throw new ConflictError('Cannot remove the last admin'); } }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Cannot remove the last admin' });
  });

  it('removes member and returns 204', async () => {
    const app = makeApp(
      adminService({ removeMember: async () => undefined }),
      adminSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/members/u1`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
  });
});

// ── DashboardService — toggleFlag Redis publish ───────────────────────────────
//
// Queue-based mock DB where onConflictDoUpdate is non-terminal (returns the chain
// so that .returning() can chain after it), unlike the org-oauth mock which makes
// it terminal. This matches the toggleFlag + queryEnvironmentFlagStates call shapes.

function makeServiceDb(results: unknown[][]): DbClient {
  const queue = [...results];
  function consume(): unknown[] {
    return (queue.shift() ?? []) as unknown[];
  }
  const chain: Record<string, unknown> = {};
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);
  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'insert', 'values', 'onConflictDoUpdate', 'set', 'update', 'delete']) {
    chain[m] = () => chain;
  }
  for (const m of ['limit', 'orderBy', 'returning', 'onConflictDoNothing']) {
    chain[m] = () => Promise.resolve(consume());
  }
  return chain as unknown as DbClient;
}

describe('createDashboardService — toggleFlag Redis publish', () => {
  it('publishes the full flag snapshot to flags:env:{environmentId} after a successful toggle', async () => {
    const db = makeServiceDb([
      [{ id: 'flag-1' }],                                               // flags lookup (thenable)
      [{ enabled: true }],                                               // flagStates upsert (returning)
      [],                                                                // audit log insert (returning)
      [{ key: 'feat-a', enabled: true }, { key: 'feat-b', enabled: false }], // queryEnvironmentFlagStates (orderBy)
    ]);

    const notifyMock = mock((_envId: string, _payload: string) => Promise.resolve());

    const service = createDashboardService(db, notifyMock);
    const result = await service.toggleFlag('org-1', 'actor-1', 'feat-a', 'env-1');

    expect(result).toEqual({ enabled: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [envId, payload] = notifyMock.mock.calls[0] as unknown as [string, string];
    expect(envId).toBe('env-1');
    const parsed = JSON.parse(payload) as { flags: Array<{ key: string; enabled: boolean }> };
    expect(parsed.flags).toEqual([
      { key: 'feat-a', enabled: true },
      { key: 'feat-b', enabled: false },
    ]);
  });

  it('does not publish when no redisPublisher is provided', async () => {
    const db = makeServiceDb([
      [{ id: 'flag-1' }],   // flags lookup
      [{ enabled: false }], // flagStates upsert
      [],                   // audit log
    ]);

    const service = createDashboardService(db);
    const result = await service.toggleFlag('org-1', 'actor-1', 'feat-a', 'env-1');
    expect(result).toEqual({ enabled: false });
  });
});

describe('createDashboardService — updateCountryRules', () => {
  it('persists rules, writes audit log with before/after, and notifies', async () => {
    const db = makeServiceDb([
      [{ id: 'flag-1' }],                                      // flags lookup (thenable)
      [{ allowedCountries: ['FR'] }],                           // current flagStates (limit)
      [{ allowedCountries: ['US', 'CA'] }],                     // upsert returning
      [],                                                       // audit log (returning)
      [{ key: 'feat-a', enabled: true, allowedCountries: ['US', 'CA'] }], // queryEnvironmentFlagStates (orderBy)
    ]);

    const notifyMock = mock((_envId: string, _payload: string) => Promise.resolve());
    const service = createDashboardService(db, notifyMock);
    const result = await service.updateCountryRules('org-1', 'actor-1', 'feat-a', 'env-1', ['us', 'ca']);

    expect(result).toEqual({ countries: ['US', 'CA'] });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [envId] = notifyMock.mock.calls[0] as unknown as [string, string];
    expect(envId).toBe('env-1');
  });

  it('clears rules when countries is empty', async () => {
    const db = makeServiceDb([
      [{ id: 'flag-1' }],             // flags lookup (thenable)
      [{ allowedCountries: ['US'] }], // current state (limit)
      [{ allowedCountries: [] }],     // upsert returning
      [],                             // audit log
    ]);

    const service = createDashboardService(db);
    const result = await service.updateCountryRules('org-1', 'actor-1', 'feat-a', 'env-1', []);
    expect(result).toEqual({ countries: [] });
  });

  it('returns NotFoundError when flag does not exist', async () => {
    const db = makeServiceDb([
      [], // flags lookup returns empty
    ]);

    const service = createDashboardService(db);
    await expect(service.updateCountryRules('org-1', 'actor-1', 'missing', 'env-1', ['US'])).rejects.toThrow('Flag not found');
  });
});
