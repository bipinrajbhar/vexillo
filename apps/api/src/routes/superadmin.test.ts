import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createSuperAdminRouter } from './superadmin';
import type { GetSession, Session } from '../lib/session';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionError,
} from '../lib/domain-errors';
import type { SuperAdminService } from '../services/superadmin-service';

// The route's only job is auth-guarding super-admins, parsing JSON bodies, and
// mapping domain errors → HTTP status codes. Domain behavior (slug derivation,
// encryption, self-protection, etc.) is covered by the boundary tests in
// `services/superadmin-service.test.ts`. This file uses an in-memory stub
// service so the assertions stay focused on the HTTP boundary.

const SUPER_SESSION: Session = {
  user: { id: 'u-super', name: 'Super', email: 'super@x.com', isSuperAdmin: true },
};
const REGULAR_SESSION: Session = {
  user: { id: 'u-reg', name: 'Reg', email: 'reg@x.com', isSuperAdmin: false },
};

const noSession: GetSession = async () => null;
const superSession: GetSession = async () => SUPER_SESSION;
const regularSession: GetSession = async () => REGULAR_SESSION;

function stubService(overrides: Partial<SuperAdminService> = {}): SuperAdminService {
  const notImpl = async (): Promise<never> => {
    throw new Error('stubService method not implemented for this test');
  };
  return {
    listOrgs: notImpl as unknown as SuperAdminService['listOrgs'],
    createOrg: notImpl as unknown as SuperAdminService['createOrg'],
    getOrg: notImpl as unknown as SuperAdminService['getOrg'],
    updateOrg: notImpl as unknown as SuperAdminService['updateOrg'],
    suspendOrg: notImpl as unknown as SuperAdminService['suspendOrg'],
    unsuspendOrg: notImpl as unknown as SuperAdminService['unsuspendOrg'],
    deleteOrg: notImpl as unknown as SuperAdminService['deleteOrg'],
    listSuperAdminUsers:
      notImpl as unknown as SuperAdminService['listSuperAdminUsers'],
    setSuperAdminStatus:
      notImpl as unknown as SuperAdminService['setSuperAdminStatus'],
    ...overrides,
  };
}

function makeApp(svc: SuperAdminService, getSession: GetSession) {
  const app = new Hono();
  app.route('/api/superadmin', createSuperAdminRouter(svc, getSession));
  return app;
}

const BASE = 'http://localhost/api/superadmin';

// ── Auth middleware ──────────────────────────────────────────────────────────

describe('auth middleware', () => {
  it('returns 401 when no session', async () => {
    const app = makeApp(stubService(), noSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 403 for a non-super-admin session', async () => {
    const app = makeApp(stubService(), regularSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('lets super-admins through', async () => {
    const app = makeApp(stubService({ listOrgs: async () => [] }), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(200);
  });
});

// ── Domain error → HTTP status mapping ───────────────────────────────────────

describe('domain error mapping', () => {
  it('maps NotFoundError → 404', async () => {
    const app = makeApp(
      stubService({
        getOrg: async () => {
          throw new NotFoundError('Organization not found');
        },
      }),
      superSession,
    );
    const res = await app.fetch(new Request(`${BASE}/orgs/missing`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });

  it('maps ConflictError → 409', async () => {
    const app = makeApp(
      stubService({
        createOrg: async () => {
          throw new ConflictError('Slug already exists');
        },
      }),
      superSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme',
          oktaClientId: 'x',
          oktaClientSecret: 'y',
          oktaIssuer: 'z',
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Slug already exists' });
  });

  it('maps PreconditionError → 400', async () => {
    const app = makeApp(
      stubService({
        createOrg: async () => {
          throw new PreconditionError('Name is required');
        },
      }),
      superSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name is required' });
  });

  it('maps ForbiddenError → 403', async () => {
    const app = makeApp(
      stubService({
        deleteOrg: async () => {
          throw new ForbiddenError('Cannot delete your own organization');
        },
      }),
      superSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/orgs/acme`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Cannot delete your own organization',
    });
  });
});

// ── Happy-path response shapes ───────────────────────────────────────────────

describe('happy-path shapes', () => {
  it('GET /orgs returns the service result wrapped in { orgs }', async () => {
    const orgs = [
      { id: '1', name: 'Acme', slug: 'acme', status: 'active', createdAt: new Date() },
    ];
    const app = makeApp(stubService({ listOrgs: async () => orgs }), superSession);
    const res = await app.fetch(new Request(`${BASE}/orgs`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { orgs: unknown[] }).orgs).toHaveLength(1);
  });

  it('POST /orgs threads the session user id as actorId', async () => {
    let seenActor: string | undefined;
    const app = makeApp(
      stubService({
        createOrg: async (actorId, _input) => {
          seenActor = actorId;
          return {
            id: '1',
            name: 'Acme',
            slug: 'acme',
            status: 'active',
            oktaClientId: 'x',
            oktaClientSecret: 'plain',
            oktaIssuer: 'z',
            createdAt: new Date(),
          };
        },
      }),
      superSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme',
          oktaClientId: 'x',
          oktaClientSecret: 'y',
          oktaIssuer: 'z',
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(seenActor).toBe('u-super');
  });

  it('DELETE /orgs/:slug returns 204 and threads actorId', async () => {
    let seenActor: string | undefined;
    let seenSlug: string | undefined;
    const app = makeApp(
      stubService({
        deleteOrg: async (actorId, slug) => {
          seenActor = actorId;
          seenSlug = slug;
        },
      }),
      superSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/orgs/acme`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);
    expect(seenActor).toBe('u-super');
    expect(seenSlug).toBe('acme');
  });

  it('PATCH /users/:userId rejects non-boolean isSuperAdmin with 400', async () => {
    const app = makeApp(stubService(), superSession);
    const res = await app.fetch(
      new Request(`${BASE}/users/u-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSuperAdmin: 'yes' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'isSuperAdmin must be a boolean',
    });
  });

  it('PATCH /users/:userId threads actor + target ids', async () => {
    let seen: { actor?: string; userId?: string; isSuperAdmin?: boolean } = {};
    const app = makeApp(
      stubService({
        setSuperAdminStatus: async (actorId, userId, isSuperAdmin) => {
          seen = { actor: actorId, userId, isSuperAdmin };
          return { id: userId, email: 't@x.com', isSuperAdmin };
        },
      }),
      superSession,
    );
    const res = await app.fetch(
      new Request(`${BASE}/users/u-target`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isSuperAdmin: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ actor: 'u-super', userId: 'u-target', isSuperAdmin: true });
  });
});
