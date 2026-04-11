import { Hono } from 'hono';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import {
  authUser,
  environments,
  flags,
  flagStates,
  apiKeys,
  organizations,
  organizationMembers,
} from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { generateApiKey, hashKey, maskKey } from '../lib/api-key';

export type Session = {
  user: {
    id: string;
    name: string;
    email: string;
    isSuperAdmin?: boolean | null;
  };
};

export type GetSession = (headers: Headers) => Promise<Session | null>;

type OrgRow = typeof organizations.$inferSelect;

type Variables = {
  session: Session;
  org: OrgRow;
  userRole: string;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createDashboardRouter(db: DbClient, getSession: GetSession) {
  const router = new Hono<{ Variables: Variables }>();

  // Session auth middleware — all dashboard routes require authentication
  router.use('*', async (c, next) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('session', session);
    await next();
  });

  // Org context middleware — resolves org from slug, verifies membership
  router.use('/:orgSlug/*', async (c, next) => {
    const session = c.get('session');
    const orgSlug = c.req.param('orgSlug');

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1);

    if (!org) return c.json({ error: 'Organization not found' }, 404);
    if (org.status === 'suspended') return c.json({ error: 'Organization suspended' }, 403);

    const [membership] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, org.id),
          eq(organizationMembers.userId, session.user.id),
        ),
      )
      .limit(1);

    if (!membership) return c.json({ error: 'Not a member of this organization' }, 403);

    c.set('org', org);
    c.set('userRole', membership.role);
    await next();
  });

  // ── Org context ──────────────────────────────────────────────────────────────

  // GET /api/dashboard/:orgSlug/context — org info + user role for web layout loader
  router.get('/:orgSlug/context', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    return c.json({
      org: { id: org.id, name: org.name, slug: org.slug },
      role: userRole,
    });
  });

  // ── Flags ────────────────────────────────────────────────────────────────────

  // GET /api/dashboard/:orgSlug/flags — list all flags with per-environment states
  router.get('/:orgSlug/flags', async (c) => {
    const org = c.get('org');

    const [rows, envRows] = await Promise.all([
      db
        .select({
          id: flags.id,
          name: flags.name,
          key: flags.key,
          description: flags.description,
          createdAt: flags.createdAt,
          envSlug: environments.slug,
          enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
        })
        .from(flags)
        .crossJoin(environments)
        .leftJoin(
          flagStates,
          and(
            eq(flagStates.flagId, flags.id),
            eq(flagStates.environmentId, environments.id),
          ),
        )
        .where(and(eq(flags.orgId, org.id), eq(environments.orgId, org.id)))
        .orderBy(desc(flags.createdAt), asc(environments.name)),

      db
        .select({ id: environments.id, name: environments.name, slug: environments.slug })
        .from(environments)
        .where(eq(environments.orgId, org.id))
        .orderBy(asc(environments.name)),
    ]);

    const flagMap = new Map<
      string,
      { id: string; name: string; key: string; description: string; createdAt: Date; states: Record<string, boolean> }
    >();

    for (const row of rows) {
      if (!flagMap.has(row.key)) {
        flagMap.set(row.key, {
          id: row.id,
          name: row.name,
          key: row.key,
          description: row.description,
          createdAt: row.createdAt,
          states: {},
        });
      }
      flagMap.get(row.key)!.states[row.envSlug] = row.enabled;
    }

    return c.json({ flags: Array.from(flagMap.values()), environments: envRows });
  });

  // POST /api/dashboard/:orgSlug/flags — create flag (admin only)
  router.post('/:orgSlug/flags', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const name: string = body.name?.trim() ?? '';
    const description: string = body.description?.trim() ?? '';
    const key: string = body.key?.trim() || slugify(name);

    if (!name) return c.json({ error: 'Name is required' }, 400);
    if (!key) return c.json({ error: 'Invalid key' }, 400);

    try {
      const envs = await db
        .select({ id: environments.id })
        .from(environments)
        .where(eq(environments.orgId, org.id));

      if (envs.length === 0) {
        return c.json({ error: 'Create an environment before creating flags' }, 400);
      }

      const [flag] = await db
        .insert(flags)
        .values({ orgId: org.id, name, key, description })
        .returning();

      await db
        .insert(flagStates)
        .values(envs.map((env) => ({ flagId: flag.id, environmentId: env.id, enabled: false })))
        .onConflictDoNothing();

      return c.json({ flag }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return c.json({ error: 'Flag key already exists' }, 409);
      }
      throw err;
    }
  });

  // PATCH /api/dashboard/:orgSlug/flags/:key — update flag name/description (admin only)
  router.patch('/:orgSlug/flags/:key', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const key = c.req.param('key');
    const body = await c.req.json();
    const name: string | undefined = body.name?.trim();
    const description: string | undefined = body.description?.trim();

    if (name !== undefined && !name) {
      return c.json({ error: 'Name cannot be empty' }, 400);
    }

    const updates: Partial<typeof flags.$inferInsert> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    const result = await db
      .update(flags)
      .set(updates)
      .where(and(eq(flags.key, key), eq(flags.orgId, org.id)))
      .returning();

    if (result.length === 0) return c.json({ error: 'Flag not found' }, 404);
    return c.json({ flag: result[0] });
  });

  // DELETE /api/dashboard/:orgSlug/flags/:key — delete flag and all its states (admin only)
  router.delete('/:orgSlug/flags/:key', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const key = c.req.param('key');
    const result = await db
      .delete(flags)
      .where(and(eq(flags.key, key), eq(flags.orgId, org.id)))
      .returning({ id: flags.id });

    if (result.length === 0) return c.json({ error: 'Flag not found' }, 404);
    return c.body(null, 204);
  });

  // POST /api/dashboard/:orgSlug/flags/:key/toggle — toggle flag per environment (admin only)
  router.post('/:orgSlug/flags/:key/toggle', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const key = c.req.param('key');
    const { environmentId } = await c.req.json();
    if (!environmentId) return c.json({ error: 'environmentId is required' }, 400);

    const [flag] = await db
      .select({ id: flags.id })
      .from(flags)
      .where(and(eq(flags.key, key), eq(flags.orgId, org.id)));

    if (!flag) return c.json({ error: 'Flag not found' }, 404);

    const [state] = await db
      .insert(flagStates)
      .values({ flagId: flag.id, environmentId, enabled: true })
      .onConflictDoUpdate({
        target: [flagStates.flagId, flagStates.environmentId],
        set: { enabled: sql`NOT ${flagStates.enabled}` },
      })
      .returning({ enabled: flagStates.enabled });

    return c.json({ enabled: state.enabled });
  });

  // ── Environments ─────────────────────────────────────────────────────────────

  // GET /api/dashboard/:orgSlug/environments — list environments with API key hints
  router.get('/:orgSlug/environments', async (c) => {
    const org = c.get('org');

    const envRows = await db
      .select({
        id: environments.id,
        name: environments.name,
        slug: environments.slug,
        allowedOrigins: environments.allowedOrigins,
        createdAt: environments.createdAt,
        keyHint: apiKeys.keyHint,
      })
      .from(environments)
      .leftJoin(apiKeys, eq(apiKeys.environmentId, environments.id))
      .where(eq(environments.orgId, org.id))
      .orderBy(asc(environments.name));

    return c.json({ environments: envRows });
  });

  // POST /api/dashboard/:orgSlug/environments — create environment (admin only)
  router.post('/:orgSlug/environments', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const name: string = body.name?.trim() ?? '';
    if (!name) return c.json({ error: 'Name is required' }, 400);

    const slug = slugify(name);
    if (!slug) return c.json({ error: 'Invalid name' }, 400);

    const rawKey = generateApiKey();
    const keyHash = await hashKey(rawKey);
    const keyHint = maskKey(rawKey);

    let env: typeof environments.$inferSelect;

    try {
      [env] = await db.insert(environments).values({ orgId: org.id, name, slug }).returning();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return c.json({ error: 'Environment name already exists' }, 409);
      }
      return c.json({ error: msg || 'Failed to create environment' }, 500);
    }

    try {
      await db.insert(apiKeys).values({ environmentId: env.id, keyHash, keyHint });

      const existingFlags = await db
        .select({ id: flags.id })
        .from(flags)
        .where(eq(flags.orgId, org.id));

      if (existingFlags.length > 0) {
        await db
          .insert(flagStates)
          .values(existingFlags.map((f) => ({ flagId: f.id, environmentId: env.id, enabled: false })))
          .onConflictDoNothing();
      }
    } catch (err: unknown) {
      await db.delete(environments).where(eq(environments.id, env.id));
      const msg = err instanceof Error ? err.message : '';
      return c.json({ error: msg || 'Failed to create environment' }, 500);
    }

    return c.json({ environment: env, apiKey: rawKey }, 201);
  });

  // PATCH /api/dashboard/:orgSlug/environments/:id — update allowedOrigins (admin only)
  router.patch('/:orgSlug/environments/:id', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const body = await c.req.json();

    if (
      !Array.isArray(body.allowedOrigins) ||
      !body.allowedOrigins.every((o: unknown) => typeof o === 'string')
    ) {
      return c.json({ error: 'allowedOrigins must be an array of strings' }, 400);
    }

    const result = await db
      .update(environments)
      .set({ allowedOrigins: body.allowedOrigins })
      .where(and(eq(environments.id, id), eq(environments.orgId, org.id)))
      .returning({ id: environments.id, allowedOrigins: environments.allowedOrigins });

    if (result.length === 0) return c.json({ error: 'Environment not found' }, 404);
    return c.json({ environment: result[0] });
  });

  // DELETE /api/dashboard/:orgSlug/environments/:id — delete environment (admin only)
  router.delete('/:orgSlug/environments/:id', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const result = await db
      .delete(environments)
      .where(and(eq(environments.id, id), eq(environments.orgId, org.id)))
      .returning({ id: environments.id });

    if (result.length === 0) return c.json({ error: 'Environment not found' }, 404);
    return c.body(null, 204);
  });

  // POST /api/dashboard/:orgSlug/environments/:id/rotate-key — rotate API key (admin only)
  router.post('/:orgSlug/environments/:id/rotate-key', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const [env] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.id, id), eq(environments.orgId, org.id)));

    if (!env) return c.json({ error: 'Environment not found' }, 404);

    const rawKey = generateApiKey();
    const keyHash = await hashKey(rawKey);
    const keyHint = maskKey(rawKey);

    await db.delete(apiKeys).where(eq(apiKeys.environmentId, id));
    await db.insert(apiKeys).values({ environmentId: id, keyHash, keyHint });

    return c.json({ apiKey: rawKey });
  });

  // ── Members ──────────────────────────────────────────────────────────────────

  // GET /api/dashboard/:orgSlug/members — list org members (admin only)
  router.get('/:orgSlug/members', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const members = await db
      .select({
        id: authUser.id,
        name: authUser.name,
        email: authUser.email,
        role: organizationMembers.role,
        createdAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(authUser, eq(authUser.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, org.id))
      .orderBy(asc(organizationMembers.createdAt));

    return c.json({ members });
  });

  // PATCH /api/dashboard/:orgSlug/members/:userId — change org member role (admin only)
  router.patch('/:orgSlug/members/:userId', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const userId = c.req.param('userId');
    const body = await c.req.json();
    const role: string = body.role;

    if (role !== 'admin' && role !== 'viewer') {
      return c.json({ error: 'Role must be admin or viewer' }, 400);
    }

    if (role === 'viewer') {
      const admins = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, org.id),
            eq(organizationMembers.role, 'admin'),
          ),
        );
      const otherAdmins = admins.filter((a) => a.userId !== userId);
      if (otherAdmins.length === 0) {
        return c.json({ error: 'Cannot demote the last admin' }, 409);
      }
    }

    const result = await db
      .update(organizationMembers)
      .set({ role })
      .where(
        and(
          eq(organizationMembers.orgId, org.id),
          eq(organizationMembers.userId, userId),
        ),
      )
      .returning({ userId: organizationMembers.userId, role: organizationMembers.role });

    if (result.length === 0) return c.json({ error: 'Member not found' }, 404);
    return c.json({ member: result[0] });
  });

  // DELETE /api/dashboard/:orgSlug/members/:userId — remove member from org (admin only)
  router.delete('/:orgSlug/members/:userId', async (c) => {
    const org = c.get('org');
    const userRole = c.get('userRole');
    if (userRole !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const userId = c.req.param('userId');

    const [membership] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, org.id),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!membership) return c.json({ error: 'Member not found' }, 404);

    if (membership.role === 'admin') {
      const admins = await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, org.id),
            eq(organizationMembers.role, 'admin'),
          ),
        );
      if (admins.length <= 1) {
        return c.json({ error: 'Cannot remove the last admin' }, 409);
      }
    }

    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, org.id),
          eq(organizationMembers.userId, userId),
        ),
      );

    return c.body(null, 204);
  });

  return router;
}
