import { describe, it, expect } from 'bun:test';
import { createFlagSnapshots, type InterContainerBus } from './index';
import { createInMemoryInterContainerBus } from './adapters';
import {
  createCapturingFanout,
  createFakeClock,
  createFakeLoader,
  createImmediateScheduler,
  createInMemoryStore,
} from './test-adapters';

// All wiring lines up here so each test only mentions what it varies. Defaults:
// fake clock at 0, immediate scheduler, in-memory store, in-memory inter-container,
// capturing region fanout, fake loader seeded with `env1: 'v1'`.
function setup(opts: {
  initialVersions?: Record<string, string>;
  ttlMs?: number;
  interContainer?: InterContainerBus;
  loaderInstance?: ReturnType<typeof createFakeLoader>;
} = {}) {
  const fakeClock = createFakeClock();
  const scheduler = createImmediateScheduler();
  const store = createInMemoryStore();
  const fakeLoader =
    opts.loaderInstance ?? createFakeLoader(opts.initialVersions ?? { env1: 'v1' });
  const fanoutCapture = createCapturingFanout();
  const interContainer = opts.interContainer ?? createInMemoryInterContainerBus();

  const { reader, writer } = createFlagSnapshots({
    loader: fakeLoader.loader,
    interContainer,
    fanoutToRegions: fanoutCapture.fanout,
    clock: fakeClock.clock,
    scheduler,
    store,
    ttlMs: opts.ttlMs ?? 30_000,
  });

  return {
    reader,
    writer,
    advance: fakeClock.advance,
    flush: scheduler.flush,
    callCount: fakeLoader.callCount,
    setVersion: fakeLoader.setVersion,
    fanoutCalls: fanoutCapture.calls,
    interContainer,
  };
}

const ARGS = { orgId: 'o', environmentId: 'env1', countryCode: null } as const;

describe('FlagSnapshotReader.serve', () => {
  it('cold-miss: loads from the SnapshotLoader and returns the evaluated payload', async () => {
    const { reader, callCount } = setup();

    const result = await reader.serve(ARGS);

    expect(callCount()).toBe(1);
    expect(JSON.parse(result)).toEqual({
      flags: [{ key: 'version-v1', enabled: true }],
    });
  });

  it('warm-hit: the second read does not hit the loader', async () => {
    const { reader, callCount } = setup();

    await reader.serve(ARGS);
    await reader.serve(ARGS);

    expect(callCount()).toBe(1);
  });

  it('stale-hit: returns the cached payload immediately and refreshes in the background', async () => {
    const { reader, callCount, advance, flush, setVersion } = setup({ ttlMs: 30_000 });

    await reader.serve(ARGS);
    expect(callCount()).toBe(1);

    setVersion('env1', 'v2');
    advance(31_000);

    const stale = await reader.serve(ARGS);
    expect(JSON.parse(stale).flags[0].key).toBe('version-v1');

    await flush();
    expect(callCount()).toBe(2);

    const fresh = await reader.serve(ARGS);
    expect(JSON.parse(fresh).flags[0].key).toBe('version-v2');
  });

  it('within-ttl: a read at 1ms before TTL is still considered fresh', async () => {
    const { reader, callCount, advance, flush } = setup({ ttlMs: 30_000 });

    await reader.serve(ARGS);
    advance(30_000);

    await reader.serve(ARGS);
    await flush();

    expect(callCount()).toBe(1);
  });

  it('evaluates country rules at read time so different viewers see different states', async () => {
    const loaderInstance = createFakeLoader({});
    // Override with a hand-crafted snapshot containing a country rule.
    const versionsHook = (envId: string) => {
      loaderInstance.setVersion(envId, 'unused');
    };
    versionsHook('env1');

    // The fake loader's encoding is fixed (`version-<tag>`) — for country rules
    // we wire the snapshot via writer.publishLocal which bypasses the loader.
    const { reader, writer } = setup({ loaderInstance });

    const rawPayload = JSON.stringify({
      flags: [{ key: 'geo', enabled: true, allowedCountries: ['US'] }],
    });
    await writer.publishLocal('env1', rawPayload);

    const us = await reader.serve({ orgId: 'o', environmentId: 'env1', countryCode: 'US' });
    expect(JSON.parse(us)).toEqual({ flags: [{ key: 'geo', enabled: true }] });

    const gb = await reader.serve({ orgId: 'o', environmentId: 'env1', countryCode: 'GB' });
    expect(JSON.parse(gb)).toEqual({ flags: [{ key: 'geo', enabled: false }] });
  });
});

