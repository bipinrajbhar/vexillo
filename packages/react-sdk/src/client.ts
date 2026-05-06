import {
  createEventSource,
  type EventSourceClient,
  type EventSourceOptions,
} from "eventsource-client";
import { flagsArrayToRecord } from "./fetch-flags";

/**
 * Lifecycle state of the client's wire connection.
 *
 * - `idle` — never connected; `initialFlags` may have populated `remoteFlags`.
 * - `loading` — one-shot REST in flight (from `load()` / `connect({ streaming: false })`).
 * - `racing` — REST + SSE both live; first to deliver wins.
 * - `rest_won` — REST resolved first; SSE still opening.
 * - `streaming` — SSE authoritative.
 * - `bridging` — SSE dropped from a settled state; fresh REST keeps flags warm.
 * - `closed` — `disconnect()` called or terminal failure. The next `connect()` /
 *   `load()` resets the connection.
 */
export type ConnectionStatus =
  | "idle"
  | "loading"
  | "racing"
  | "rest_won"
  | "streaming"
  | "bridging"
  | "closed";

export interface VexilloClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Pre-resolved flags. When provided, isReady is true immediately. */
  initialFlags?: Record<string, boolean>;
  /** Returned for unknown keys when no remote value exists. */
  fallbacks?: Record<string, boolean>;
  /** Called on every wire error (one-shot REST, race REST, bridge REST). */
  onError?: (err: Error) => void;
  /** @internal — escape hatch for tests. */
  fetch?: typeof fetch;
  /** @internal — escape hatch for tests. */
  createEventSource?: (opts: EventSourceOptions) => EventSourceClient;
}

export interface VexilloClient {
  /**
   * @deprecated Prefer `connect({ streaming: false })`. One-shot REST fetch.
   * Resolves when the request completes (success or failure). `isReady` flips
   * to true on completion regardless of outcome.
   */
  load(): Promise<void>;
  /**
   * @deprecated Prefer `connect()`. Opens a persistent SSE stream that races
   * a REST fetch on cold start and keeps a bridge REST fresh on disconnect.
   * Returns a disconnect function.
   */
  connectStream(): () => void;
  /**
   * Unified entry point. With `streaming: true` (default), races REST + SSE
   * and bridges on disconnect. With `streaming: false`, fires a single REST
   * fetch (no-op if `isReady` is already true). Returns a disconnect function.
   */
  connect(opts?: { streaming?: boolean }): () => void;
  /** Synchronous read. Priority: overrides > remote > fallbacks > false. */
  getFlag(key: string): boolean;
  /** Snapshot of all resolved flags (overrides + remote + fallbacks merged). */
  getAllFlags(): Record<string, boolean>;
  /**
   * Subscribe to changes on a specific key. Fires on snapshot delivery,
   * override(), and clearOverride(). Returns an unsubscribe function.
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
  readonly connectionStatus: ConnectionStatus;
  /** Subscribe to connection-status transitions. Returns an unsubscribe function. */
  subscribeConnectionStatus(
    listener: (status: ConnectionStatus) => void,
  ): () => void;
}

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

export function createVexilloClient(config: VexilloClientConfig): VexilloClient {
  const { baseUrl, apiKey, fallbacks = {}, onError } = config;
  const fetchImpl: typeof fetch =
    config.fetch ?? globalThis.fetch.bind(globalThis);
  const makeEventSource = config.createEventSource ?? createEventSource;

  let remoteFlags: Record<string, boolean> = config.initialFlags ?? {};
  let overrides: Record<string, boolean> = {};
  let ready = config.initialFlags !== undefined;
  let error: Error | null = null;

  const keyListeners = new Map<string, Set<(value: boolean) => void>>();
  const allListeners = new Set<(flags: Record<string, boolean>) => void>();
  const statusListeners = new Set<(s: ConnectionStatus) => void>();

  let conn: ConnState = { kind: "idle" };
  const pendingLoadResolvers: Array<() => void> = [];

  // Re-entrancy guard: a snapshot/status listener may synchronously trigger
  // another dispatch (e.g. calling disconnect() inside subscribeAll). Queue
  // those events so the outer reduce's state assignment isn't clobbered.
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

  function applySnapshot(flags: Record<string, boolean>): void {
    remoteFlags = flags;
    error = null;
    ready = true;
    notifyAll();
  }

  function reportError(err: Error): void {
    error = err;
    onError?.(err);
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
        if (conn.kind !== prev) {
          for (const l of statusListeners) l(conn.kind);
          // Drain load() promise resolvers when LOAD lifecycle settles.
          if (prev === "loading" && pendingLoadResolvers.length > 0) {
            const resolvers = pendingLoadResolvers.splice(0);
            for (const r of resolvers) r();
          }
        }
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

    // Disconnect from a settled state bridges with a fresh REST. Other states
    // either already have a REST in flight or are not active.
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
          // BC: load() flips ready=true even on error so consumers stop
          // showing a loading spinner and fall through to fallbacks.
          ready = true;
          notifyAll();
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

  function load(): Promise<void> {
    if (conn.kind !== "idle" && conn.kind !== "closed") {
      return Promise.resolve();
    }
    return new Promise<void>((resolveLoad) => {
      pendingLoadResolvers.push(resolveLoad);
      dispatch({ type: "LOAD" });
    });
  }

  function connectStream(): () => void {
    if (conn.kind === "idle" || conn.kind === "closed") {
      dispatch({ type: "CONNECT" });
    }
    return () => {
      if (conn.kind !== "closed") dispatch({ type: "STOP" });
    };
  }

  function connect(opts?: { streaming?: boolean }): () => void {
    const streaming = opts?.streaming !== false;
    if (streaming) {
      if (conn.kind === "idle" || conn.kind === "closed") {
        dispatch({ type: "CONNECT" });
      }
    } else if (
      !ready &&
      (conn.kind === "idle" || conn.kind === "closed")
    ) {
      dispatch({ type: "LOAD" });
    }
    return () => {
      if (conn.kind !== "closed") dispatch({ type: "STOP" });
    };
  }

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

  function subscribeConnectionStatus(
    listener: (s: ConnectionStatus) => void,
  ): () => void {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }

  return {
    load,
    connectStream,
    connect,
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
    get connectionStatus() {
      return conn.kind;
    },
    subscribeConnectionStatus,
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
