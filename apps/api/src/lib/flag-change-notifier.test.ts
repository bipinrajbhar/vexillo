import { describe, it, expect, mock } from 'bun:test';
import { createFlagChangeNotifier, type RedisPublisher } from './flag-change-notifier';
import { createTestFlagChangeNotifier } from './flag-change-notifier.test-adapter';
import type { SnapshotCache } from './snapshot-cache';
import type { RegionFanout } from './region-fanout';
import type { StreamRegistry } from './stream-registry';

function makeSnapshotCache(): SnapshotCache {
  return {
    get: () => null,
    set: () => {},
    delete: () => {},
    isStale: () => false,
  };
}

function makeNoopFanout(): RegionFanout {
  return mock(() => {});
}

describe('createFlagChangeNotifier', () => {
  it('throws at construction when neither redisPublisher nor streamRegistry is provided', () => {
    expect(() =>
      createFlagChangeNotifier({
        snapshotCache: makeSnapshotCache(),
        regionFanout: makeNoopFanout(),
      }),
    ).toThrow('createFlagChangeNotifier: either redisPublisher or streamRegistry must be provided');
  });

  describe('with redisPublisher', () => {
    it('sets snapshotCache before publishing to Redis', async () => {
      const order: string[] = [];
      const snapshotCache: SnapshotCache = {
        ...makeSnapshotCache(),
        set: (_envId, _payload) => { order.push('snapshot'); },
      };
      const publisher: RedisPublisher = {
        publish: mock(async () => { order.push('publish'); return 1; }),
      };

      const notify = createFlagChangeNotifier({
        snapshotCache,
        regionFanout: makeNoopFanout(),
        redisPublisher: publisher,
      });

      await notify('env-1', '{"flags":[]}');
      expect(order).toEqual(['snapshot', 'publish']);
    });

    it('publishes to the flags:env:<envId> channel', async () => {
      const publisher: RedisPublisher = { publish: mock(async () => 1) };

      const notify = createFlagChangeNotifier({
        snapshotCache: makeSnapshotCache(),
        regionFanout: makeNoopFanout(),
        redisPublisher: publisher,
      });

      await notify('env-42', '{"flags":[]}');
      expect(publisher.publish).toHaveBeenCalledWith('flags:env:env-42', '{"flags":[]}');
    });

    it('calls regionFanout with the environment id and payload', async () => {
      const fanout = makeNoopFanout();
      const publisher: RedisPublisher = { publish: mock(async () => 1) };

      const notify = createFlagChangeNotifier({
        snapshotCache: makeSnapshotCache(),
        regionFanout: fanout,
        redisPublisher: publisher,
      });

      await notify('env-1', '{"flags":[]}');
      expect(fanout).toHaveBeenCalledWith('env-1', '{"flags":[]}');
    });
  });

  describe('with streamRegistry', () => {
    it('sets snapshotCache before broadcasting', () => {
      const order: string[] = [];
      const snapshotCache: SnapshotCache = {
        ...makeSnapshotCache(),
        set: (_envId, _payload) => { order.push('snapshot'); },
      };
      const registry: StreamRegistry = {
        register: mock(() => () => {}),
        broadcast: mock(() => { order.push('broadcast'); }),
      };

      const notify = createFlagChangeNotifier({
        snapshotCache,
        regionFanout: makeNoopFanout(),
        streamRegistry: registry,
      });

      notify('env-1', '{"flags":[]}');
      expect(order).toEqual(['snapshot', 'broadcast']);
    });

    it('broadcasts with the environment id and payload', () => {
      const registry: StreamRegistry = {
        register: mock(() => () => {}),
        broadcast: mock(() => {}),
      };

      const notify = createFlagChangeNotifier({
        snapshotCache: makeSnapshotCache(),
        regionFanout: makeNoopFanout(),
        streamRegistry: registry,
      });

      notify('env-1', '{"flags":[{"key":"f","enabled":true}]}');
      expect(registry.broadcast).toHaveBeenCalledWith('env-1', '{"flags":[{"key":"f","enabled":true}]}');
    });

    it('calls regionFanout with the environment id and payload', () => {
      const fanout = makeNoopFanout();
      const registry: StreamRegistry = {
        register: mock(() => () => {}),
        broadcast: mock(() => {}),
      };

      const notify = createFlagChangeNotifier({
        snapshotCache: makeSnapshotCache(),
        regionFanout: fanout,
        streamRegistry: registry,
      });

      notify('env-1', '{"flags":[]}');
      expect(fanout).toHaveBeenCalledWith('env-1', '{"flags":[]}');
    });
  });
});

describe('createTestFlagChangeNotifier', () => {
  it('records calls with environmentId, payload, and parsedPayload', () => {
    const notifier = createTestFlagChangeNotifier();
    notifier.notify('env-1', '{"flags":[{"key":"f","enabled":true}]}');

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toEqual({
      environmentId: 'env-1',
      payload: '{"flags":[{"key":"f","enabled":true}]}',
      parsedPayload: { flags: [{ key: 'f', enabled: true }] },
    });
  });

  it('lastCall returns the most recent call', () => {
    const notifier = createTestFlagChangeNotifier();
    notifier.notify('env-1', '{"flags":[]}');
    notifier.notify('env-2', '{"flags":[{"key":"g","enabled":false}]}');

    expect(notifier.lastCall()?.environmentId).toBe('env-2');
  });

  it('lastCall returns undefined when no calls have been made', () => {
    const notifier = createTestFlagChangeNotifier();
    expect(notifier.lastCall()).toBeUndefined();
  });

  it('callsFor filters by environmentId', () => {
    const notifier = createTestFlagChangeNotifier();
    notifier.notify('env-1', '{"flags":[]}');
    notifier.notify('env-2', '{"flags":[]}');
    notifier.notify('env-1', '{"flags":[{"key":"f","enabled":true}]}');

    expect(notifier.callsFor('env-1')).toHaveLength(2);
    expect(notifier.callsFor('env-2')).toHaveLength(1);
  });

  it('reset clears all recorded calls', () => {
    const notifier = createTestFlagChangeNotifier();
    notifier.notify('env-1', '{"flags":[]}');
    notifier.reset();

    expect(notifier.calls).toHaveLength(0);
    expect(notifier.lastCall()).toBeUndefined();
  });
});
