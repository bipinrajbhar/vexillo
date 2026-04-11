import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { createInvitesRouter } from './invites';
import type { GetSession, Session } from './dashboard';

// ── Mock helpers ─────────────────────────────────────────────────────────────

const SESSION: Session = {
  user: { id: 'u-1', name: 'Alice', email: 'alice@example.com' },
};

const noSession: GetSession = async () => null;
const authedSession: GetSession = async () => SESSION;

// Chainable mock DB — results consumed FIFO from the queue.
function makeMockDb(staticResults: unknown[][] = []) {
  const queue = [...staticResults];

  function consume(): unknown[] {
    return (queue.shift() ?? []) as unknown[];
  }

  const chain: Record<string, unknown> = {};

  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(consume()).then(resolve, reject);

  for (const m of ['select', 'from', 'where', 'insert', 'values', 'update', 'set', 'delete']) {
    chain[m] = () => chain;
  }

  for (const m of ['limit', 'orderBy', 'returning', 'onConflictDoNothing']) {
    chain[m] = () => Promise.resolve(consume());
  }

  return chain as unknown as Parameters<typeof createInvitesRouter>[0];
}

function makeApp(db: Parameters<typeof createInvitesRouter>[0], getSession: GetSession) {
  const app = new Hono();
  app.route('/api/invites', createInvitesRouter(db, getSession));
  return app;
}

const BASE = 'http://localhost/api/invites';

const INVITE = {
  id: 'inv-1',
  orgId: 'org-1',
  email: 'bob@example.com',
  role: 'viewer' as const,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  acceptedAt: null,
};

// ── POST /api/invites/accept ─────────────────────────────────────────────────

describe('POST /api/invites/accept', () => {
  it('returns 401 when not authenticated', async () => {
    const app = makeApp(makeMockDb(), noSession);
    const res = await app.fetch(new Request(`${BASE}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'some-token' }),
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 when token is missing', async () => {
    const app = makeApp(makeMockDb(), authedSession);
    const res = await app.fetch(new Request(`${BASE}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Token is required' });
  });

  it('returns 404 when token does not match any active invite', async () => {
    // select.limit returns empty — no invite found
    const app = makeApp(makeMockDb([[/* no invite */]]), authedSession);
    const res = await app.fetch(new Request(`${BASE}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invite not found or expired' });
  });

  it('returns 200 and adds member when invite is valid', async () => {
    // select.limit → [INVITE]; insert.onConflictDoNothing → []; update.then → []
    const app = makeApp(makeMockDb([[INVITE], [], []]), authedSession);
    const res = await app.fetch(new Request(`${BASE}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { orgId: string; role: string };
    expect(body.orgId).toBe('org-1');
    expect(body.role).toBe('viewer');
  });

  it('is idempotent — returns 200 when user is already a member (onConflictDoNothing)', async () => {
    // Same queue: select.limit → [INVITE]; onConflictDoNothing is a no-op; update still runs
    const app = makeApp(makeMockDb([[INVITE], [], []]), authedSession);
    const res = await app.fetch(new Request(`${BASE}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }),
    }));
    expect(res.status).toBe(200);
  });
});
