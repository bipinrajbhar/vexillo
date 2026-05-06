import { LRUCache } from 'lru-cache';
import { queryEnvironmentFlagStates } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import type { InterContainerBus, SnapshotLoader, SnapshotStore } from './index';

// ── SnapshotLoader (Postgres) ─────────────────────────────────────────────────

export function createPostgresSnapshotLoader(deps: { db: DbClient }): SnapshotLoader {
  return {
    async load(orgId, environmentId) {
      const rows = await queryEnvironmentFlagStates(deps.db, orgId, environmentId);
      return JSON.stringify({ flags: rows });
    },
  };
}

// ── SnapshotStore (LRU) ───────────────────────────────────────────────────────

/**
 * Production cache: bounded LRU. Staleness is tracked by the FlagSnapshots
 * module via the Clock + ttlMs — the store itself is dumb storage.
 */
export function createLruSnapshotStore(max = 500): SnapshotStore {
  const store = new LRUCache<string, { payload: string; storedAt: number }>({ max });
  return {
    get: (envId) => store.get(envId) ?? null,
    set: (envId, entry) => {
      store.set(envId, entry);
    },
    delete: (envId) => {
      store.delete(envId);
    },
  };
}

// ── InterContainerBus (in-memory) ─────────────────────────────────────────────

/**
 * In-memory pub/sub. Production single-container deployments use this — same
 * code path as tests, no separate "degraded" branch. Multiple FlagSnapshots
 * instances sharing one of these simulates a multi-container region.
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

// ── InterContainerBus (Redis) ─────────────────────────────────────────────────

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
