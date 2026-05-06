/**
 * Explicit state machine for the SDK's streaming connection.
 *
 * Replaces a closure that owned seven cooperating `let`s. Lifecycle is
 * modelled as a state union so illegal interleavings (REST overwriting a
 * fresher SSE snapshot, double-reconnect, leaked timer) cannot be
 * represented. The pure SSE parser is delegated to `./sse-parser`.
 *
 * Invariants enforced structurally:
 *  - Cold start races REST and SSE; first to deliver flags transitions to
 *    `rest_won` or `streaming`.
 *  - SSE is authoritative — once in `streaming`, `REST_RESOLVED` is ignored
 *    (no transition).
 *  - On SSE error, REST is bridged again during backoff via `rebridging`.
 *  - Server-driven `retry:` hint overrides the base backoff; backoff doubles
 *    on each consecutive failure, capped at 30 s; resets on a successful
 *    snapshot.
 *  - `Last-Event-ID` is forwarded on every reconnect.
 */

import { createSseParser } from "./sse-parser";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type State =
  | { kind: "idle" }
  | {
      kind: "racing";
      sse: AbortController;
      rest: AbortController;
      lastEventId: string | null;
      retryMs: number;
      backoffMs: number;
    }
  | {
      kind: "rest_won";
      sse: AbortController;
      lastEventId: string | null;
      retryMs: number;
      backoffMs: number;
    }
  | {
      kind: "streaming";
      sse: AbortController;
      lastEventId: string | null;
      retryMs: number;
      backoffMs: number;
    }
  | {
      kind: "reconnecting";
      timer: TimeoutHandle;
      lastEventId: string | null;
      retryMs: number;
      backoffMs: number;
    }
  | {
      kind: "rebridging";
      sse: AbortController;
      rest: AbortController;
      lastEventId: string | null;
      retryMs: number;
      backoffMs: number;
    }
  | { kind: "closed" };

type Event =
  | { type: "START" }
  | { type: "REST_RESOLVED"; flags: Record<string, boolean> }
  | { type: "SSE_ID"; id: string }
  | { type: "SSE_RETRY_HINT"; ms: number }
  | { type: "SSE_SNAPSHOT"; flags: Record<string, boolean> }
  | { type: "SSE_ERROR"; err: Error }
  | { type: "RECONNECT_TIMER_FIRED" }
  | { type: "STOP" };

export type StreamStatus = State["kind"];

export interface StreamConnection {
  start(): void;
  stop(): void;
  readonly status: StreamStatus;
  subscribe(listener: (status: StreamStatus) => void): () => void;
}

