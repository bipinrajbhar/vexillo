import { Hono } from 'hono';
import type { GetSession } from '../lib/session';
import type {
  DashboardService,
  OrgRow,
  NotFoundError,
  ConflictError,
  PreconditionError,
} from '../services/dashboard-service';

export type { GetSession } from '../lib/session';
export type { Session } from '../lib/session';

type Variables = {
  session: Awaited<ReturnType<GetSession>>;
  org: OrgRow;
  userRole: string;
};

function handleServiceError(
  err: unknown,
  c: { json: (body: unknown, status: number) => Response },
): Response | null {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === 'NOT_FOUND') return c.json({ error: err.message }, 404) as Response;
    if (code === 'CONFLICT') return c.json({ error: err.message }, 409) as Response;
    if (code === 'PRECONDITION') return c.json({ error: err.message }, 400) as Response;
  }
  return null;
}

export function createDashboardRouter(service: DashboardService, getSession: GetSession) {
  const router = new Hono<{ Variables: Variables }>();

  // Session auth middleware
  router.use('*', async (c, next) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('session', session);
    await next();
  });

  // GET /api/dashboard/me/orgs — list orgs the current user is a member of
  router.get('/me/orgs', async (c) => {
    const session = c.get('session')!;
    const orgs = await service.getMyOrgs(session.user.id);
    return c.json({ orgs });
  });

  // Org context middleware — resolves org from slug, verifies membership
  router.use('/:orgSlug/*', async (c, next) => {
    const session = c.get('session')!;
    const orgSlug = c.req.param('orgSlug');
    const ctx = await service.resolveOrgContext(orgSlug, session.user.id);

    if (!ctx) return c.json({ error: 'Organization not found' }, 404);
    if (ctx.org.status === 'suspended') return c.json({ error: 'Organization suspended' }, 403);
    if (!ctx.role) return c.json({ error: 'Not a member of this organization' }, 403);

    c.set('org', ctx.org);
    c.set('userRole', ctx.role);
    await next();
  });

  // ── Org context ───────────────────────────────────────────────────────────────

  router.get('/:orgSlug/context', (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    return c.json({ org: { id: org.id, name: org.name, slug: org.slug }, role: userRole });
  });

  // ── Flags ─────────────────────────────────────────────────────────────────────

  router.get('/:orgSlug/flags', async (c) => {
    const org = c.get('org');
    const result = await service.getFlagsWithStates(org.id);
    return c.json(result);
  });

  router.post('/:orgSlug/flags', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const name: string = body.name?.trim() ?? '';
    if (!name) return c.json({ error: 'Name is required' }, 400);

    try {
      const flag = await service.createFlag(org.id, {
        name,
        key: body.key?.trim(),
        description: body.description?.trim() ?? '',
      });
      return c.json({ flag }, 201);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.patch('/:orgSlug/flags/:key', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const key = c.req.param('key');
    const body = await c.req.json();
    const patch: { name?: string; description?: string } = {};
    if (body.name !== undefined) patch.name = body.name?.trim();
    if (body.description !== undefined) patch.description = body.description?.trim();

    if (Object.keys(patch).length === 0) return c.json({ error: 'No fields to update' }, 400);

    try {
      const flag = await service.updateFlag(org.id, key, patch);
      return c.json({ flag });
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.delete('/:orgSlug/flags/:key', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    try {
      await service.deleteFlag(org.id, c.req.param('key'));
      return c.body(null, 204);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.post('/:orgSlug/flags/:key/toggle', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const { environmentId } = await c.req.json();
    if (!environmentId) return c.json({ error: 'environmentId is required' }, 400);

    try {
      const result = await service.toggleFlag(org.id, c.req.param('key'), environmentId);
      return c.json(result);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  // ── Environments ──────────────────────────────────────────────────────────────

  router.get('/:orgSlug/environments', async (c) => {
    const org = c.get('org');
    const environments = await service.getEnvironments(org.id);
    return c.json({ environments });
  });

  router.post('/:orgSlug/environments', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const name: string = body.name?.trim() ?? '';
    if (!name) return c.json({ error: 'Name is required' }, 400);

    try {
      const result = await service.createEnvironment(org.id, name);
      return c.json(result, 201);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.patch('/:orgSlug/environments/:id', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    if (
      !Array.isArray(body.allowedOrigins) ||
      !body.allowedOrigins.every((o: unknown) => typeof o === 'string')
    ) {
      return c.json({ error: 'allowedOrigins must be an array of strings' }, 400);
    }

    try {
      const environment = await service.updateEnvironmentOrigins(
        org.id,
        c.req.param('id'),
        body.allowedOrigins,
      );
      return c.json({ environment });
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.delete('/:orgSlug/environments/:id', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    try {
      await service.deleteEnvironment(org.id, c.req.param('id'));
      return c.body(null, 204);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.post('/:orgSlug/environments/:id/rotate-key', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    try {
      const result = await service.rotateEnvironmentKey(org.id, c.req.param('id'));
      return c.json(result);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  // ── Members ───────────────────────────────────────────────────────────────────

  router.get('/:orgSlug/members', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);
    const members = await service.getMembers(org.id);
    return c.json({ members });
  });

  router.patch('/:orgSlug/members/:userId', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    try {
      const member = await service.updateMemberRole(org.id, c.req.param('userId'), body.role);
      return c.json({ member });
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.delete('/:orgSlug/members/:userId', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    try {
      await service.removeMember(org.id, c.req.param('userId'));
      return c.body(null, 204);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  // ── Invites ───────────────────────────────────────────────────────────────────

  router.post('/:orgSlug/invites', async (c) => {
    const org = c.get('org');
    const session = c.get('session')!;
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const email: string = body.email?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: 'Valid email is required' }, 400);
    }

    try {
      const invite = await service.createInvite(org.id, session.user.id, {
        email,
        role: body.role,
      });
      return c.json({ invite }, 201);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  router.get('/:orgSlug/invites', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);
    const invites = await service.getPendingInvites(org.id);
    return c.json({ invites });
  });

  router.delete('/:orgSlug/invites/:id', async (c) => {
    const org = c.get('org');
    if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    try {
      await service.revokeInvite(org.id, c.req.param('id'));
      return c.body(null, 204);
    } catch (err) {
      return handleServiceError(err, c) ?? (() => { throw err; })();
    }
  });

  return router;
}
