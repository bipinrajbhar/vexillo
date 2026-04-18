import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, asc, sql } from 'drizzle-orm';
import { apiKeys, environments, organizations, flags, flagStates, queryEnvironmentFlagStates } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey } from '../lib/api-key';
import { createFlagCache } from '../lib/flag-cache';

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
  const flagCache = createFlagCache();

  // Register Bearer auth security scheme so it appears in the generated spec.
  sdk.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
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

    // Single query: resolve API key → environment → org in one round-trip.
    const [auth] = await db
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

    const cached = flagCache.get(auth.environmentId);
    const flagRows = cached ?? await queryEnvironmentFlagStates(db, auth.orgId, auth.environmentId);
    if (!cached) flagCache.set(auth.environmentId, flagRows);

    const headers = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Cache-Control': 's-maxage=30',
    };

    return c.json(
      { flags: flagRows.map((r) => ({ key: r.key, enabled: r.enabled })) },
      200,
      headers,
    );
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