describe('FlagSnapshotWriter.publishLocal', () => {
  it('caches the payload so the next serve() does not call the loader', async () => {
    const { reader, writer, callCount } = setup();

    await writer.publishLocal('env1', JSON.stringify({ flags: [{ key: 'f', enabled: true }] }));
    await reader.serve(ARGS);

    expect(callCount()).toBe(0);
  });

  it('triggers region fanout exactly once with the env id and payload', async () => {
    const { writer, fanoutCalls } = setup();

    await writer.publishLocal('env1', '{"flags":[]}');

    expect(fanoutCalls).toEqual([['env1', '{"flags":[]}']]);
  });

  it('delivers the raw payload to listeners on the same module', async () => {
    const { writer, reader } = setup();
    const received: string[] = [];
    const session = await reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: null,
      onFrame: (json) => received.push(json),
    });

    await writer.publishLocal('env1', JSON.stringify({ flags: [{ key: 'f', enabled: false }] }));

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual({ flags: [{ key: 'f', enabled: false }] });
    session.close();
  });

  it('cross-container: a publish on bus A reaches listeners on bus B', async () => {
    const interContainer = createInMemoryInterContainerBus();
    const a = setup({ interContainer });
    const b = setup({ interContainer });

    const received: string[] = [];
    const session = await b.reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: null,
      onFrame: (json) => received.push(json),
    });

    await a.writer.publishLocal('env1', JSON.stringify({ flags: [{ key: 'x', enabled: true }] }));

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual({ flags: [{ key: 'x', enabled: true }] });
    session.close();
  });
});

describe('FlagSnapshotWriter.ingestRemote', () => {
  it('caches the payload so the next serve() does not call the loader', async () => {
    const { reader, writer, callCount } = setup();

    writer.ingestRemote('env1', JSON.stringify({ flags: [{ key: 'f', enabled: true }] }));
    await reader.serve(ARGS);

    expect(callCount()).toBe(0);
  });

  it('does NOT trigger region fanout (the no-loop rule)', () => {
    const { writer, fanoutCalls } = setup();

    writer.ingestRemote('env1', '{"flags":[]}');

    expect(fanoutCalls).toEqual([]);
  });

  it('delivers the raw payload to listeners on the same module', async () => {
    const { writer, reader } = setup();
    const received: string[] = [];
    const session = await reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: null,
      onFrame: (json) => received.push(json),
    });

    writer.ingestRemote('env1', JSON.stringify({ flags: [{ key: 'f', enabled: true }] }));

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual({ flags: [{ key: 'f', enabled: true }] });
    session.close();
  });
});

describe('FlagSnapshotWriter.invalidate', () => {
  it('drops the cache so the next serve() goes back to the loader', async () => {
    const { reader, writer, callCount, setVersion } = setup();

    await reader.serve(ARGS);
    setVersion('env1', 'v2');

    writer.invalidate('env1');
    const result = await reader.serve(ARGS);

    expect(callCount()).toBe(2);
    expect(JSON.parse(result).flags[0].key).toBe('version-v2');
  });
});

