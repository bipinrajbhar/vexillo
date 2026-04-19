import { LRUCache } from 'lru-cache';

export type AuthEntry = {
  environmentId: string;
  orgId: string;
  allowedOrigins: string[];
  orgStatus: string;
};

export type AuthCache = ReturnType<typeof createAuthCache>;

export function createAuthCache(ttlMs = 30_000, max = 1_000) {
  const store = new LRUCache<string, AuthEntry>({ max, ttl: ttlMs, allowStale: true, noDeleteOnStaleGet: true });
  return {
    get: (key: string): AuthEntry | null => store.get(key) ?? null,
    set: (key: string, entry: AuthEntry): void => { store.set(key, entry); },
    isStale: (key: string): boolean => store.has(key) && store.getRemainingTTL(key) === 0,
    clear: (): void => { store.clear(); },
  };
}
