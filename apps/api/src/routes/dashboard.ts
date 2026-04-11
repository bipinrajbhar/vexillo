import { Hono } from 'hono';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import {
  authUser,
  environments,
  flags,
  flagStates,
  apiKeys,
} from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { generateApiKey, hashKey, maskKey } from '../lib/api-key';

// Minimal session shape needed by dashboard routes.
// role is string | null | undefined because BetterAuth additionalFields can be absent.
export type Session = {
  user: {
    id: string;
    name: string;
    email: string;
    role: string | null | undefined;
  };
};

export type GetSession = (headers: Headers) => Promise<Session | null>;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type Variables = { session: Session };

export function createDashboardRouter(db: DbClient, getSession: GetSession) {
  const router = new Hono<{ Variables: Variables }>();

  // Session auth middleware — all dashboard routes require authentication
  router.use('*', async (c, next) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('session', session);
    await next();
  });

  // ── Flags ────────────────────────────────────────────────────────────────

  // GET /api/dashboard/flags — list all flags with per-environment states
  router.get('/flags', async (c) => {
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
        .orderBy(desc(flags.createdAt), asc(environments.name)),

      db
        .select({ id: environments.id, name: environments.name, slug: environments.slug })
        .from(environments)
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

  // POST /api/dashboard/flags — create flag (admin only)
  router.post('/flags', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const name: string = body.name?.trim() ?? '';
    const description: string = body.description?.trim() ?? '';
    const key: string = body.key?.trim() || slugify(name);

    if (!name) return c.json({ error: 'Name is required' }, 400);
    if (!key) return c.json({ error: 'Invalid key' }, 400);

    try {
      const [flag] = await db.insert(flags).values({ name, key, description }).returning();

      const envs = await db.select({ id: environments.id }).from(environments);
      if (envs.length > 0) {
        await db
          .insert(flagStates)
          .values(envs.map((env) => ({ flagId: flag.id, environmentId: env.id, enabled: false })))
          .onConflictDoNothing();
      }

      return c.json({ flag }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return c.json({ error: 'Flag key already exists' }, 409);
      }
      throw err;
    }
  });

  // PATCH /api/dashboard/flags/:key — update flag name/description (admin only)
  router.patch('/flags/:key', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

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

    const result = await db.update(flags).set(updates).where(eq(flags.key, key)).returning();

    if (result.length === 0) return c.json({ error: 'Flag not found' }, 404);
    return c.json({ flag: result[0] });
  });

  // POST /api/dashboard/flags/:key/toggle — toggle flag per environment (admin only)
  router.post('/flags/:key/toggle', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const key = c.req.param('key');
    const { environmentId } = await c.req.json();

    if (!environmentId) return c.json({ error: 'environmentId is required' }, 400);

    const [flag] = await db.select({ id: flags.id }).from(flags).where(eq(flags.key, key));
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

  // ── Environments ─────────────────────────────────────────────────────────

  // GET /api/dashboard/environments — list environments with API key hints
  router.get('/environments', async (c) => {
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
      .orderBy(asc(environments.name));

    return c.json({ environments: envRows });
  });

  // POST /api/dashboard/environments — create environment (admin only)
  router.post('/environments', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

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
      [env] = await db.insert(environments).values({ name, slug }).returning();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return c.json({ error: 'Environment name already exists' }, 409);
      }
      return c.json({ error: msg || 'Failed to create environment' }, 500);
    }

    try {
      await db.insert(apiKeys).values({ environmentId: env.id, keyHash, keyHint });

      const existingFlags = await db.select({ id: flags.id }).from(flags);
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

  // PATCH /api/dashboard/environments/:id — update allowedOrigins (admin only)
  router.patch('/environments/:id', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

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
      .where(eq(environments.id, id))
      .returning({ id: environments.id, allowedOrigins: environments.allowedOrigins });

    if (result.length === 0) return c.json({ error: 'Environment not found' }, 404);
    return c.json({ environment: result[0] });
  });

  // DELETE /api/dashboard/environments/:id — delete environment (admin only)
  router.delete('/environments/:id', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');

    const result = await db
      .delete(environments)
      .where(eq(environments.id, id))
      .returning({ id: environments.id });

    if (result.length === 0) return c.json({ error: 'Environment not found' }, 404);
    return c.body(null, 204);
  });

  // POST /api/dashboard/environments/:id/rotate-key — rotate API key (admin only)
  router.post('/environments/:id/rotate-key', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');

    const [env] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.id, id));

    if (!env) return c.json({ error: 'Environment not found' }, 404);

    const rawKey = generateApiKey();
    const keyHash = await hashKey(rawKey);
    const keyHint = maskKey(rawKey);

    await db.delete(apiKeys).where(eq(apiKeys.environmentId, id));
    await db.insert(apiKeys).values({ environmentId: id, keyHash, keyHint });

    return c.json({ apiKey: rawKey });
  });

  // ── Members ──────────────────────────────────────────────────────────────

  // GET /api/dashboard/members — list all members (admin only)
  router.get('/members', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const members = await db
      .select({
        id: authUser.id,
        name: authUser.name,
        email: authUser.email,
        role: authUser.role,
        createdAt: authUser.createdAt,
      })
      .from(authUser)
      .orderBy(asc(authUser.createdAt));

    return c.json({ members });
  });

  // PATCH /api/dashboard/members/:id — change member role (admin only)
  router.patch('/members/:id', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');
    const body = await c.req.json();
    const role: string = body.role;

    if (role !== 'admin' && role !== 'viewer') {
      return c.json({ error: 'Role must be admin or viewer' }, 400);
    }

    const result = await db
      .update(authUser)
      .set({ role })
      .where(eq(authUser.id, id))
      .returning({ id: authUser.id, role: authUser.role });

    if (result.length === 0) return c.json({ error: 'Member not found' }, 404);
    return c.json({ member: result[0] });
  });

  // DELETE /api/dashboard/members/:id — remove member (admin only)
  router.delete('/members/:id', async (c) => {
    const session = c.get('session');
    if (session.user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);

    const id = c.req.param('id');

    const result = await db
      .delete(authUser)
      .where(eq(authUser.id, id))
      .returning({ id: authUser.id });

    if (result.length === 0) return c.json({ error: 'Member not found' }, 404);
    return c.body(null, 204);
  });

  return router;
}
