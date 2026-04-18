import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, asc, sql } from 'drizzle-orm';
import { apiKeys, environments, organizations, flags, flagStates, queryEnvironmentFlagStates } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey } from '../lib/api-key';
import type { StreamRegistry } from '../lib/stream-registry';
import type { AuthCache } from '../lib/auth-cache';
import type { SnapshotCache } from '../lib/snapshot-cache';

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

export function createSdkRouter(
  db: DbClient,
  streamRegistry?: StreamRegistry,
  authCache?: AuthCache,
  snapshotCache?: SnapshotCache,
) {
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

    let auth = authCache?.get(hash) ?? null;
    if (!auth) {
      const [row] = await db
        .select({
          environmentId: apiKeys.environmentId,
          orgId: environments.orgId,
          allowedOrigins: environments.allowedOrigins,
          orgStatus: organizations.status,
        })
        .from(apiKeys)
        .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
        .innerJoin(organizations, eq(organizations.id, environments.orgId))
        .where(eq(apiKeys.keyHash, hash))
        .limit(1);

      if (!row) {
        return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
      }
      auth = row;
      authCache?.set(hash, auth);
    }

    if (auth.orgStatus === 'suspended') {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const requestOrigin = c.req.header('origin');
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, auth.allowedOrigins);

    if (allowedOrigin === null) {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const flagRows = await queryEnvironmentFlagStates(db, auth.orgId, auth.environmentId);

    const headers = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Cache-Control': 'no-store',
    };

    return c.json(
      { flags: flagRows.map((r) => ({ key: r.key, enabled: r.enabled })) },
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

    // Auth: in-memory cache → single combined DB round-trip on miss.
    let auth = authCache?.get(hash) ?? null;
    if (!auth) {
      const [row] = await db
        .select({
          environmentId: apiKeys.environmentId,
          orgId: environments.orgId,
          allowedOrigins: environments.allowedOrigins,
          orgStatus: organizations.status,
        })
        .from(apiKeys)
        .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
        .innerJoin(organizations, eq(organizations.id, environments.orgId))
        .where(eq(apiKeys.keyHash, hash))
        .limit(1);

      if (!row) {
        return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
      }
      auth = row;
      authCache?.set(hash, auth);
    }

    if (auth.orgStatus === 'suspended') {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const requestOrigin = c.req.header('origin');
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, auth.allowedOrigins);

    if (allowedOrigin === null) {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    // Snapshot: cache is written on every flag toggle; DB only on cold miss.
    let snapshot = snapshotCache?.get(auth.environmentId) ?? null;
    if (!snapshot) {
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
            eq(flagStates.environmentId, auth.environmentId),
          ),
        )
        .orderBy(asc(flags.key));

      snapshot = JSON.stringify({
        flags: rows.map((r) => ({ key: r.key, enabled: r.enabled })),
      });
      snapshotCache?.set(auth.environmentId, snapshot);
    }

    const encoder = new TextEncoder();

    // Use TransformStream + pull-based wrapper — the same pattern Hono's
    // streamSSE uses internally. A push-only ReadableStream (start() + no pull())
    // causes Bun to consider the response done after the first chunk is consumed,
    // so subsequent enqueues (keepalive, Redis snapshots) close the connection.
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const tsReader = readable.getReader();

    let keepaliveInterval: ReturnType<typeof setInterval> | undefined;
    let unregisterStream: (() => void) | undefined;
    let closed = false;
    let eventId = 1;

    // Continue the ID sequence if the client is reconnecting.
    const lastEventIdHeader = c.req.header('last-event-id');
    if (lastEventIdHeader) {
      const parsed = parseInt(lastEventIdHeader, 10);
      if (!isNaN(parsed)) eventId = parsed + 1;
    }

    function buildEvent(data: string, retryMs?: number): Uint8Array {
      let msg = retryMs !== undefined ? `retry: ${retryMs}\n` : '';
      msg += `id: ${eventId++}\n`;
      msg += `data: ${data}\n\n`;
      return encoder.encode(msg);
    }

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(keepaliveInterval);
      unregisterStream?.();
      writer.close().catch(() => {});
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await tsReader.read();
        done ? controller.close() : controller.enqueue(value);
      },
      cancel: cleanup,
    });

    // Send initial snapshot with retry hint so clients know the preferred
    // reconnect delay without waiting for a failed attempt.
    await writer.write(buildEvent(snapshot, 1000));

    if (streamRegistry) {
      unregisterStream = streamRegistry.register(auth.environmentId, (payload) => {
        writer.write(buildEvent(payload)).catch(() => {});
      });
    }

    keepaliveInterval = setInterval(() => {
      writer.write(encoder.encode(': keepalive\n\n')).catch(() => {});
    }, 25_000);

    c.req.raw.signal.addEventListener('abort', cleanup);

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
//
// APP_URL controls the server origin shown in Scalar's "Try it out" panel.
// Set it to the CloudFront domain in production so requests hit AWS directly.
// Falls back to a relative path so local dev works without configuration.
const appUrl = process.env.APP_URL?.replace(/\/$/, '') ?? '';

export const SDK_OPENAPI_CONFIG = {
  openapi: '3.0.0' as const,
  info: {
    title: 'Togglr SDK API',
    version: '1.0.0',
    description:
      'Feature flag SDK API. Authenticate via `Authorization: Bearer <api-key>`.',
  },
  servers: [{ url: `${appUrl}/api/sdk` }],
};
