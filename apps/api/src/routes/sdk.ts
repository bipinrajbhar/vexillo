import { Hono } from 'hono';
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

export function createSdkRouter(db: DbClient) {
  const sdk = new Hono();

  // Preflight — we can't check allowedOrigins without an API key, so we return
  // * here. The actual GET will enforce origin restrictions before returning data.
  sdk.options('*', (c) => {
    return c.body(null, 204, SDK_ERROR_CORS_HEADERS);
  });

  // GET /api/sdk/flags — bearer API key auth, returns flag states for the environment
  sdk.get('/flags', async (c) => {
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

  // GET /api/sdk/flags/stream — SSE stub, emits keepalive comment every 25s
  // CloudFront has a 60s read timeout; keepalive every 25s prevents silent disconnect.
  sdk.get('/flags/stream', (c) => {
    const encoder = new TextEncoder();
    let interval: ReturnType<typeof setInterval>;

    const body = new ReadableStream({
      start(controller) {
        const send = () =>
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        send();
        interval = setInterval(send, 25_000);

        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(interval);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        clearInterval(interval);
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  return sdk;
}
