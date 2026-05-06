import { describe, it, expect, mock } from 'bun:test';
import {
  createFlagBus,
  createInMemoryInterContainerBus,
  createRedisInterContainerBus,
  type InterContainerBus,
  type SnapshotStore,
} from './flag-bus';

// Spy wrapper around the in-memory inter-container bus so tests can count
// subscribe/unsubscribe/publish calls without rebuilding the adapter.
function spyInterContainer(): InterContainerBus & {
  subscribeCalls: number;
  unsubscribeCalls: number;
  publishCalls: { envId: string; payload: string }[];
} {
  const inner = createInMemoryInterContainerBus();
  const state = { subscribeCalls: 0, unsubscribeCalls: 0, publishCalls: [] as { envId: string; payload: string }[] };

  return {
    publish(envId, payload) {
      state.publishCalls.push({ envId, payload });
      return inner.publish(envId, payload);
    },
    subscribe(envId, onMessage) {
      state.subscribeCalls++;
      const unsubscribe = inner.subscribe(envId, onMessage);
      return () => {
        state.unsubscribeCalls++;
        unsubscribe();
      };
    },
    get subscribeCalls() {
      return state.subscribeCalls;
    },
    get unsubscribeCalls() {
      return state.unsubscribeCalls;
    },
    get publishCalls() {
      return state.publishCalls;
    },
  };
}

function noopFanout() {
  return mock<(envId: string, payload: string) => void>(() => {});
}

describe('createFlagBus', () => {
  describe('publishLocal', () => {
    it('makes the payload readable via readSnapshot', async () => {
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: noopFanout(),
      });

      await bus.publishLocal('env-1', '{"flags":[{"key":"f","enabled":true}]}');

      expect(bus.readSnapshot('env-1')).toBe('{"flags":[{"key":"f","enabled":true}]}');
    });

    it('delivers the payload to every listener registered on the same bus', async () => {
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: noopFanout(),
      });
      const a: string[] = [];
      const b: string[] = [];
      bus.registerListener('env-1', (p) => a.push(p));
      bus.registerListener('env-1', (p) => b.push(p));

      await bus.publishLocal('env-1', 'payload');

      expect(a).toEqual(['payload']);
      expect(b).toEqual(['payload']);
    });

    it('delivers the payload to listeners on a different container via the inter-container bus', async () => {
      const interContainer = createInMemoryInterContainerBus();
      const busA = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });
      const busB = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });
      const received: string[] = [];
      busB.registerListener('env-1', (p) => received.push(p));

      await busA.publishLocal('env-1', 'cross-container');

      expect(received).toEqual(['cross-container']);
    });

    it('triggers region fanout exactly once with the env id and payload', async () => {
      const fanout = noopFanout();
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: fanout,
      });

      await bus.publishLocal('env-7', '{"flags":[]}');

      expect(fanout).toHaveBeenCalledTimes(1);
      expect(fanout).toHaveBeenCalledWith('env-7', '{"flags":[]}');
    });

    it('writes the snapshot before publishing to the inter-container bus', async () => {
      const order: string[] = [];
      const interContainer: InterContainerBus = {
        publish: () => {
          order.push('publish');
        },
        subscribe: () => () => {},
      };
      const snapshotStore: SnapshotStore = {
        get: () => null,
        set: () => {
          order.push('snapshot');
        },
        isStale: () => false,
        delete: () => {},
      };
      const bus = createFlagBus({ interContainer, fanoutToRegions: noopFanout(), snapshotStore });

      await bus.publishLocal('env-1', 'p');

      expect(order).toEqual(['snapshot', 'publish']);
    });
  });

  describe('ingestRemote', () => {
    it('makes the payload readable via readSnapshot', () => {
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: noopFanout(),
      });

      bus.ingestRemote('env-1', 'remote-payload');

      expect(bus.readSnapshot('env-1')).toBe('remote-payload');
    });

    it('delivers the payload to every listener on the same bus', () => {
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: noopFanout(),
      });
      const received: string[] = [];
      bus.registerListener('env-1', (p) => received.push(p));

      bus.ingestRemote('env-1', 'payload');

      expect(received).toEqual(['payload']);
    });

    it('delivers the payload to listeners on a different container via the inter-container bus', () => {
      const interContainer = createInMemoryInterContainerBus();
      const busA = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });
      const busB = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });
      const received: string[] = [];
      busB.registerListener('env-1', (p) => received.push(p));

      busA.ingestRemote('env-1', 'cross-container');

      expect(received).toEqual(['cross-container']);
    });

    it('does NOT trigger region fanout (the no-loop rule)', () => {
      const fanout = noopFanout();
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: fanout,
      });

      bus.ingestRemote('env-1', 'payload');

      expect(fanout).not.toHaveBeenCalled();
    });
  });

  describe('listener lifecycle', () => {
    it('subscribes to the inter-container bus when the first listener for an env attaches', () => {
      const interContainer = spyInterContainer();
      const bus = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });

      bus.registerListener('env-1', () => {});

      expect(interContainer.subscribeCalls).toBe(1);
    });

    it('reuses one inter-container subscription for additional listeners on the same env', () => {
      const interContainer = spyInterContainer();
      const bus = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });

      bus.registerListener('env-1', () => {});
      bus.registerListener('env-1', () => {});
      bus.registerListener('env-1', () => {});

      expect(interContainer.subscribeCalls).toBe(1);
    });

    it('unsubscribes only when the last listener for an env unregisters', () => {
      const interContainer = spyInterContainer();
      const bus = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });
      const u1 = bus.registerListener('env-1', () => {});
      const u2 = bus.registerListener('env-1', () => {});

      u1();
      expect(interContainer.unsubscribeCalls).toBe(0);
      u2();
      expect(interContainer.unsubscribeCalls).toBe(1);
    });

    it('keeps subscriptions independent across env ids', () => {
      const interContainer = spyInterContainer();
      const bus = createFlagBus({ interContainer, fanoutToRegions: noopFanout() });

      bus.registerListener('env-1', () => {});
      bus.registerListener('env-2', () => {});

      expect(interContainer.subscribeCalls).toBe(2);
    });

    it('does not deliver to listeners after they unregister', async () => {
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: noopFanout(),
      });
      const received: string[] = [];
      const unregister = bus.registerListener('env-1', (p) => received.push(p));

      unregister();
      await bus.publishLocal('env-1', 'payload');

      expect(received).toEqual([]);
    });
  });

  describe('readSnapshot', () => {
    it('returns null for an unknown env', () => {
      const bus = createFlagBus({
        interContainer: createInMemoryInterContainerBus(),
        fanoutToRegions: noopFanout(),
      });
      expect(bus.readSnapshot('cold')).toBeNull();
    });
  });

  describe('cacheSnapshot', () => {
    it('writes the snapshot without publishing to the inter-container bus or fanning out', () => {
      const interContainer = spyInterContainer();
      const fanout = noopFanout();
      const bus = createFlagBus({ interContainer, fanoutToRegions: fanout });

      bus.cacheSnapshot('env-1', 'cold-loaded');

      expect(bus.readSnapshot('env-1')).toBe('cold-loaded');
      expect(interContainer.publishCalls).toEqual([]);
      expect(fanout).not.toHaveBeenCalled();
    });
  });
});

