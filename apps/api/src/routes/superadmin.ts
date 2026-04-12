import { Hono } from 'hono';
import { eq, desc, count } from 'drizzle-orm';
import { organizations, organizationMembers, authUser } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import type { GetSession, Session } from '../lib/session';

type Variables = {
  session: Session;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createSuperAdminRouter(db: DbClient, getSession: GetSession) {
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

  // GET /api/superadmin/orgs — list all organizations
  router.get('/orgs', async (c) => {
    const orgs = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .orderBy(desc(organizations.createdAt));
    return c.json({ orgs });
  });

  // POST /api/superadmin/orgs — create organization
  router.post('/orgs', async (c) => {
    const body = await c.req.json();
    const name: string = body.name?.trim() ?? '';
    const slug: string = body.slug?.trim() || slugify(name);
    const oktaClientId: string = body.oktaClientId?.trim() ?? '';
    const oktaClientSecret: string = body.oktaClientSecret?.trim() ?? '';
    const oktaIssuer: string = body.oktaIssuer?.trim() ?? '';

    if (!name) return c.json({ error: 'Name is required' }, 400);
    if (!slug) return c.json({ error: 'Slug is required' }, 400);
    if (!oktaClientId) return c.json({ error: 'oktaClientId is required' }, 400);
    if (!oktaClientSecret) return c.json({ error: 'oktaClientSecret is required' }, 400);
    if (!oktaIssuer) return c.json({ error: 'oktaIssuer is required' }, 400);

    try {
      const [org] = await db
        .insert(organizations)
        .values({ name, slug, oktaClientId, oktaClientSecret, oktaIssuer })
        .returning();
      return c.json({ org }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return c.json({ error: 'Slug already exists' }, 409);
      }
      throw err;
    }
  });

  // GET /api/superadmin/orgs/:slug — get org detail with member count
  router.get('/orgs/:slug', async (c) => {
    const slug = c.req.param('slug');
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (!org) return c.json({ error: 'Organization not found' }, 404);

    const [countRow] = await db
      .select({ memberCount: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, org.id));

    return c.json({ org: { ...org, memberCount: countRow?.memberCount ?? 0 } });
  });

  // PATCH /api/superadmin/orgs/:slug — update org name, slug, or Okta config
  router.patch('/orgs/:slug', async (c) => {
    const slug = c.req.param('slug');
    const body = await c.req.json();

    const updates: Partial<typeof organizations.$inferInsert> = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.slug !== undefined) updates.slug = body.slug.trim();
    if (body.oktaClientId !== undefined) updates.oktaClientId = body.oktaClientId.trim();
    if (body.oktaClientSecret !== undefined) updates.oktaClientSecret = body.oktaClientSecret.trim();
    if (body.oktaIssuer !== undefined) updates.oktaIssuer = body.oktaIssuer.trim();

    if (updates.name === '') return c.json({ error: 'Name cannot be empty' }, 400);
    if (updates.slug === '') return c.json({ error: 'Slug cannot be empty' }, 400);
    if (Object.keys(updates).length === 0) return c.json({ error: 'No fields to update' }, 400);

    try {
      const result = await db
        .update(organizations)
        .set(updates)
        .where(eq(organizations.slug, slug))
        .returning();
      if (result.length === 0) return c.json({ error: 'Organization not found' }, 404);
      return c.json({ org: result[0] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return c.json({ error: 'Slug already exists' }, 409);
      }
      throw err;
    }
  });

  // POST /api/superadmin/orgs/:slug/suspend — set status to 'suspended'
  router.post('/orgs/:slug/suspend', async (c) => {
    const slug = c.req.param('slug');
    const result = await db
      .update(organizations)
      .set({ status: 'suspended' })
      .where(eq(organizations.slug, slug))
      .returning({ id: organizations.id, status: organizations.status });
    if (result.length === 0) return c.json({ error: 'Organization not found' }, 404);
    return c.json({ status: result[0].status });
  });

  // POST /api/superadmin/orgs/:slug/unsuspend — set status to 'active'
  router.post('/orgs/:slug/unsuspend', async (c) => {
    const slug = c.req.param('slug');
    const result = await db
      .update(organizations)
      .set({ status: 'active' })
      .where(eq(organizations.slug, slug))
      .returning({ id: organizations.id, status: organizations.status });
    if (result.length === 0) return c.json({ error: 'Organization not found' }, 404);
    return c.json({ status: result[0].status });
  });

  // DELETE /api/superadmin/orgs/:slug — permanently delete org (cascades to all data)
  router.delete('/orgs/:slug', async (c) => {
    const slug = c.req.param('slug');
    const result = await db
      .delete(organizations)
      .where(eq(organizations.slug, slug))
      .returning({ id: organizations.id });
    if (result.length === 0) return c.json({ error: 'Organization not found' }, 404);
    return c.body(null, 204);
  });

  // ── Users ────────────────────────────────────────────────────────────────────

  // GET /api/superadmin/users — list all super admin users
  router.get('/users', async (c) => {
    const users = await db
      .select({
        id: authUser.id,
        name: authUser.name,
        email: authUser.email,
        createdAt: authUser.createdAt,
      })
      .from(authUser)
      .where(eq(authUser.isSuperAdmin, true))
      .orderBy(authUser.email);
    return c.json({ users });
  });

  // PATCH /api/superadmin/users/:userId — promote or demote a user's super admin status
  router.patch('/users/:userId', async (c) => {
    const session = c.get('session');
    const userId = c.req.param('userId');
    const body = await c.req.json();

    if (typeof body.isSuperAdmin !== 'boolean') {
      return c.json({ error: 'isSuperAdmin must be a boolean' }, 400);
    }

    // Prevent self-demotion
    if (userId === session.user.id && !body.isSuperAdmin) {
      return c.json({ error: 'Cannot demote yourself' }, 400);
    }

    const result = await db
      .update(authUser)
      .set({ isSuperAdmin: body.isSuperAdmin })
      .where(eq(authUser.id, userId))
      .returning({
        id: authUser.id,
        email: authUser.email,
        isSuperAdmin: authUser.isSuperAdmin,
      });

    if (result.length === 0) return c.json({ error: 'User not found' }, 404);
    return c.json({ user: result[0] });
  });

  return router;
}
