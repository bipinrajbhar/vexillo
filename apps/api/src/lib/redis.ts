import { RedisClient } from 'bun';

// Creates two independent Redis connections from a single URL:
// - publisher: used by dashboard service to publish flag snapshots
// - subscriber: passed to createStreamRegistry (enters subscribe mode)
//
// Called once in index.ts; not singletons here so that tests can avoid
// importing this module (and therefore avoid needing a real REDIS_URL).
export function createRedisClients(redisUrl: string): {
  publisher: RedisClient;
  subscriber: RedisClient;
} {
  return {
    publisher: new RedisClient(redisUrl),
    subscriber: new RedisClient(redisUrl),
  };
}
