import { LRUCache } from 'lru-cache';

export type SnapshotCache = ReturnType<typeof createSnapshotCache>;

export function createSnapshotCache(ttlMs = 30_000, max = 500) {
  const store = new LRUCache<string, string>({ max, ttl: ttlMs });
  return {
    get: (environmentId: string): string | null => store.get(environmentId) ?? null,
    set: (environmentId: string, snapshot: string): void => { store.set(environmentId, snapshot); },
    delete: (environmentId: string): void => { store.delete(environmentId); },
  };
}
