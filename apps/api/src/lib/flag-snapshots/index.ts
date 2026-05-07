import { evaluateCountryRule } from '../evaluate-country-rule';
import { createLruSnapshotStore } from './adapters';

// ── Ports ─────────────────────────────────────────────────────────────────────

/**
 * Loads the latest snapshot for an environment from the system of record. The
 * returned string is the raw `{flags:[...]}` JSON before country evaluation.
 * Production wraps Postgres; tests use a plain Map.
 */
export interface SnapshotLoader {
  load(orgId: string, environmentId: string): Promise<string>;
}

/**
 * Carries a flag payload between containers in the same region. Production
 * wraps Redis pub/sub on `flags:env:<envId>`; single-container dev and tests
 * use an in-memory adapter (same shape, no third "degraded" code path).
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

/** Latest-payload-plus-timestamp store keyed by envId. Dumb storage; the
 *  module owns the SWR/staleness logic via the Clock. */
export interface SnapshotStore {
  get(envId: string): { payload: string; storedAt: number } | null;
  set(envId: string, entry: { payload: string; storedAt: number }): void;
  delete(envId: string): void;
}

/** Wall clock — injected so SWR staleness can be advanced explicitly in tests. */
export interface Clock {
  now(): number;
}

/** Fire-and-forget background scheduler. Production fires the task off; the
 *  test scheduler tracks the promise so a `flush()` can await it. */
export interface TaskScheduler {
  run(task: () => Promise<void>): void;
}

/**
 * Recurring-tick port for the SSE keepalive timer. Production wraps
 * `setInterval`/`clearInterval`; tests use a manual ticker exposing `tick()`
 * for synchronous keepalive assertions.
 *
 * Distinct from `Clock` (pull-comparison for SWR) and `TaskScheduler`
 * (one-shot fire-and-forget for background refreshes) so each port's
 * lifecycle semantics are encoded in its name: this one is recurring with
 * cancellation.
 */
export interface IntervalScheduler {
  every(ms: number, task: () => void): () => void;
}

// ── Public roles ──────────────────────────────────────────────────────────────

export interface FlagSnapshotReader {
  /** REST hot path. SWR + cold-miss DB load + country evaluation, hidden inside. */
  serve(args: {
    orgId: string;
    environmentId: string;
    countryCode: string | null;
  }): Promise<string>;

  /**
   * SSE hot path. Captures country at connect, dispatches frames per-connection.
   * `close()` unregisters the listener (and unsubscribes the underlying
   * inter-container channel when the last listener for the env detaches).
   */
  openSession(args: {
    orgId: string;
    environmentId: string;
    countryCode: string | null;
    onFrame: (evaluatedJson: string) => void;
  }): Promise<{ initialFrame: string; close: () => void }>;

  /**
   * Build a fully-formed SSE Response. Owns: TransformStream pull-wrapper,
   * id sequencing (continued from `lastEventId`), `retry:` hint on the first
   * frame, `: keepalive` comment frames, abort cleanup, listener teardown,
   * SSE framing, and the standard SSE headers. The route layers CORS on top
   * via `corsHeaders` — the only knob the route owns.
   */
  streamSse(args: {
    orgId: string;
    environmentId: string;
    countryCode: string | null;
    lastEventId: string | null;
    abortSignal: AbortSignal;
    corsHeaders: Record<string, string>;
  }): Promise<Response>;
}

export interface FlagSnapshotWriter {
  /** Local toggle path: cache + inter-container + region fanout. */
  publishLocal(envId: string, payload: string): Promise<void>;
  /**
   * Remote ingest from /internal/flag-change. Cache + inter-container, NO
   * region fanout — caller is already in another region; fanning out again
   * would loop. Encoded as a separate method so the no-loop rule cannot be
   * forgotten by anyone refactoring the route.
   */
  ingestRemote(envId: string, payload: string): void;
  /** Drop cache for an envId without a payload (non-toggle invalidation). */
  invalidate(envId: string): void;
}

export interface FlagSnapshots {
  reader: FlagSnapshotReader;
  writer: FlagSnapshotWriter;
}

// ── Factory ───────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_KEEPALIVE_MS = 25_000;

const defaultClock: Clock = { now: () => Date.now() };

const defaultScheduler: TaskScheduler = {
  run(task) {
    void task().catch(() => {});
  },
};

const defaultIntervalScheduler: IntervalScheduler = {
  every(ms, task) {
    const handle = setInterval(task, ms);
    return () => clearInterval(handle);
  },
};

type RawSnapshot = {
  flags: Array<{
    key: string;
    enabled: boolean;
    allowedCountries?: string[];
  }>;
};

function evaluate(rawJson: string, countryCode: string | null): string {
  const { flags } = JSON.parse(rawJson) as RawSnapshot;
  return JSON.stringify({
    flags: flags.map((r) => ({
      key: r.key,
      enabled: evaluateCountryRule({
        allowedCountries: r.allowedCountries ?? [],
        countryCode,
        envEnabled: r.enabled,
      }),
    })),
  });
}

