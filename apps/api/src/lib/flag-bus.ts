import { LRUCache } from 'lru-cache';

// ── Ports ─────────────────────────────────────────────────────────────────────

/**
 * Carries a flag payload between containers in the same region. The bus uses
 * this to fan a publish out to every container holding listeners for an envId.
 *
 * Production wraps Redis pub/sub on `flags:env:<envId>`; single-container dev
 * uses an in-memory adapter (same shape, no third "degraded" code path).
 */
export interface InterContainerBus {
  publish(envId: string, payload: string): Promise<void> | void;
  subscribe(envId: string, onMessage: (payload: string) => void): () => void;
}

/**
 * Region-fanout. POSTs the payload to each secondary region's
 * /internal/flag-change. A no-op when there are no secondaries.
 */
export type RegionFanout = (envId: string, payload: string) => void;

/**
 * Latest-payload cache keyed by envId. Hidden from callers behind the bus —
 * the only reason this is a port at all is so tests can swap in a plain Map
 * and so a future shared cache can slot in without touching callers.
 */
export interface SnapshotStore {
  get(envId: string): string | null;
  set(envId: string, payload: string): void;
  isStale(envId: string): boolean;
  delete(envId: string): void;
}

// ── FlagBus interface ─────────────────────────────────────────────────────────

export interface FlagBus {
  /**
   * Local toggle path. Updates the snapshot cache, fans out to peer
   * containers (via InterContainerBus), then fans out to secondary regions.
   */
  publishLocal(envId: string, payload: string): Promise<void>;

  /**
   * Remote-receive path (POST /internal/flag-change). Same end state minus
   * region fanout: caller is already in another region — fanning out again
   * would loop. Encoded as a separate method so that the no-loop rule cannot
   * be forgotten by anyone refactoring the route.
   */
  ingestRemote(envId: string, payload: string): void;

  /**
   * Returns the latest snapshot payload, or null if the cache is cold. The
   * caller (today: SDK route) is responsible for the DB fallback.
   */
  readSnapshot(envId: string): string | null;

  /**
   * Whether the cached snapshot for envId is past its TTL. Kept stale-served
   * so the SDK route can return immediately and refresh in the background.
   */
  isSnapshotStale(envId: string): boolean;

  /**
   * Cache-only write (no publish, no fanout). Used by the SDK route to
   * populate the cache after a cold DB load. A follow-up will move DB
   * loading into the bus and remove this method from the public surface.
   */
  cacheSnapshot(envId: string, payload: string): void;

  /**
   * Drop the cached snapshot for an environment so the next read takes the
   * cold-miss path. The toggle path uses `publishLocal` (which overwrites the
   * slot with the fresh payload), so this is for callers that want to force a
   * re-read without a payload in hand — e.g. a reader-level invalidate.
   */
  invalidateSnapshot(envId: string): void;

