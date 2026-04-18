import { LRUCache } from 'lru-cache';

type FlagRow = { key: string; enabled: boolean };

export type FlagCache = ReturnType<typeof createFlagCache>;

export function createFlagCache(ttlMs = 30_000, max = 500) {
  const store = new LRUCache<string, FlagRow[]>({ max, ttl: ttlMs });

  return {
    get(environmentId: string): FlagRow[] | null {
      return store.get(environmentId) ?? null;
    },
    set(environmentId: string, flags: FlagRow[]): void {
      store.set(environmentId, flags);
    },
    delete(environmentId: string): void {
      store.delete(environmentId);
    },
  };
}
