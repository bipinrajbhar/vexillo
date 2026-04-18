import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, asc, sql } from 'drizzle-orm';
import { apiKeys, environments, organizations, flags, flagStates } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey } from '../lib/api-key';

// CORS headers used on pre-env-lookup error responses (401, env-not-found 403).
// We use * here because we don't yet know the environment's allowedOrigins, but
// browsers still need to read the error body (e.g. to surface "Unauthorized").
const SDK_ERROR_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
} as const;

/**
 * Compute the CORS origin value to echo back for a successful response.
 *
 * Rules (matches security plan Phase 4):
 * - No `Origin` header → non-browser/server request; return '*' (harmless, SDK-friendly).
 * - `allowedOrigins` includes '*' → wildcard environment; return '*'.
 * - `allowedOrigins` includes the exact origin → return that origin.
 * - Otherwise → return null (caller must 403).
 */
function resolveAllowedOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: string[],
): string | null {
  if (!requestOrigin) return '*';
  if (allowedOrigins.includes('*')) return '*';
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return null;
}

// ── OpenAPI schemas ───────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi('Error');

const FlagSchema = z
  .object({ key: z.string(), enabled: z.boolean() })
  .openapi('Flag');

const FlagsResponseSchema = z
  .object({ flags: z.array(FlagSchema) })
  .openapi('FlagsResponse');

// ── Route definitions ─────────────────────────────────────────────────────────

const getFlagsRoute = createRoute({
  method: 'get',
  path: '/flags',
  operationId: 'getFlags',
  summary: 'Get feature flags for an environment',
  description:
    'Returns all flag states for the environment associated with the provided API key. ' +
    'Authentication is via `Authorization: Bearer <api-key>`.',
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: FlagsResponseSchema } },
      description: 'Flag states for the environment',
    },
    401: {
      content: { 'application/json': { schema: ErrorSchema } },
      description: 'Missing or invalid Bearer token',
    },
    403: {
      content: { 'application/json': { schema: ErrorSchema } },
      description:
        'API key valid but environment not found, org suspended, or Origin not in the allowlist',
    },
  },
});


// ── Router factory ────────────────────────────────────────────────────────────

export function createSdkRouter(db: DbClient) {
  const sdk = new OpenAPIHono();

  // Register Bearer auth security scheme so it appears in the generated spec.
  sdk.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });

  // Stream endpoint registered via registerPath (not openapi() wrapper) so that
  // the OpenAPI validation pipeline never touches the ReadableStream body.
  sdk.openAPIRegistry.registerPath({
    method: 'get',
    path: '/flags/stream',
    operationId: 'getFlagsStream',
    summary: 'Feature flag SSE stream',
    security: [{ BearerAuth: [] }],
    description:
      'Server-sent events stream. Sends the full flag snapshot as the first ' +
      '`data:` event, then emits `: keepalive` comments every 25 s. ' +
      'Auth mirrors the `/flags` endpoint.',
    responses: {
      200: {
        content: {
          'text/event-stream': {
            schema: z.string().openapi({ example: 'data: {"flags":[{"key":"my-flag","enabled":true}]}\n\n' }),
          },
        },
        description:
          'SSE stream. Content-Type: text/event-stream; Cache-Control: no-cache.',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Missing or invalid Bearer token',
      },
      403: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Org suspended or Origin not in the allowlist',
      },
    },
  });

  // Preflight — we can't check allowedOrigins without an API key, so we return
  // * here. The actual GET will enforce origin restrictions before returning data.
  sdk.options('*', (c) => {
    return c.body(null, 204, SDK_ERROR_CORS_HEADERS);
  });

  sdk.openapi(getFlagsRoute, async (c) => {
    const authHeader = c.req.header('authorization');
    const token =
      authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
    }

    const hash = await hashKey(token);

    const [apiKey] = await db
      .select({ environmentId: apiKeys.environmentId })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);

    if (!apiKey) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
    }

    const [env] = await db
      .select({
        id: environments.id,
        allowedOrigins: environments.allowedOrigins,
        orgStatus: organizations.status,
      })
      .from(environments)
      .innerJoin(organizations, eq(organizations.id, environments.orgId))
      .where(eq(environments.id, apiKey.environmentId))
      .limit(1);

    if (!env) {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    if (env.orgStatus === 'suspended') {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    // Enforce per-environment CORS allowlist.
    const requestOrigin = c.req.header('origin');
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, env.allowedOrigins);

    if (allowedOrigin === null) {
      // Origin is present but not in the allowlist — block the request.
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const rows = await db
      .select({
        key: flags.key,
        enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
      })
      .from(flags)
      .leftJoin(
        flagStates,
        and(
          eq(flagStates.flagId, flags.id),
          eq(flagStates.environmentId, apiKey.environmentId),
        ),
      )
      .orderBy(asc(flags.key));

    const headers = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
    };

    return c.json(
      { flags: rows.map((r) => ({ key: r.key, enabled: r.enabled })) },
      200,
      headers,
    );
  });

  sdk.get('/flags/stream', async (c) => {
    const authHeader = c.req.header('authorization');
    const token =
      authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
    }

    const hash = await hashKey(token);

    const [apiKey] = await db
      .select({ environmentId: apiKeys.environmentId })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);

    if (!apiKey) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
    }

    const [env] = await db
      .select({
        id: environments.id,
        allowedOrigins: environments.allowedOrigins,
        orgStatus: organizations.status,
      })
      .from(environments)
      .innerJoin(organizations, eq(organizations.id, environments.orgId))
      .where(eq(environments.id, apiKey.environmentId))
      .limit(1);

    if (!env) {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    if (env.orgStatus === 'suspended') {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const requestOrigin = c.req.header('origin');
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, env.allowedOrigins);

    if (allowedOrigin === null) {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const rows = await db
      .select({
        key: flags.key,
        enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
      })
      .from(flags)
      .leftJoin(
        flagStates,
        and(
          eq(flagStates.flagId, flags.id),
          eq(flagStates.environmentId, apiKey.environmentId),
        ),
      )
      .orderBy(asc(flags.key));

    const snapshot = JSON.stringify({
      flags: rows.map((r) => ({ key: r.key, enabled: r.enabled })),
    });

    const encoder = new TextEncoder();
    let keepaliveInterval: ReturnType<typeof setInterval>;

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${snapshot}\n\n`));

        keepaliveInterval = setInterval(() => {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        }, 25_000);

        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(keepaliveInterval);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        clearInterval(keepaliveInterval);
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    });
  });

  return sdk;
}

// OpenAPI document config — shared between index.ts and tests.
// Note: `components` (incl. securitySchemes) cannot go here; they are
// registered via openAPIRegistry inside createSdkRouter.
export const SDK_OPENAPI_CONFIG = {
  openapi: '3.0.0' as const,
  info: {
    title: 'Togglr SDK API',
    version: '1.0.0',
    description:
      'Feature flag SDK API. Authenticate via `Authorization: Bearer <api-key>`.',
  },
  servers: [{ url: '/api/sdk' }],
};