export function createFlagSnapshots(deps: {
  loader: SnapshotLoader;
  interContainer: InterContainerBus;
  fanoutToRegions: RegionFanout;
  clock?: Clock;
  scheduler?: TaskScheduler;
  store?: SnapshotStore;
  ttlMs?: number;
  intervalScheduler?: IntervalScheduler;
  keepaliveMs?: number;
}): FlagSnapshots {
  const { loader, interContainer, fanoutToRegions } = deps;
  const clock = deps.clock ?? defaultClock;
  const scheduler = deps.scheduler ?? defaultScheduler;
  const store = deps.store ?? createLruSnapshotStore();
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const intervalScheduler = deps.intervalScheduler ?? defaultIntervalScheduler;
  const keepaliveMs = deps.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;

  // SSE listeners: envId → set of `onFrame` callbacks (already country-bound by openSession).
  const listeners = new Map<string, Set<(rawPayload: string) => void>>();
  // Refcounted inter-container subscription per envId.
  const subscriptions = new Map<string, () => void>();

  function deliverLocally(envId: string, rawPayload: string): void {
    const set = listeners.get(envId);
    if (!set) return;
    for (const send of set) send(rawPayload);
  }

  function cacheSet(envId: string, payload: string): void {
    store.set(envId, { payload, storedAt: clock.now() });
  }

  function isStale(envId: string): boolean {
    const entry = store.get(envId);
    if (!entry) return false;
    return clock.now() - entry.storedAt > ttlMs;
  }

  async function loadRaw(orgId: string, environmentId: string): Promise<string> {
    const cached = store.get(environmentId);
    if (cached) {
      if (isStale(environmentId)) {
        scheduler.run(async () => {
          const fresh = await loader.load(orgId, environmentId);
          cacheSet(environmentId, fresh);
        });
      }
      return cached.payload;
    }
    const fresh = await loader.load(orgId, environmentId);
    cacheSet(environmentId, fresh);
    return fresh;
  }

  function registerListener(
    envId: string,
    send: (rawPayload: string) => void,
  ): () => void {
    let set = listeners.get(envId);
    if (!set) {
      set = new Set();
      listeners.set(envId, set);
      const unsubscribe = interContainer.subscribe(envId, (payload) => {
        deliverLocally(envId, payload);
      });
      subscriptions.set(envId, unsubscribe);
    }
    set.add(send);

    return () => {
      set!.delete(send);
      if (set!.size === 0) {
        listeners.delete(envId);
        const unsubscribe = subscriptions.get(envId);
        subscriptions.delete(envId);
        unsubscribe?.();
      }
    };
  }

  async function openSessionImpl(args: {
    orgId: string;
    environmentId: string;
    countryCode: string | null;
    onFrame: (evaluatedJson: string) => void;
  }): Promise<{ initialFrame: string; close: () => void }> {
    const initialRaw = await loadRaw(args.orgId, args.environmentId);
    const initialFrame = evaluate(initialRaw, args.countryCode);
    const close = registerListener(args.environmentId, (rawPayload) => {
      args.onFrame(evaluate(rawPayload, args.countryCode));
    });
    return { initialFrame, close };
  }

  async function streamSseImpl(args: {
    orgId: string;
    environmentId: string;
    countryCode: string | null;
    lastEventId: string | null;
    abortSignal: AbortSignal;
    corsHeaders: Record<string, string>;
  }): Promise<Response> {
    const encoder = new TextEncoder();

    // Use TransformStream + pull-based ReadableStream wrapper — the same
    // pattern Hono's streamSSE uses internally. A push-only ReadableStream
    // (start() + no pull()) causes Bun to consider the response done after
    // the first chunk is consumed, so subsequent enqueues (keepalive, Redis
    // snapshots) would close the connection. The push-through regression
    // test in flag-snapshots.test.ts pins this invariant.
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const tsReader = readable.getReader();

    let keepaliveCancel: (() => void) | undefined;
    let closeSession: (() => void) | undefined;
    let closed = false;
    let eventId = 1;

    if (args.lastEventId) {
      const parsed = parseInt(args.lastEventId, 10);
      if (!isNaN(parsed)) eventId = parsed + 1;
    }

    function buildEvent(data: string, retryMs?: number): Uint8Array {
      let msg = retryMs !== undefined ? `retry: ${retryMs}\n` : '';
      msg += `id: ${eventId++}\n`;
      msg += `data: ${data}\n\n`;
      return encoder.encode(msg);
    }

    function cleanup(): void {
      if (closed) return;
      closed = true;
      keepaliveCancel?.();
      closeSession?.();
      writer.close().catch(() => {});
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await tsReader.read();
        done ? controller.close() : controller.enqueue(value);
      },
      cancel: cleanup,
    });

    const session = await openSessionImpl({
      orgId: args.orgId,
      environmentId: args.environmentId,
      countryCode: args.countryCode,
      onFrame: (evaluatedJson) => {
        writer.write(buildEvent(evaluatedJson)).catch(() => {});
      },
    });
    closeSession = session.close;

    // First frame carries the retry hint so reconnect cadence is set without
    // the client having to fail once to discover it.
    await writer.write(buildEvent(session.initialFrame, 1000));

    keepaliveCancel = intervalScheduler.every(keepaliveMs, () => {
      writer.write(encoder.encode(': keepalive\n\n')).catch(() => {});
    });

    args.abortSignal.addEventListener('abort', cleanup);

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...args.corsHeaders,
      },
    });
  }

  const reader: FlagSnapshotReader = {
    async serve({ orgId, environmentId, countryCode }) {
      const raw = await loadRaw(orgId, environmentId);
      return evaluate(raw, countryCode);
    },

    openSession: openSessionImpl,

    streamSse: streamSseImpl,
  };

  const writer: FlagSnapshotWriter = {
    async publishLocal(envId, payload) {
      cacheSet(envId, payload);
      await interContainer.publish(envId, payload);
      fanoutToRegions(envId, payload);
    },

    ingestRemote(envId, payload) {
      cacheSet(envId, payload);
      // Fire-and-forget: the route returns ok:true immediately. The
      // inter-container publish is what propagates to peer containers in
      // this region.
      void interContainer.publish(envId, payload);
    },

    invalidate(envId) {
      store.delete(envId);
    },
  };

  return { reader, writer };
}