export interface StreamConnectionDeps {
  baseUrl: string;
  apiKey: string;
  onSnapshot(flags: Record<string, boolean>): void;
  onError(err: Error): void;
  fetch?: typeof fetch;
  setTimeout?: (cb: () => void, ms: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

export function createStreamConnection(
  deps: StreamConnectionDeps,
): StreamConnection {
  const { baseUrl, apiKey, onSnapshot, onError } = deps;
  const fetchImpl: typeof fetch =
    deps.fetch ?? globalThis.fetch.bind(globalThis);

  let state: State = { kind: "idle" };
  const listeners = new Set<(s: StreamStatus) => void>();

  function schedule(cb: () => void, ms: number): TimeoutHandle {
    const fn = deps.setTimeout ?? globalThis.setTimeout;
    return fn(cb, ms) as TimeoutHandle;
  }

  function unschedule(handle: TimeoutHandle): void {
    const fn = deps.clearTimeout ?? globalThis.clearTimeout;
    fn(handle);
  }

  function notifyStatus(prev: StreamStatus): void {
    if (state.kind === prev) return;
    for (const l of listeners) l(state.kind);
  }

  function startSseFetch(lastEventId: string | null): AbortController {
    const ac = new AbortController();
    void runSse(ac.signal, lastEventId);
    return ac;
  }

  function startRestFetch(): AbortController {
    const ac = new AbortController();
    void runRest(ac.signal);
    return ac;
  }

  async function runRest(signal: AbortSignal): Promise<void> {
    let flags: Record<string, boolean> = {};
    try {
      const res = await fetchImpl(`${baseUrl}/api/sdk/flags`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (signal.aborted) return;
      if (res.ok) {
        const data = (await res.json()) as {
          flags: Array<{ key: string; enabled: boolean }>;
        };
        if (signal.aborted) return;
        const map: Record<string, boolean> = {};
        for (const f of data.flags) map[f.key] = f.enabled;
        flags = map;
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      // network error — fall through with flags={} to mirror fetchFlags()
    }
    if (signal.aborted) return;
    dispatch({ type: "REST_RESOLVED", flags });
  }

  async function runSse(
    signal: AbortSignal,
    lastEventId: string | null,
  ): Promise<void> {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
      };
      if (lastEventId !== null) headers["Last-Event-ID"] = lastEventId;
      const res = await fetchImpl(`${baseUrl}/api/sdk/flags/stream`, {
        headers,
        signal,
      });
      if (signal.aborted) return;
      if (!res.ok || !res.body) {
        dispatch({ type: "SSE_ERROR", err: new Error(`SSE: ${res.status}`) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      while (!signal.aborted) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return;
          dispatch({ type: "SSE_ERROR", err: toErr(err) });
          return;
        }
        if (chunk.done) {
          if (signal.aborted) return;
          dispatch({
            type: "SSE_ERROR",
            err: new Error("SSE: stream ended"),
          });
          return;
        }
        const events = parser.feed(
          decoder.decode(chunk.value, { stream: true }),
        );
        for (const evt of events) {
          if (signal.aborted) return;
          if (evt.kind === "id") {
            dispatch({ type: "SSE_ID", id: evt.value });
          } else if (evt.kind === "retry") {
            dispatch({ type: "SSE_RETRY_HINT", ms: evt.ms });
          } else if (evt.kind === "snapshot") {
            dispatch({ type: "SSE_SNAPSHOT", flags: evt.flags });
          }
        }
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      dispatch({ type: "SSE_ERROR", err: toErr(err) });
    }
  }

  function scheduleReconnect(
    lastEventId: string | null,
    retryMs: number,
    backoffMs: number,
  ): State {
    const timer = schedule(
      () => dispatch({ type: "RECONNECT_TIMER_FIRED" }),
      backoffMs,
    );
    return { kind: "reconnecting", timer, lastEventId, retryMs, backoffMs };
  }

  function dispatch(event: Event): void {
    const prev = state.kind;
    state = reduce(state, event);
    notifyStatus(prev);
  }

  function reduce(s: State, e: Event): State {
    switch (s.kind) {
      case "idle":
        if (e.type === "START") {
          const sse = startSseFetch(null);
          const rest = startRestFetch();
          return {
            kind: "racing",
            sse,
            rest,
            lastEventId: null,
            retryMs: INITIAL_BACKOFF_MS,
            backoffMs: INITIAL_BACKOFF_MS,
          };
        }
        if (e.type === "STOP") return { kind: "closed" };
        return s;

      case "racing":
        switch (e.type) {
          case "REST_RESOLVED":
            onSnapshot(e.flags);
            return {
              kind: "rest_won",
              sse: s.sse,
              lastEventId: s.lastEventId,
              retryMs: s.retryMs,
              backoffMs: s.backoffMs,
            };
          case "SSE_ID":
            return { ...s, lastEventId: e.id };
          case "SSE_RETRY_HINT":
            return { ...s, retryMs: e.ms, backoffMs: e.ms };
          case "SSE_SNAPSHOT":
            onSnapshot(e.flags);
            s.rest.abort();
            return {
              kind: "streaming",
              sse: s.sse,
              lastEventId: s.lastEventId,
              retryMs: s.retryMs,
              backoffMs: s.retryMs,
            };
          case "SSE_ERROR":
            onError(e.err);
            s.rest.abort();
            return scheduleReconnect(s.lastEventId, s.retryMs, s.backoffMs);
          case "STOP":
            s.sse.abort();
            s.rest.abort();
            return { kind: "closed" };
          default:
            return s;
        }

      case "rest_won":
        switch (e.type) {
          case "SSE_ID":
            return { ...s, lastEventId: e.id };
          case "SSE_RETRY_HINT":
            return { ...s, retryMs: e.ms, backoffMs: e.ms };
          case "SSE_SNAPSHOT":
            onSnapshot(e.flags);
            return {
              kind: "streaming",
              sse: s.sse,
              lastEventId: s.lastEventId,
              retryMs: s.retryMs,
              backoffMs: s.retryMs,
            };
          case "SSE_ERROR":
            onError(e.err);
            return scheduleReconnect(s.lastEventId, s.retryMs, s.backoffMs);
          case "STOP":
            s.sse.abort();
            return { kind: "closed" };
          default:
            return s;
        }

      case "streaming":
        switch (e.type) {
          case "SSE_ID":
            return { ...s, lastEventId: e.id };
          case "SSE_RETRY_HINT":
            return { ...s, retryMs: e.ms, backoffMs: e.ms };
          case "SSE_SNAPSHOT":
            onSnapshot(e.flags);
            return { ...s, backoffMs: s.retryMs };
          case "SSE_ERROR":
            onError(e.err);
            return scheduleReconnect(s.lastEventId, s.retryMs, s.backoffMs);
          case "STOP":
            s.sse.abort();
            return { kind: "closed" };
          default:
            return s;
        }

      case "reconnecting":
        switch (e.type) {
          case "RECONNECT_TIMER_FIRED": {
            const newBackoff = Math.min(s.backoffMs * 2, MAX_BACKOFF_MS);
            const sse = startSseFetch(s.lastEventId);
            const rest = startRestFetch();
            return {
              kind: "rebridging",
              sse,
              rest,
              lastEventId: s.lastEventId,
              retryMs: s.retryMs,
              backoffMs: newBackoff,
            };
          }
          case "STOP":
            unschedule(s.timer);
            return { kind: "closed" };
          default:
            return s;
        }

      case "rebridging":
        switch (e.type) {
          case "REST_RESOLVED":
            onSnapshot(e.flags);
            return {
              kind: "rest_won",
              sse: s.sse,
              lastEventId: s.lastEventId,
              retryMs: s.retryMs,
              backoffMs: s.backoffMs,
            };
          case "SSE_ID":
            return { ...s, lastEventId: e.id };
          case "SSE_RETRY_HINT":
            return { ...s, retryMs: e.ms, backoffMs: e.ms };
          case "SSE_SNAPSHOT":
            onSnapshot(e.flags);
            s.rest.abort();
            return {
              kind: "streaming",
              sse: s.sse,
              lastEventId: s.lastEventId,
              retryMs: s.retryMs,
              backoffMs: s.retryMs,
            };
          case "SSE_ERROR":
            onError(e.err);
            s.rest.abort();
            return scheduleReconnect(s.lastEventId, s.retryMs, s.backoffMs);
          case "STOP":
            s.sse.abort();
            s.rest.abort();
            return { kind: "closed" };
          default:
            return s;
        }

      case "closed":
        return s;
    }
  }

  return {
    start(): void {
      if (state.kind === "idle") dispatch({ type: "START" });
    },
    stop(): void {
      if (state.kind !== "closed") dispatch({ type: "STOP" });
    },
    get status(): StreamStatus {
      return state.kind;
    },
    subscribe(listener: (s: StreamStatus) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function toErr(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
