import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { apiKeys, environments, organizations, queryEnvironmentFlagStates } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey } from '../lib/api-key';
import { createSnapshotCache } from '../lib/snapshot-cache';
import { evaluateCountryRule } from '../lib/evaluate-country-rule';
import type { StreamRegistry } from '../lib/stream-registry';
import type { AuthCache, AuthEntry } from '../lib/auth-cache';
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

// Parses the raw snapshot (which includes allowedCountries) and returns a
// client-safe JSON string with geo-evaluated enabled values.
function evaluateSnapshot(
  snapshot: string,
  countryCode: string | null,
): string {
  const { flags } = JSON.parse(snapshot) as {
    flags: Array<{ key: string; enabled: boolean; allowedCountries?: string[] }>;
  };
  return JSON.stringify({
    flags: flags.map((r) => ({
      key: r.key,
      enabled: evaluateCountryRule({
        allowedCountries: r.allowedCountries ?? [],
        countryCode,
        envEnabled: r.enabled,
      }),
    })),
  });
}

// Resolves auth using the raw token as the in-memory cache key (avoids an
// async SHA-256 on every cache hit — hash is only computed on DB miss).
// Stale entries are served immediately; a background refresh prevents TTL
// expiry from causing a synchronous latency spike.
async function resolveAuth(
  db: DbClient,
  token: string,
  authCache: AuthCache | undefined,
): Promise<AuthEntry | null> {
  const cached = authCache?.get(token) ?? null;
  if (cached) {
    if (authCache?.isStale(token)) {
      hashKey(token)
        .then((hash) =>
          db
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
            .limit(1),
        )
        .then(([row]) => {
          if (row) authCache!.set(token, row);
        })
        .catch(() => {});
    }
    return cached;
  }
  const hash = await hashKey(token);
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
  if (!row) return null;
  authCache?.set(token, row);
  return row;
}

// Returns the raw flag snapshot for an environment (JSON string including
// allowedCountries for geo evaluation). Uses snapshotCache as the source of
// truth — it is updated on every flag toggle via notifyFlagChange, so DB is
// only hit on a cold miss. Stale entries are served immediately with a
// background refresh so TTL expiry never causes a synchronous latency spike.
async function resolveRawSnapshot(
  db: DbClient,
  orgId: string,
  environmentId: string,
  snapshotCache: SnapshotCache,
): Promise<string> {
  const cached = snapshotCache.get(environmentId);
  if (cached) {
    if (snapshotCache.isStale(environmentId)) {
      queryEnvironmentFlagStates(db, orgId, environmentId)
        .then((rows) => {
          snapshotCache.set(environmentId, JSON.stringify({ flags: rows }));
        })
        .catch(() => {});
    }
    return cached;
  }
  const rows = await queryEnvironmentFlagStates(db, orgId, environmentId);
  const snapshot = JSON.stringify({ flags: rows });
  snapshotCache.set(environmentId, snapshot);
  return snapshot;
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
    'Authentication is via `Authorization: Bearer <api-key>`. ' +
    'Pass `CloudFront-Viewer-Country` (ISO 3166-1 alpha-2, e.g. `US`) to get ' +
    'geo-targeted flag states; omit to fall back to the environment toggle.',
  security: [{ BearerAuth: [] }],
  request: {
    headers: z.object({
      'cloudfront-viewer-country': z
        .string()
        .length(2)
        .optional()
        .openapi({
          description: 'ISO 3166-1 alpha-2 country code. Injected by CloudFront in production; pass manually in dev/Scalar.',
          example: 'US',
        }),
    }),
  },
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
  // Default internal cache when none is injected (e.g. in tests). Production
  // passes in a shared instance so the cache is invalidated by notifyFlagChange.
  const _snapshotCache = snapshotCache ?? createSnapshotCache();

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

    const auth = await resolveAuth(db, token, authCache);
    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
    }

    if (auth.orgStatus === 'suspended') {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const requestOrigin = c.req.header('origin');
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, auth.allowedOrigins);

    if (allowedOrigin === null) {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    // CloudFront injects this header; absent in local dev and CI → falls back to envEnabled.
    const countryCode = c.req.header('cloudfront-viewer-country') ?? null;

    const rawSnapshot = await resolveRawSnapshot(db, auth.orgId, auth.environmentId, _snapshotCache);
    const snapshot = evaluateSnapshot(rawSnapshot, countryCode);

    return new Response(snapshot, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
      },
    });
  });

  sdk.get('/flags/stream', async (c) => {
    const authHeader = c.req.header('authorization');
    const token =
      authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
    }

    const auth = await resolveAuth(db, token, authCache);
    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_ERROR_CORS_HEADERS);
    }

    if (auth.orgStatus === 'suspended') {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    const requestOrigin = c.req.header('origin');
    const allowedOrigin = resolveAllowedOrigin(requestOrigin, auth.allowedOrigins);

    if (allowedOrigin === null) {
      return c.json({ error: 'Forbidden' }, 403, SDK_ERROR_CORS_HEADERS);
    }

    // Capture viewer country at connection time for per-connection geo evaluation.
    const countryCode = c.req.header('cloudfront-viewer-country') ?? null;

    // Snapshot: updated on every flag toggle via notifyFlagChange; DB only on cold miss.
    const rawSnapshot = await resolveRawSnapshot(db, auth.orgId, auth.environmentId, _snapshotCache);

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
    await writer.write(buildEvent(evaluateSnapshot(rawSnapshot, countryCode), 1000));

    if (streamRegistry) {
      unregisterStream = streamRegistry.register(auth.environmentId, (payload) => {
        // Each connection evaluates geo independently so different viewer
        // countries see the correct enabled state for their location.
        writer.write(buildEvent(evaluateSnapshot(payload, countryCode))).catch(() => {});
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
