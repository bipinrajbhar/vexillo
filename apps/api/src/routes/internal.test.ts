import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createInternalRouter } from './internal';
import { createSnapshotCache } from '../lib/snapshot-cache';
import { createStreamRegistry } from '../lib/stream-registry';

const SECRET = 'test-internal-secret';

function makeApp(overrides: { redisPublisher?: Parameters<typeof createInternalRouter>[2] } = {}) {
  const snapshotCache = createSnapshotCache();
  const streamRegistry = createStreamRegistry();
  const app = new Hono();
  app.route('/internal', createInternalRouter(snapshotCache, streamRegistry, overrides.redisPublisher, SECRET));
  return { app, snapshotCache, streamRegistry };
}

async function post(app: Hono, body: unknown, secret?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Internal-Secret'] = secret;
  return app.request('/internal/flag-change', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /internal/flag-change', () => {
  it('returns 401 when X-Internal-Secret header is missing', async () => {
    const { app } = makeApp();
    const res = await app.request('/internal/flag-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envId: 'env-1', payload: '{}' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when X-Internal-Secret header is wrong', async () => {
    const { app } = makeApp();
    const res = await post(app, { envId: 'env-1', payload: '{}' }, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const res = await app.request('/internal/flag-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when envId is missing', async () => {
    const { app } = makeApp();
    const res = await post(app, { payload: '{}' }, SECRET);
    expect(res.status).toBe(400);
  });

  it('returns 400 when payload is missing', async () => {
    const { app } = makeApp();
    const res = await post(app, { envId: 'env-1' }, SECRET);
    expect(res.status).toBe(400);
  });

  it('writes the snapshot to the cache on success', async () => {
    const { app, snapshotCache } = makeApp();
    const res = await post(app, { envId: 'env-1', payload: '{"flags":[]}' }, SECRET);

    expect(res.status).toBe(200);
    expect(snapshotCache.get('env-1')).toBe('{"flags":[]}');
  });

  it('broadcasts via streamRegistry when no Redis publisher is provided', async () => {
    const { app, streamRegistry } = makeApp();
    const received: string[] = [];
    streamRegistry.register('env-1', (p) => received.push(p));

    await post(app, { envId: 'env-1', payload: '{"flags":[{"key":"f","enabled":true}]}' }, SECRET);

    expect(received).toEqual(['{"flags":[{"key":"f","enabled":true}]}']);
  });

  it('publishes to Redis when a publisher is provided', async () => {
    const published: { channel: string; message: string }[] = [];
    const redisPublisher = {
      publish: (channel: string, message: string) => {
        published.push({ channel, message });
      },
    };
    const { app } = makeApp({ redisPublisher });

    await post(app, { envId: 'env-2', payload: '{"flags":[]}' }, SECRET);

    expect(published).toEqual([{ channel: 'flags:env:env-2', message: '{"flags":[]}' }]);
  });

  it('returns ok:true on success', async () => {
    const { app } = makeApp();
    const res = await post(app, { envId: 'env-1', payload: '{}' }, SECRET);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