  /**
   * Register an SSE writer for envId. The bus subscribes to the
   * InterContainerBus on first listener for that env and unsubscribes on
   * last — that lifecycle is hidden from callers. The returned function
   * unregisters.
   */
  registerListener(envId: string, send: (payload: string) => void): () => void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createFlagBus(deps: {
  interContainer: InterContainerBus;
  fanoutToRegions: RegionFanout;
  snapshotStore?: SnapshotStore;
}): FlagBus {
  const { interContainer, fanoutToRegions } = deps;
  const snapshotStore = deps.snapshotStore ?? createDefaultSnapshotStore();

  // SseDelivery: in-memory map of envId → set of send functions.
  const sends = new Map<string, Set<(payload: string) => void>>();
  // Refcounted inter-container subscription per envId.
  const subscriptions = new Map<string, () => void>();

  function deliverLocally(envId: string, payload: string): void {
    const set = sends.get(envId);
    if (!set) return;
    for (const send of set) send(payload);
  }

  return {
    async publishLocal(envId, payload) {
      snapshotStore.set(envId, payload);
      await interContainer.publish(envId, payload);
      fanoutToRegions(envId, payload);
    },

    ingestRemote(envId, payload) {
      snapshotStore.set(envId, payload);
      // Fire-and-forget: the route returns ok:true immediately. The Redis
      // publish (or in-memory delivery) is what propagates to peer
      // containers in this region.
      void interContainer.publish(envId, payload);
    },

    readSnapshot(envId) {
      return snapshotStore.get(envId);
    },

    isSnapshotStale(envId) {
      return snapshotStore.isStale(envId);
    },

    cacheSnapshot(envId, payload) {
      snapshotStore.set(envId, payload);
    },

    invalidateSnapshot(envId) {
      snapshotStore.delete(envId);
    },

    registerListener(envId, send) {
      let set = sends.get(envId);
      if (!set) {
        set = new Set();
        sends.set(envId, set);
        const unsubscribe = interContainer.subscribe(envId, (payload) => {
          deliverLocally(envId, payload);
        });
        subscriptions.set(envId, unsubscribe);
      }
      set.add(send);

      return () => {
        set!.delete(send);
        if (set!.size === 0) {
          sends.delete(envId);
          const unsubscribe = subscriptions.get(envId);
          subscriptions.delete(envId);
          unsubscribe?.();
        }
      };
    },
  };
}

// ── Default snapshot store ────────────────────────────────────────────────────

export function createDefaultSnapshotStore(ttlMs = 30_000, max = 500): SnapshotStore {
  const store = new LRUCache<string, string>({
    max,
    ttl: ttlMs,
    allowStale: true,
    noDeleteOnStaleGet: true,
  });
  return {
    get: (envId) => store.get(envId) ?? null,
    set: (envId, payload) => {
      store.set(envId, payload);
    },
    isStale: (envId) => store.has(envId) && store.getRemainingTTL(envId) === 0,
    delete: (envId) => {
      store.delete(envId);
    },
  };
}

// ── In-memory InterContainerBus (used in dev without Redis, and in tests) ─────

/**
 * In-memory pub/sub. Production single-container deployments use this — same
 * code path as tests, no separate "degraded" branch. Multiple FlagBus
 * instances sharing one of these simulates a Redis cluster.
 */
export function createInMemoryInterContainerBus(): InterContainerBus {
  const channels = new Map<string, Set<(payload: string) => void>>();

  return {
    publish(envId, payload) {
      const subs = channels.get(envId);
      if (!subs) return;
      for (const sub of subs) sub(payload);
    },
    subscribe(envId, onMessage) {
      let set = channels.get(envId);
      if (!set) {
        set = new Set();
        channels.set(envId, set);
      }
      set.add(onMessage);
      return () => {
        set!.delete(onMessage);
        if (set!.size === 0) channels.delete(envId);
      };
    },
  };
}

// ── Redis InterContainerBus ───────────────────────────────────────────────────

/** Narrow shapes — match Bun's RedisClient (publish mode / subscribe mode). */
export interface RedisPublisher {
  publish(channel: string, payload: string): Promise<number> | number | void;
}

export interface RedisSubscriber {
  subscribe(
    channel: string,
    listener: (message: string, channel: string) => void,
  ): Promise<number> | void;
  unsubscribe(channel: string): Promise<void> | void;
}

const channelOf = (envId: string) => `flags:env:${envId}`;

export function createRedisInterContainerBus(deps: {
  publisher: RedisPublisher;
  subscriber: RedisSubscriber;
}): InterContainerBus {
  const { publisher, subscriber } = deps;
  return {
    async publish(envId, payload) {
      await publisher.publish(channelOf(envId), payload);
    },
    subscribe(envId, onMessage) {
      const channel = channelOf(envId);
      subscriber.subscribe(channel, (message) => onMessage(message));
      return () => {
        void subscriber.unsubscribe(channel);
      };
    },
  };
}