describe('FlagSnapshotReader.openSession', () => {
  it('returns the initial frame evaluated against the captured country code', async () => {
    const loaderInstance = createFakeLoader({ env1: 'unused' });
    const { reader, writer } = setup({ loaderInstance });

    await writer.publishLocal(
      'env1',
      JSON.stringify({
        flags: [{ key: 'geo', enabled: true, allowedCountries: ['US'] }],
      }),
    );

    const session = await reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: 'GB',
      onFrame: () => {},
    });

    expect(JSON.parse(session.initialFrame)).toEqual({
      flags: [{ key: 'geo', enabled: false }],
    });
    session.close();
  });

  it('re-evaluates each pushed payload against the connection-bound country code', async () => {
    const loaderInstance = createFakeLoader({ env1: 'unused' });
    const { reader, writer } = setup({ loaderInstance });

    await writer.publishLocal('env1', JSON.stringify({ flags: [{ key: 'a', enabled: true }] }));

    const usFrames: string[] = [];
    const gbFrames: string[] = [];
    const us = await reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: 'US',
      onFrame: (json) => usFrames.push(json),
    });
    const gb = await reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: 'GB',
      onFrame: (json) => gbFrames.push(json),
    });

    await writer.publishLocal(
      'env1',
      JSON.stringify({ flags: [{ key: 'a', enabled: true, allowedCountries: ['US'] }] }),
    );

    expect(JSON.parse(usFrames[0]!)).toEqual({ flags: [{ key: 'a', enabled: true }] });
    expect(JSON.parse(gbFrames[0]!)).toEqual({ flags: [{ key: 'a', enabled: false }] });

    us.close();
    gb.close();
  });

  it('close() stops further frame delivery to that listener', async () => {
    const { reader, writer } = setup();
    const received: string[] = [];
    const session = await reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: null,
      onFrame: (json) => received.push(json),
    });

    session.close();
    await writer.publishLocal('env1', JSON.stringify({ flags: [{ key: 'f', enabled: true }] }));

    expect(received).toEqual([]);
  });
});

// Spy wrapper so listener-lifecycle tests can count subscribe/unsubscribe calls
// without touching the InMemory adapter's internals.
function spyInterContainer(): InterContainerBus & {
  subscribeCalls: () => number;
  unsubscribeCalls: () => number;
} {
  const inner = createInMemoryInterContainerBus();
  let subs = 0;
  let unsubs = 0;
  return {
    publish: (envId, payload) => inner.publish(envId, payload),
    subscribe: (envId, onMessage) => {
      subs++;
      const u = inner.subscribe(envId, onMessage);
      return () => {
        unsubs++;
        u();
      };
    },
    subscribeCalls: () => subs,
    unsubscribeCalls: () => unsubs,
  };
}

describe('listener lifecycle (refcounted inter-container subscription)', () => {
  it('subscribes to the inter-container bus when the first session for an env attaches', async () => {
    const interContainer = spyInterContainer();
    const { reader } = setup({ interContainer });

    const session = await reader.openSession({
      orgId: 'o',
      environmentId: 'env1',
      countryCode: null,
      onFrame: () => {},
    });

    expect(interContainer.subscribeCalls()).toBe(1);
    session.close();
  });

  it('reuses one inter-container subscription for additional sessions on the same env', async () => {
    const interContainer = spyInterContainer();
    const { reader } = setup({ interContainer });

    const a = await reader.openSession({ orgId: 'o', environmentId: 'env1', countryCode: null, onFrame: () => {} });
    const b = await reader.openSession({ orgId: 'o', environmentId: 'env1', countryCode: null, onFrame: () => {} });
    const c = await reader.openSession({ orgId: 'o', environmentId: 'env1', countryCode: null, onFrame: () => {} });

    expect(interContainer.subscribeCalls()).toBe(1);
    a.close();
    b.close();
    c.close();
  });

  it('unsubscribes only when the last session for an env closes', async () => {
    const interContainer = spyInterContainer();
    const { reader } = setup({ interContainer });

    const a = await reader.openSession({ orgId: 'o', environmentId: 'env1', countryCode: null, onFrame: () => {} });
    const b = await reader.openSession({ orgId: 'o', environmentId: 'env1', countryCode: null, onFrame: () => {} });

    a.close();
    expect(interContainer.unsubscribeCalls()).toBe(0);
    b.close();
    expect(interContainer.unsubscribeCalls()).toBe(1);
  });

  it('keeps subscriptions independent across env ids', async () => {
    const interContainer = spyInterContainer();
    const { reader } = setup({
      interContainer,
      initialVersions: { env1: 'v1', env2: 'v1' },
    });

    const a = await reader.openSession({ orgId: 'o', environmentId: 'env1', countryCode: null, onFrame: () => {} });
    const b = await reader.openSession({ orgId: 'o', environmentId: 'env2', countryCode: null, onFrame: () => {} });

    expect(interContainer.subscribeCalls()).toBe(2);
    a.close();
    b.close();
  });
});
