import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { SdkAuthenticator, AuthRejectReason } from '../lib/sdk-authenticator';
import type { FlagSnapshotReader } from '../lib/flag-snapshots';

// CORS headers for pre-auth error responses (401, env-not-found 403). We use
// '*' here because we don't yet know the environment's allowedOrigins, but
// browsers still need to read the error body (e.g. to surface "Unauthorized").
const SDK_ERROR_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
} as const;

function errorBodyFor(reason: AuthRejectReason): { error: 'Unauthorized' | 'Forbidden' } {
  return {
    error:
      reason === 'missing_token' || reason === 'invalid_token'
        ? 'Unauthorized'
        : 'Forbidden',
  };
}

function okHeaders(allowedOriginHeader: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOriginHeader,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Cache-Control': 's-maxage=300, stale-while-revalidate=60',
  };
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

export function createSdkRouter(deps: {
  authenticator: SdkAuthenticator;
  // The route is purely the HTTP edge: auth + delegation. The SSE transport
  // (TransformStream, keepalive, id sequencing, abort cleanup, headers)
  // lives inside the reader's streamSse().
  snapshotReader: FlagSnapshotReader;
}) {
  const { authenticator, snapshotReader } = deps;

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
    const auth = await authenticator.authenticate({
      authorizationHeader: c.req.header('authorization'),
      originHeader: c.req.header('origin'),
    });
    if (!auth.ok) {
      return c.json(errorBodyFor(auth.reason), auth.status, SDK_ERROR_CORS_HEADERS);
    }

    // CloudFront injects this header; absent in local dev and CI → falls back to envEnabled.
    const evaluated = await snapshotReader.serve({
      orgId: auth.orgId,
      environmentId: auth.environmentId,
      countryCode: c.req.header('cloudfront-viewer-country') ?? null,
    });

    return new Response(evaluated, {
      status: 200,
      headers: okHeaders(auth.allowedOriginHeader),
    });
  });

  sdk.get('/flags/stream', async (c) => {
    const auth = await authenticator.authenticate({
      authorizationHeader: c.req.header('authorization'),
      originHeader: c.req.header('origin'),
    });
    if (!auth.ok) {
      return c.json(errorBodyFor(auth.reason), auth.status, SDK_ERROR_CORS_HEADERS);
    }

    return snapshotReader.streamSse({
      orgId: auth.orgId,
      environmentId: auth.environmentId,
      countryCode: c.req.header('cloudfront-viewer-country') ?? null,
      lastEventId: c.req.header('last-event-id') ?? null,
      abortSignal: c.req.raw.signal,
      corsHeaders: {
        'Access-Control-Allow-Origin': auth.allowedOriginHeader,
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
