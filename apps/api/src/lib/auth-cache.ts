import { LRUCache } from 'lru-cache';

export type AuthEntry = {
  environmentId: string;
  orgId: string;
  allowedOrigins: string[];
  orgStatus: string;
};

export type AuthCache = ReturnType<typeof createAuthCache>;

export function createAuthCache(ttlMs = 30_000, max = 1_000) {
  const store = new LRUCache<string, AuthEntry>({ max, ttl: ttlMs });
  return {
    get: (hash: string): AuthEntry | null => store.get(hash) ?? null,
    set: (hash: string, entry: AuthEntry): void => { store.set(hash, entry); },
  };
}
