import { Hono } from 'hono';
import type { FlagBus } from '../lib/flag-bus';

export function createInternalRouter(flagBus: FlagBus, secret: string) {
  const app = new Hono();

  app.post('/flag-change', async (c) => {
    const receivedSecret = c.req.header('X-Internal-Secret');
    if (!receivedSecret || receivedSecret !== secret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>).envId !== 'string' ||
      typeof (body as Record<string, unknown>).payload !== 'string'
    ) {
      return c.json({ error: 'Invalid body' }, 400);
    }

    const { envId, payload } = body as { envId: string; payload: string };

    flagBus.ingestRemote(envId, payload);

    return c.json({ ok: true });
  });

  return app;
}
