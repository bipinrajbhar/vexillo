import { Hono } from 'hono';
import { eq, and, asc, sql } from 'drizzle-orm';
import { apiKeys, environments, flags, flagStates } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey } from '../lib/api-key';

const SDK_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
} as const;

export function createSdkRouter(db: DbClient) {
  const sdk = new Hono();

  // Preflight
  sdk.options('*', (c) => {
    return c.body(null, 204, SDK_CORS_HEADERS);
  });

  // GET /api/sdk/flags — bearer API key auth, returns flag states for the environment
  sdk.get('/flags', async (c) => {
    const authHeader = c.req.header('authorization');
    const token =
      authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_CORS_HEADERS);
    }

    const hash = await hashKey(token);

    const [apiKey] = await db
      .select({ environmentId: apiKeys.environmentId })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);

    if (!apiKey) {
      return c.json({ error: 'Unauthorized' }, 401, SDK_CORS_HEADERS);
    }

    const [env] = await db
      .select({ id: environments.id, allowedOrigins: environments.allowedOrigins })
      .from(environments)
      .where(eq(environments.id, apiKey.environmentId))
      .limit(1);

    if (!env) {
      return c.json({ error: 'Forbidden' }, 403, SDK_CORS_HEADERS);
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
      ...SDK_CORS_HEADERS,
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
