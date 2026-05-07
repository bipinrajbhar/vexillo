import { Hono } from 'hono';
import type { Context } from 'hono';
import type { GetSession, Session } from '../lib/session';
import type { SuperAdminService } from '../services/superadmin-service';
import { handleServiceError } from '../lib/domain-errors';

type Variables = {
  session: Session;
};

// Routes funnel domain errors through this — known codes map to HTTP status,
// anything else propagates to Hono's default error handler.
function handleOrThrow(c: Context, err: unknown): Response {
  const mapped = handleServiceError(err, c);
  if (mapped) return mapped;
  throw err;
}

export function createSuperAdminRouter(service: SuperAdminService, getSession: GetSession) {
  const router = new Hono<{ Variables: Variables }>();

  // Auth + super-admin guard — all routes require isSuperAdmin = true
  router.use('*', async (c, next) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!session.user.isSuperAdmin) return c.json({ error: 'Forbidden' }, 403);
    c.set('session', session);
    await next();
  });

  // ── Organizations ────────────────────────────────────────────────────────────

  router.get('/orgs', async (c) => {
    const orgs = await service.listOrgs();
    return c.json({ orgs });
  });

  router.post('/orgs', async (c) => {
    const session = c.get('session');
    const body = await c.req.json();
    try {
      const org = await service.createOrg(session.user.id, {
        name: body.name ?? '',
        slug: body.slug,
        oktaClientId: body.oktaClientId ?? '',
        oktaClientSecret: body.oktaClientSecret ?? '',
        oktaIssuer: body.oktaIssuer ?? '',
      });
      return c.json({ org }, 201);
    } catch (err) {
      return handleOrThrow(c, err);
    }
  });

  router.get('/orgs/:slug', async (c) => {
    try {
      const org = await service.getOrg(c.req.param('slug'));
      return c.json({ org });
    } catch (err) {
      return handleOrThrow(c, err);
    }
  });

  router.patch('/orgs/:slug', async (c) => {
    const body = await c.req.json();
    try {
      const org = await service.updateOrg(c.req.param('slug'), {
        name: body.name,
        oktaClientId: body.oktaClientId,
        oktaClientSecret: body.oktaClientSecret,
        oktaIssuer: body.oktaIssuer,
      });
      return c.json({ org });
    } catch (err) {
      return handleOrThrow(c, err);
    }
  });

  router.post('/orgs/:slug/suspend', async (c) => {
    try {
      const result = await service.suspendOrg(c.req.param('slug'));
      return c.json(result);
    } catch (err) {
      return handleOrThrow(c, err);
    }
  });

  router.post('/orgs/:slug/unsuspend', async (c) => {
    try {
      const result = await service.unsuspendOrg(c.req.param('slug'));
      return c.json(result);
    } catch (err) {
      return handleOrThrow(c, err);
    }
  });

  router.delete('/orgs/:slug', async (c) => {
    try {
      await service.deleteOrg(c.get('session').user.id, c.req.param('slug'));
      return c.body(null, 204);
    } catch (err) {
      return handleOrThrow(c, err);
    }
  });

  // ── Users ────────────────────────────────────────────────────────────────────

  router.get('/users', async (c) => {
    const users = await service.listSuperAdminUsers();
    return c.json({ users });
  });

  router.patch('/users/:userId', async (c) => {
    const body = await c.req.json();
    if (typeof body.isSuperAdmin !== 'boolean') {
      return c.json({ error: 'isSuperAdmin must be a boolean' }, 400);
    }
    try {
      const user = await service.setSuperAdminStatus(
        c.get('session').user.id,
        c.req.param('userId'),
        body.isSuperAdmin,
      );
      return c.json({ user });
    } catch (err) {
      return handleOrThrow(c, err);
    }
  });

  return router;
}
