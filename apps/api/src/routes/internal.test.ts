import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createInternalRouter } from './internal';
import { createFlagBus, createInMemoryInterContainerBus } from '../lib/flag-bus';

const SECRET = 'test-internal-secret';

function makeApp() {
  const flagBus = createFlagBus({
    interContainer: createInMemoryInterContainerBus(),
    fanoutToRegions: () => {},
  });
  const app = new Hono();
  app.route('/internal', createInternalRouter(flagBus, SECRET));
  return { app, flagBus };
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

  it('forwards a successful body to flagBus.ingestRemote (snapshot becomes readable)', async () => {
    const { app, flagBus } = makeApp();
    const res = await post(app, { envId: 'env-1', payload: '{"flags":[]}' }, SECRET);

    expect(res.status).toBe(200);
    expect(flagBus.readSnapshot('env-1')).toBe('{"flags":[]}');
  });

  it('returns ok:true on success', async () => {
    const { app } = makeApp();
    const res = await post(app, { envId: 'env-1', payload: '{}' }, SECRET);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
