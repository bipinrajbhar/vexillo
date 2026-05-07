import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { createDashboardRouter } from './dashboard';
import type { GetSession, Session } from './dashboard';
import type { DashboardService, OrgRow } from '../services/dashboard-service';
import { NotFoundError, ConflictError, PreconditionError, ForbiddenError, createDashboardService } from '../services/dashboard-service';
import type { FlagOps, DomainEvent } from '../services/flag-ops';
import type { OrgContextResolver } from '../lib/org-context-resolver';
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

// ── Mock resolver factory ────────────────────────────────────────────────────

function adminResolver(overrides: Partial<OrgContextResolver> = {}): OrgContextResolver {
  return {
    resolve: async () => ({ org: ORG, role: 'admin' }),
    invalidate: () => {},
    ...overrides,
  };
}

function viewerResolver(overrides: Partial<OrgContextResolver> = {}): OrgContextResolver {
  return {
    resolve: async () => ({ org: ORG, role: 'viewer' }),
    invalidate: () => {},
    ...overrides,
  };
}

// Convenience aliases — service overrides only; role comes from the resolver.
function adminService(overrides: Partial<DashboardService> = {}): DashboardService {
  return makeMockService(overrides);
}

function viewerService(overrides: Partial<DashboardService> = {}): DashboardService {
  return makeMockService(overrides);
}

function makeApp(service: DashboardService, getSession: GetSession, resolver: OrgContextResolver = adminResolver()) {
  const app = new Hono();
  app.route('/api/dashboard', createDashboardRouter(service, getSession, resolver));
  return app;
}

// ── Mock FlagOps factory ────────────────────────────────────────────────────
//
// Returns a FlagOps whose `commit` records every event so tests can assert on
// the event kind / payload that DashboardService dispatched. Read methods are
// not exercised by these tests (the route mocks DashboardService directly when
// it needs read behaviour) — they throw to make accidental reliance loud.

interface RecordingFlagOps extends FlagOps {
  events: DomainEvent[];
}

