import {
  createEventSource,
  type EventSourceClient,
  type EventSourceOptions,
} from "eventsource-client";
import { flagsArrayToRecord } from "./fetch-flags";

/**
 * High-level lifecycle status. The internal REST↔SSE state machine has more
 * states (racing, rest_won, streaming, bridging, …) but consumers only care
 * about whether the client has flags to give them.
 *
 * - `idle`    — never started, or stopped before any flags arrived.
 * - `loading` — cold start in flight; no flags yet (and no `initialFlags`).
 * - `ready`   — flags are available (from `initialFlags`, REST, or SSE).
 *               Stays `ready` across silent refreshes — failures during a
 *               refresh update `lastError` without flipping status.
 * - `error`   — cold start failed and there are no flags to fall back on.
 */
export type ClientStatus = "idle" | "loading" | "ready" | "error";

export interface VexilloClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Pre-resolved flags. When provided, `isReady` is true immediately. */
  initialFlags?: Record<string, boolean>;
  /** Returned for unknown keys when no remote value exists. */
  fallbacks?: Record<string, boolean>;

  /**
   * Wire mode. Default: `"rest"`.
   *
   * - `"rest"`   — one-shot fetch on `start()`; auto-refresh on focus by default.
   * - `"stream"` — REST↔SSE race on cold start, SSE authoritative, REST bridge
   *                on disconnect. Auto-refresh is ignored (SSE is authoritative).
   */
  mode?: "rest" | "stream";

  /**
   * Auto-refresh policy for REST mode. Default: `{ onFocus: true }`.
   * Set `{ onFocus: false }` to disable focus-triggered refreshes (e.g. when
   * driving refreshes manually from a router). Stream mode ignores this.
   */
  autoRefresh?: { onFocus?: boolean };

  /** Called on every wire error (cold-start REST, race REST, bridge REST, refresh). */
  onError?: (err: Error) => void;

  /** @internal — escape hatch for tests. */
  fetch?: typeof fetch;
  /** @internal — escape hatch for tests. */
  createEventSource?: (opts: EventSourceOptions) => EventSourceClient;
  /**
   * @internal — escape hatch for tests. A focus-event source: takes a callback,
   * returns an unsubscribe. The default wires `window.addEventListener("focus")`
   * and is a no-op when `window` is undefined (SSR).
   */
  focusSignal?: (cb: () => void) => () => void;
}

export interface VexilloClient {
  /**
   * Begin the configured wire activity. Idempotent — calling repeatedly without
   * an intervening `stop()` returns the existing stop handle and does not open
   * a second connection. Returns a stop function; calling it tears down the
   * wire and unsubscribes the focus listener (if any).
   */
  start(): () => void;
  /**
   * Manual one-shot REST refresh. Fires regardless of `mode` — useful in
   * stream mode for a forced refresh, or in REST mode with `autoRefresh.onFocus`
   * disabled. Resolves once the request settles (success or failure).
   */
  refresh(): Promise<void>;

  /** Synchronous read. Priority: overrides > remote > fallbacks > false. */
  getFlag(key: string): boolean;
  /** Snapshot of all resolved flags (overrides + remote + fallbacks merged). */
  getAllFlags(): Record<string, boolean>;
  /**
   * Subscribe to changes on a specific key. Fires on snapshot delivery,
   * `override()`, and `clearOverride()`. Returns an unsubscribe function.
   */
  subscribe(key: string, listener: (value: boolean) => void): () => void;
  /** Subscribe to any flag change. Returns an unsubscribe function. */
  subscribeAll(listener: (flags: Record<string, boolean>) => void): () => void;
  /** Imperatively set flag values. Notifies subscribers immediately. */
  override(overrides: Record<string, boolean>): void;
  /** Remove an override for a specific key and notify subscribers. */
  clearOverride(key: string): void;
  /** Remove all overrides and notify subscribers. */
  clearOverrides(): void;

