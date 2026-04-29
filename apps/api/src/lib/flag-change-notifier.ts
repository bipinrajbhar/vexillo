import type { SnapshotCache } from './snapshot-cache';
import type { RegionFanout } from './region-fanout';
import type { StreamRegistry } from './stream-registry';
import type { NotifyFlagChange } from '../services/dashboard-service';

export interface RedisPublisher {
  publish(channel: string, payload: string): Promise<number>;
}

export function createFlagChangeNotifier(deps: {
  snapshotCache: SnapshotCache;
  regionFanout: RegionFanout;
  redisPublisher?: RedisPublisher;
  streamRegistry?: StreamRegistry;
}): NotifyFlagChange {
  const { snapshotCache, regionFanout, redisPublisher, streamRegistry } = deps;

  if (!redisPublisher && !streamRegistry) {
    throw new Error('createFlagChangeNotifier: either redisPublisher or streamRegistry must be provided');
  }

  if (redisPublisher) {
    return async (envId: string, payload: string): Promise<void> => {
      snapshotCache.set(envId, payload);
      regionFanout(envId, payload);
      await redisPublisher.publish(`flags:env:${envId}`, payload);
    };
  }

  return (envId: string, payload: string) => {
    snapshotCache.set(envId, payload);
    regionFanout(envId, payload);
    streamRegistry!.broadcast(envId, payload);
  };
}