function makeNullFlagOps(): RecordingFlagOps {
  const events: DomainEvent[] = [];
  const notUsed = () => {
    throw new Error('FlagOps.read not used by DashboardService unit tests');
  };
  return {
    events,
    commit: mock(async (event: DomainEvent) => {
      events.push(event);
    }),
    read: {
      flagsWithStates: notUsed as FlagOps['read']['flagsWithStates'],
      environments: notUsed as FlagOps['read']['environments'],
      members: notUsed as FlagOps['read']['members'],
      removedMembers: notUsed as FlagOps['read']['removedMembers'],
    },
  };
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
    const resolver = adminResolver({
      resolve: async () => { throw new NotFoundError('Organization not found'); },
    });
    const app = makeApp(makeMockService(), adminSession, resolver);
    const res = await app.fetch(new Request('http://localhost/api/dashboard/nonexistent/flags'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('returns 403 when org is suspended', async () => {
    const resolver = adminResolver({
      resolve: async () => { throw new ForbiddenError('Organization suspended'); },
    });
    const app = makeApp(makeMockService(), adminSession, resolver);
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization suspended' });
  });

  it('returns 403 when user is not a member', async () => {
    const resolver = adminResolver({
      resolve: async () => { throw new ForbiddenError('Not a member of this organization'); },
    });
    const app = makeApp(makeMockService(), adminSession, resolver);
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
      viewerResolver(),
    );
    const res = await app.fetch(new Request(`${BASE}/flags`));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/:orgSlug/flags ──────────────────────────────────────

describe('POST /api/dashboard/:orgSlug/flags', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
      viewerResolver(),
    );
    const res = await app.fetch(new Request(`${BASE}/environments`));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/dashboard/:orgSlug/environments ───────────────────────────────

describe('POST /api/dashboard/:orgSlug/environments', () => {
  it('returns 403 for viewer', async () => {
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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
    const app = makeApp(viewerService(), viewerSession, viewerResolver());
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

// ── DashboardService — service boundary tests ─────────────────────────────────
//
// Queue-based mock DB that simulates the Drizzle query builder chain.
// onConflictDoUpdate is non-terminal so .returning() can chain after it.

function makeServiceDb(results: Array<unknown[] | Error>): DbClient {
  const queue = [...results];
  function consume(): Promise<unknown[]> {
    const next = queue.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve((next ?? []) as unknown[]);
  }
  const chain: Record<string, unknown> = {};
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    consume().then(resolve, reject);
  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'insert', 'values', 'onConflictDoUpdate', 'set', 'update', 'delete']) {
    chain[m] = () => chain;
  }
  for (const m of ['limit', 'orderBy', 'returning', 'onConflictDoNothing']) {
    chain[m] = () => consume();
  }
  chain.transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(chain);
  return chain as unknown as DbClient;
}

describe('createDashboardService — toggleFlag dispatches flag.toggled', () => {
  it('commits a flag.toggled event with the result enabled state after a successful toggle', async () => {
    const db = makeServiceDb([
      [{ id: 'flag-1' }],  // flags lookup (thenable)
      [{ enabled: true }],  // flagStates upsert (returning)
    ]);

    const flagOps = makeNullFlagOps();
    const service = createDashboardService(db, flagOps);
    const result = await service.toggleFlag('org-1', 'actor-1', 'feat-a', 'env-1');

    expect(result).toEqual({ enabled: true });
    expect(flagOps.events).toEqual([
      {
        kind: 'flag.toggled',
        orgId: 'org-1',
        actorId: 'actor-1',
        flagKey: 'feat-a',
        environmentId: 'env-1',
        enabled: true,
      },
    ]);
  });

  it('throws NotFoundError and commits nothing when flag is missing', async () => {
    const db = makeServiceDb([
      [],  // flags lookup returns empty → toggle returns null
    ]);

    const flagOps = makeNullFlagOps();
    const service = createDashboardService(db, flagOps);
    await expect(service.toggleFlag('org-1', 'actor-1', 'missing', 'env-1')).rejects.toThrow('Flag not found');
    expect(flagOps.events).toEqual([]);
  });
});

describe('createDashboardService — updateCountryRules dispatches flag.country_rules', () => {
  it('commits a flag.country_rules event with before/after arrays', async () => {
    const db = makeServiceDb([
      [{ id: 'flag-1' }],                         // flags lookup (thenable)
      [{ allowedCountries: ['FR'] }],              // current flagStates (limit)
      [{ allowedCountries: ['US', 'CA'] }],        // upsert returning
    ]);

    const flagOps = makeNullFlagOps();
    const service = createDashboardService(db, flagOps);
    const result = await service.updateCountryRules('org-1', 'actor-1', 'feat-a', 'env-1', ['us', 'ca']);

    expect(result).toEqual({ countries: ['US', 'CA'] });
    expect(flagOps.events).toEqual([
      {
        kind: 'flag.country_rules',
        orgId: 'org-1',
        actorId: 'actor-1',
        flagKey: 'feat-a',
        environmentId: 'env-1',
        before: ['FR'],
        after: ['US', 'CA'],
      },
    ]);
  });

  it('clears rules when countries is empty', async () => {
    const db = makeServiceDb([
      [{ id: 'flag-1' }],             // flags lookup (thenable)
      [{ allowedCountries: ['US'] }], // current state (limit)
      [{ allowedCountries: [] }],     // upsert returning
    ]);

    const service = createDashboardService(db, makeNullFlagOps());
    const result = await service.updateCountryRules('org-1', 'actor-1', 'feat-a', 'env-1', []);
    expect(result).toEqual({ countries: [] });
  });

  it('throws NotFoundError when flag does not exist', async () => {
    const db = makeServiceDb([
      [], // flags lookup returns empty
    ]);

    const service = createDashboardService(db, makeNullFlagOps());
    await expect(service.updateCountryRules('org-1', 'actor-1', 'missing', 'env-1', ['US'])).rejects.toThrow('Flag not found');
  });
});

describe('createDashboardService — createFlag transaction boundary', () => {
  it('creates flag and commits a flag.created event on success', async () => {
    const flagRow = { id: 'f1', orgId: 'org-1', name: 'Beta', key: 'beta', description: '', createdAt: new Date(), createdByUserId: 'u1' };
    const db = makeServiceDb([
      [{ id: 'env-1' }], // queryOrgEnvironmentIds (thenable)
      [flagRow],          // insertFlag (returning)
      [],                 // backfillFlagStatesForFlag (onConflictDoNothing)
    ]);
    const flagOps = makeNullFlagOps();
    const service = createDashboardService(db, flagOps);
    const result = await service.createFlag('org-1', 'u1', { name: 'Beta', key: 'beta', description: '' });
    expect(result).toEqual(flagRow);
    expect(flagOps.events).toEqual([
      {
        kind: 'flag.created',
        orgId: 'org-1',
        actorId: 'u1',
        flagId: 'f1',
        flagKey: 'beta',
        name: 'Beta',
      },
    ]);
  });

  it('propagates error when backfill throws inside the transaction', async () => {
    const flagRow = { id: 'f1', orgId: 'org-1', name: 'Beta', key: 'beta', description: '', createdAt: new Date(), createdByUserId: 'u1' };
    const db = makeServiceDb([
      [{ id: 'env-1' }],                          // queryOrgEnvironmentIds (thenable)
      [flagRow],                                    // insertFlag (returning)
      new Error('simulated backfill failure'),      // backfillFlagStatesForFlag (onConflictDoNothing)
    ]);
    const service = createDashboardService(db, makeNullFlagOps());
    await expect(
      service.createFlag('org-1', 'u1', { name: 'Beta', key: 'beta', description: '' }),
    ).rejects.toThrow('simulated backfill failure');
  });

  it('maps unique constraint error from insertFlag to ConflictError', async () => {
    const db = makeServiceDb([
      [{ id: 'env-1' }],                                                    // queryOrgEnvironmentIds (thenable)
      new Error('duplicate key value violates unique constraint "flags_key"'), // insertFlag (returning)
    ]);
    const service = createDashboardService(db, makeNullFlagOps());
    await expect(
      service.createFlag('org-1', 'u1', { name: 'Beta', key: 'beta', description: '' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws PreconditionError when no environments exist', async () => {
    const db = makeServiceDb([
      [], // queryOrgEnvironmentIds returns empty
    ]);
    const service = createDashboardService(db, makeNullFlagOps());
    await expect(
      service.createFlag('org-1', 'u1', { name: 'Beta', key: 'beta', description: '' }),
    ).rejects.toThrow('Create an environment before creating flags');
  });
});

describe('createDashboardService — updateEnvironmentOrigins dispatches env.origins_updated', () => {
  it('commits an env.origins_updated event so FlagOps evicts the SDK auth cache', async () => {
    const db = makeServiceDb([
      [{ id: 'env-1', orgId: 'org-1', allowedOrigins: ['https://example.com'] }], // updateEnvironmentOrigins (thenable)
    ]);

    const flagOps = makeNullFlagOps();
    const service = createDashboardService(db, flagOps);
    await service.updateEnvironmentOrigins('org-1', 'actor-1', 'env-1', ['https://example.com']);

    expect(flagOps.events).toEqual([
      {
        kind: 'env.origins_updated',
        orgId: 'org-1',
        actorId: 'actor-1',
        environmentId: 'env-1',
        allowedOrigins: ['https://example.com'],
      },
    ]);
  });

  it('throws NotFoundError and commits nothing when environment is not found', async () => {
    const db = makeServiceDb([
      [], // updateEnvironmentOrigins returns nothing — not found
    ]);

    const flagOps = makeNullFlagOps();
    const service = createDashboardService(db, flagOps);
    await expect(
      service.updateEnvironmentOrigins('org-1', 'actor-1', 'env-missing', ['https://example.com']),
    ).rejects.toThrow('Environment not found');
    expect(flagOps.events).toEqual([]);
  });
});
