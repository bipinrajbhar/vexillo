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
  // The route owns the SSE transport (TransformStream, keepalive, abort) and
  // delegates everything flag-shaped — cold-miss DB load, cache, country
  // evaluation, listener registration — to the reader's openSession().
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

    // Capture viewer country at connection time for per-connection geo evaluation.
    const countryCode = c.req.header('cloudfront-viewer-country') ?? null;

    const encoder = new TextEncoder();

    // Use TransformStream + pull-based wrapper — the same pattern Hono's
    // streamSSE uses internally. A push-only ReadableStream (start() + no pull())
    // causes Bun to consider the response done after the first chunk is consumed,
    // so subsequent enqueues (keepalive, Redis snapshots) close the connection.
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const tsReader = readable.getReader();

    let keepaliveInterval: ReturnType<typeof setInterval> | undefined;
    let closeSession: (() => void) | undefined;
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
      closeSession?.();
      writer.close().catch(() => {});
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await tsReader.read();
        done ? controller.close() : controller.enqueue(value);
      },
      cancel: cleanup,
    });

    const session = await snapshotReader.openSession({
      orgId: auth.orgId,
      environmentId: auth.environmentId,
      countryCode,
      onFrame: (evaluatedJson) => {
        writer.write(buildEvent(evaluatedJson)).catch(() => {});
      },
    });
    closeSession = session.close;

    // Send initial snapshot with retry hint so clients know the preferred
    // reconnect delay without waiting for a failed attempt.
    await writer.write(buildEvent(session.initialFrame, 1000));

    keepaliveInterval = setInterval(() => {
      writer.write(encoder.encode(': keepalive\n\n')).catch(() => {});
    }, 25_000);

    c.req.raw.signal.addEventListener('abort', cleanup);

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
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