describe('createInMemoryInterContainerBus', () => {
  it('delivers a published payload to every subscriber for that env', () => {
    const bus = createInMemoryInterContainerBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe('env-1', (p) => a.push(p));
    bus.subscribe('env-1', (p) => b.push(p));

    bus.publish('env-1', 'payload');

    expect(a).toEqual(['payload']);
    expect(b).toEqual(['payload']);
  });

  it('does not deliver across env ids', () => {
    const bus = createInMemoryInterContainerBus();
    const env1: string[] = [];
    const env2: string[] = [];
    bus.subscribe('env-1', (p) => env1.push(p));
    bus.subscribe('env-2', (p) => env2.push(p));

    bus.publish('env-1', 'only-env1');

    expect(env1).toEqual(['only-env1']);
    expect(env2).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createInMemoryInterContainerBus();
    const received: string[] = [];
    const unsub = bus.subscribe('env-1', (p) => received.push(p));

    unsub();
    bus.publish('env-1', 'payload');

    expect(received).toEqual([]);
  });
});

describe('createRedisInterContainerBus', () => {
  it('publishes on the flags:env:<envId> channel', async () => {
    const publisher = { publish: mock(async () => 1) };
    const subscriber = { subscribe: mock(() => {}), unsubscribe: mock(() => {}) };
    const bus = createRedisInterContainerBus({ publisher, subscriber });

    await bus.publish('env-42', '{"flags":[]}');

    expect(publisher.publish).toHaveBeenCalledWith('flags:env:env-42', '{"flags":[]}');
  });

  it('subscribes on the flags:env:<envId> channel and forwards messages', () => {
    let captured: ((m: string, c: string) => void) | undefined;
    const publisher = { publish: mock(async () => 1) };
    const subscriber = {
      subscribe: mock((_channel: string, listener: (m: string, c: string) => void) => {
        captured = listener;
      }),
      unsubscribe: mock(() => {}),
    };
    const bus = createRedisInterContainerBus({ publisher, subscriber });
    const received: string[] = [];

    bus.subscribe('env-1', (p) => received.push(p));
    captured?.('payload', 'flags:env:env-1');

    expect(subscriber.subscribe).toHaveBeenCalledWith('flags:env:env-1', expect.any(Function));
    expect(received).toEqual(['payload']);
  });

  it('unsubscribes on the same channel when the unsubscribe fn is called', () => {
    const publisher = { publish: mock(async () => 1) };
    const subscriber = { subscribe: mock(() => {}), unsubscribe: mock(() => {}) };
    const bus = createRedisInterContainerBus({ publisher, subscriber });
    const unsub = bus.subscribe('env-1', () => {});

    unsub();

    expect(subscriber.unsubscribe).toHaveBeenCalledWith('flags:env:env-1');
  });
});