  readonly isReady: boolean;
  readonly lastError: Error | null;
  readonly status: ClientStatus;
  /** Subscribe to status transitions. Returns an unsubscribe function. */
  subscribeStatus(listener: (status: ClientStatus) => void): () => void;
}

// ── Internal state machine ─────────────────────────────────────────────────

type ConnState =
  | { kind: "idle" }
  | { kind: "loading"; rest: AbortController }
  | { kind: "racing"; es: EventSourceClient; rest: AbortController }
  | { kind: "rest_won"; es: EventSourceClient }
  | { kind: "streaming"; es: EventSourceClient }
  | { kind: "bridging"; es: EventSourceClient; rest: AbortController }
  | { kind: "closed" };

type Event =
  | { type: "LOAD" }
  | { type: "CONNECT" }
  | { type: "REST_RESOLVED"; flags: Record<string, boolean> }
  | { type: "REST_FAILED"; err: Error }
  | { type: "SSE_SNAPSHOT"; flags: Record<string, boolean> }
  | { type: "SSE_DISCONNECTED" }
  | { type: "STOP" };

const defaultFocusSignal = (cb: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("focus", cb);
  return () => window.removeEventListener("focus", cb);
};

export function createVexilloClient(config: VexilloClientConfig): VexilloClient {
  const { baseUrl, apiKey, fallbacks = {}, onError } = config;
  const mode: "rest" | "stream" = config.mode ?? "rest";
  const onFocus = config.autoRefresh?.onFocus ?? true;
  const fetchImpl: typeof fetch =
    config.fetch ?? globalThis.fetch.bind(globalThis);
  const makeEventSource = config.createEventSource ?? createEventSource;
  const focusSignal = config.focusSignal ?? defaultFocusSignal;

  let remoteFlags: Record<string, boolean> = config.initialFlags ?? {};
  let overrides: Record<string, boolean> = {};
  let ready = config.initialFlags !== undefined;
  let error: Error | null = null;

  const keyListeners = new Map<string, Set<(value: boolean) => void>>();
  const allListeners = new Set<(flags: Record<string, boolean>) => void>();
  const statusListeners = new Set<(s: ClientStatus) => void>();

  let conn: ConnState = { kind: "idle" };
  let publicStatus: ClientStatus = computeStatus();

  // start()/stop() handle plus focus-listener teardown — owns the
  // idempotency guarantee.
  let activeStop: (() => void) | null = null;

  // Re-entrancy guard: a snapshot/status listener may synchronously trigger
  // another dispatch (e.g. calling stop() inside subscribeAll). Queue those
  // events so the outer reduce's state assignment isn't clobbered.
  let dispatching = false;
  const queue: Event[] = [];

  function resolve(key: string): boolean {
    if (key in overrides) return overrides[key];
    if (key in remoteFlags) return remoteFlags[key];
    if (key in fallbacks) return fallbacks[key];
    return false;
  }

  function snapshot(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(fallbacks)) out[k] = v;
    for (const [k, v] of Object.entries(remoteFlags)) out[k] = v;
    for (const [k, v] of Object.entries(overrides)) out[k] = v;
    return out;
  }

  function notifyKey(key: string): void {
    const listeners = keyListeners.get(key);
    if (!listeners) return;
    for (const l of listeners) l(resolve(key));
  }

  function notifyAll(): void {
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    for (const key of keyListeners.keys()) notifyKey(key);
  }

  function computeStatus(): ClientStatus {
    if (ready) return "ready";
    if (error && conn.kind === "closed") return "error";
    if (conn.kind === "idle" || conn.kind === "closed") return "idle";
    return "loading"; // loading | racing
  }

  function publishStatus(): void {
    const next = computeStatus();
    if (next !== publicStatus) {
      publicStatus = next;
      for (const l of statusListeners) l(publicStatus);
    }
  }

  function applySnapshot(flags: Record<string, boolean>): void {
    remoteFlags = flags;
    error = null;
    ready = true;
    notifyAll();
    publishStatus();
  }

  function reportError(err: Error): void {
    error = err;
    onError?.(err);
    publishStatus();
  }

  function dispatch(event: Event): void {
    queue.push(event);
    if (dispatching) return;
    dispatching = true;
    try {
      while (queue.length > 0) {
        const e = queue.shift() as Event;
        const prev = conn.kind;
        conn = reduce(conn, e);
        if (conn.kind !== prev) publishStatus();
      }
    } finally {
      dispatching = false;
    }
  }

  function startEventSource(): EventSourceClient {
    return makeEventSource({
      url: `${baseUrl}/api/sdk/flags/stream`,
      headers: { Authorization: `Bearer ${apiKey}` },
      fetch: fetchImpl as EventSourceOptions["fetch"],
      onMessage: (msg) => {
        const flags = parseSnapshot(msg.data);
        if (flags) dispatch({ type: "SSE_SNAPSHOT", flags });
      },
      onDisconnect: () => dispatch({ type: "SSE_DISCONNECTED" }),
    });
  }

  function startRest(): AbortController {
    const ac = new AbortController();
    void runRest(ac.signal);
    return ac;
  }

  async function runRest(signal: AbortSignal): Promise<void> {
    try {
      const res = await fetchImpl(`${baseUrl}/api/sdk/flags`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (signal.aborted) return;
      if (!res.ok) {
        dispatch({
          type: "REST_FAILED",
          err: new Error(`REST: ${res.status}`),
        });
        return;
      }
      const data = (await res.json()) as {
        flags: Array<{ key: string; enabled: boolean }>;
      };
      if (signal.aborted) return;
      dispatch({
        type: "REST_RESOLVED",
        flags: flagsArrayToRecord(data.flags),
      });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      dispatch({
        type: "REST_FAILED",
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  function reduce(s: ConnState, e: Event): ConnState {
    if (e.type === "STOP") {
      if ("rest" in s) s.rest.abort();
      if ("es" in s) s.es.close();
      return { kind: "closed" };
    }

    if (e.type === "SSE_DISCONNECTED") {
      if (s.kind === "rest_won" || s.kind === "streaming") {
        return { kind: "bridging", es: s.es, rest: startRest() };
      }
      return s;
    }

    switch (s.kind) {
      case "idle":
      case "closed":
        if (e.type === "LOAD") {
          return { kind: "loading", rest: startRest() };
        }
        if (e.type === "CONNECT") {
          return {
            kind: "racing",
            es: startEventSource(),
            rest: startRest(),
          };
        }
        return s;

      case "loading":
        if (e.type === "REST_RESOLVED") {
          applySnapshot(e.flags);
          return { kind: "closed" };
        }
        if (e.type === "REST_FAILED") {
          reportError(e.err);
          return { kind: "closed" };
        }
        return s;

      case "racing":
        if (e.type === "REST_RESOLVED") {
          applySnapshot(e.flags);
          return { kind: "rest_won", es: s.es };
        }
        if (e.type === "REST_FAILED") {
          reportError(e.err);
          return s;
        }
        if (e.type === "SSE_SNAPSHOT") {
          applySnapshot(e.flags);
          s.rest.abort();
          return { kind: "streaming", es: s.es };
        }
        return s;

      case "rest_won":
        if (e.type === "SSE_SNAPSHOT") {
          applySnapshot(e.flags);
          return { kind: "streaming", es: s.es };
        }
        return s;

      case "streaming":
        if (e.type === "SSE_SNAPSHOT") {
          applySnapshot(e.flags);
          return s;
        }
        return s;

      case "bridging":
        if (e.type === "REST_RESOLVED") {
          applySnapshot(e.flags);
          return { kind: "rest_won", es: s.es };
        }
        if (e.type === "REST_FAILED") {
          reportError(e.err);
          return s;
        }
        if (e.type === "SSE_SNAPSHOT") {
          applySnapshot(e.flags);
          s.rest.abort();
          return { kind: "streaming", es: s.es };
        }
        return s;
    }
  }

  // ── Public lifecycle ─────────────────────────────────────────────────────

  function start(): () => void {
    // Idempotent: a second start() without an intervening stop() returns the
    // existing stop handle so React StrictMode double-mount doesn't open a
    // second wire.
    if (activeStop) return activeStop;

    if (mode === "stream") {
      if (conn.kind === "idle" || conn.kind === "closed") {
        dispatch({ type: "CONNECT" });
      }
    } else {
      // REST mode: cold-start fetch only when we don't already have flags.
      if (!ready && (conn.kind === "idle" || conn.kind === "closed")) {
        dispatch({ type: "LOAD" });
      }
    }

    let unsubFocus: (() => void) | null = null;
    if (mode === "rest" && onFocus) {
      unsubFocus = focusSignal(() => {
        void refresh();
      });
    }

    const stop = (): void => {
      if (activeStop !== stop) return; // already torn down
      activeStop = null;
      unsubFocus?.();
      unsubFocus = null;
      if (conn.kind !== "closed") dispatch({ type: "STOP" });
    };
    activeStop = stop;
    return stop;
  }

  // Independent one-shot REST. Does not touch the FSM — applies the snapshot
  // (or reports the error) directly. Used for manual refreshes and as the
  // focus-event handler in REST mode.
  async function refresh(): Promise<void> {
    try {
      const res = await fetchImpl(`${baseUrl}/api/sdk/flags`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        reportError(new Error(`REST: ${res.status}`));
        return;
      }
      const data = (await res.json()) as {
        flags: Array<{ key: string; enabled: boolean }>;
      };
      applySnapshot(flagsArrayToRecord(data.flags));
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ── Reads / subscriptions / overrides ────────────────────────────────────

  function getFlag(key: string): boolean {
    return resolve(key);
  }

  function getAllFlags(): Record<string, boolean> {
    return snapshot();
  }

  function subscribe(
    key: string,
    listener: (value: boolean) => void,
  ): () => void {
    let set = keyListeners.get(key);
    if (!set) {
      set = new Set();
      keyListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) keyListeners.delete(key);
    };
  }

  function subscribeAll(
    listener: (flags: Record<string, boolean>) => void,
  ): () => void {
    allListeners.add(listener);
    return () => allListeners.delete(listener);
  }

  function override(newOverrides: Record<string, boolean>): void {
    const affected = Object.keys(newOverrides);
    for (const key of affected) overrides[key] = newOverrides[key];
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    for (const key of affected) notifyKey(key);
  }

  function clearOverride(key: string): void {
    if (!(key in overrides)) return;
    delete overrides[key];
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    notifyKey(key);
  }

  function clearOverrides(): void {
    const affected = Object.keys(overrides);
    if (affected.length === 0) return;
    overrides = {};
    const snap = snapshot();
    for (const l of allListeners) l(snap);
    for (const key of affected) notifyKey(key);
  }

  function subscribeStatus(
    listener: (s: ClientStatus) => void,
  ): () => void {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }

  return {
    start,
    refresh,
    getFlag,
    getAllFlags,
    subscribe,
    subscribeAll,
    override,
    clearOverride,
    clearOverrides,
    get isReady() {
      return ready;
    },
    get lastError() {
      return error;
    },
    get status() {
      return publicStatus;
    },
    subscribeStatus,
  };
}

function parseSnapshot(payload: string): Record<string, boolean> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as {
      flags?: Array<{ key: string; enabled: boolean }>;
    };
    if (!parsed || !Array.isArray(parsed.flags)) return null;
    return flagsArrayToRecord(parsed.flags);
  } catch {
    return null;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
