import type {
  Clock,
  RegionFanout,
  SnapshotLoader,
  SnapshotStore,
  TaskScheduler,
} from './index';

/**
 * A clock whose value only changes when the test calls `advance()`. Pair with
 * `createImmediateScheduler()` to turn SWR staleness into a deterministic
 * synchronous assertion.
 */
export function createFakeClock(initial = 0): {
  clock: Clock;
  advance: (ms: number) => void;
} {
  let now = initial;
  return {
    clock: { now: () => now },
    advance: (ms) => {
      now += ms;
    },
  };
}

/**
 * Test scheduler that runs scheduled tasks synchronously up to the first
 * `await` and tracks their promises. Tests call `flush()` after the operation
 * under test to drain any background refreshes triggered by SWR.
 */
export type ImmediateScheduler = TaskScheduler & {
  flush(): Promise<void>;
};

export function createImmediateScheduler(): ImmediateScheduler {
  const pending: Array<Promise<void>> = [];
  return {
    run(task) {
      pending.push(task().catch(() => {}));
    },
    async flush() {
      while (pending.length > 0) {
        const batch = pending.splice(0);
        await Promise.all(batch);
      }
    },
  };
}

/**
 * Versioned in-memory loader. Each env maps to a version tag — when read, the
 * loader returns a `{flags:[{key:"version-<tag>",enabled:true}]}` snapshot so
 * tests can assert which version a `serve()` call returned.
 */
export function createFakeLoader(initial: Record<string, string>): {
  loader: SnapshotLoader;
  callCount: () => number;
  setVersion: (envId: string, version: string) => void;
} {
  const versions: Record<string, string> = { ...initial };
  let calls = 0;
  return {
    loader: {
      async load(_orgId, environmentId) {
        calls++;
        const v = versions[environmentId];
        if (v === undefined) {
          throw new Error(`createFakeLoader: no snapshot configured for ${environmentId}`);
        }
        return JSON.stringify({ flags: [{ key: `version-${v}`, enabled: true }] });
      },
    },
    callCount: () => calls,
    setVersion: (envId, version) => {
      versions[envId] = version;
    },
  };
}

export function createCapturingFanout(): {
  fanout: RegionFanout;
  calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  return {
    fanout: (envId, payload) => {
      calls.push([envId, payload]);
    },
    calls,
  };
}

/** Map-backed store. Identical contract to the LRU adapter, no eviction. */
export function createInMemoryStore(): SnapshotStore {
  const store = new Map<string, { payload: string; storedAt: number }>();
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
