/**
 * REST↔SSE race state machine.
 *
 * Wire-level concerns (SSE fetch, parsing, auto-reconnect, Last-Event-ID,
 * server `retry:` hint) are delegated to `eventsource-client`. This
 * module owns only the SDK's race contract:
 *
 *  - Cold start: REST and SSE race; first to deliver flags transitions
 *    out of `racing`.
 *  - SSE is authoritative — once a snapshot has arrived, `REST_RESOLVED`
 *    has no transition (the in-flight REST is aborted on SSE win).
 *  - On every disconnect from a settled state, fire a fresh REST so
 *    consumers stay current during the reconnect gap.
 */

import {
  createEventSource,
  type EventSourceClient,
  type EventSourceOptions,
} from "eventsource-client";
import { flagsArrayToRecord } from "./fetch-flags";

type State =
  | { kind: "idle" }
  | { kind: "racing"; es: EventSourceClient; rest: AbortController }
  | { kind: "rest_won"; es: EventSourceClient }
  | { kind: "streaming"; es: EventSourceClient }
  | { kind: "bridging"; es: EventSourceClient; rest: AbortController }
  | { kind: "closed" };

type Event =
  | { type: "START" }
  | { type: "REST_RESOLVED"; flags: Record<string, boolean> }
  | { type: "SSE_SNAPSHOT"; flags: Record<string, boolean> }
  | { type: "SSE_DISCONNECTED" }
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
  /** @internal — escape hatch for tests. */
  createEventSource?: (opts: EventSourceOptions) => EventSourceClient;
}

export function createStreamConnection(
  deps: StreamConnectionDeps,
): StreamConnection {
  const { baseUrl, apiKey, onSnapshot, onError } = deps;
  const fetchImpl: typeof fetch =
    deps.fetch ?? globalThis.fetch.bind(globalThis);
  const makeEventSource = deps.createEventSource ?? createEventSource;

  let state: State = { kind: "idle" };
  const listeners = new Set<(s: StreamStatus) => void>();

  // Re-entrancy guard: if a side effect (e.g. an onSnapshot listener calling
  // conn.stop) triggers another dispatch, queue it so the outer reduce's
  // state assignment doesn't clobber the inner transition.
  let dispatching = false;
  const queue: Event[] = [];

  function dispatch(event: Event): void {
    queue.push(event);
    if (dispatching) return;
    dispatching = true;
    try {
      while (queue.length > 0) {
        const e = queue.shift() as Event;
        const prev = state.kind;
        state = reduce(state, e);
        if (state.kind !== prev) {
          for (const l of listeners) l(state.kind);
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
        onError(new Error(`REST: ${res.status}`));
        return;
      }
      const data = (await res.json()) as {
        flags: Array<{ key: string; enabled: boolean }>;
      };
      if (signal.aborted) return;
      dispatch({ type: "REST_RESOLVED", flags: flagsArrayToRecord(data.flags) });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function reduce(s: State, e: Event): State {
    // STOP is terminal from any non-closed state.
    if (e.type === "STOP") {
      if ("rest" in s) s.rest.abort();
      if ("es" in s) s.es.close();
      return { kind: "closed" };
    }

    // Disconnect from a settled state bridges with a fresh REST. Other
    // states either already have a REST in flight (racing/bridging) or are
    // not active (idle/closed) — leave them untouched.
    if (e.type === "SSE_DISCONNECTED") {
      if (s.kind === "rest_won" || s.kind === "streaming") {
        return { kind: "bridging", es: s.es, rest: startRest() };
      }
      return s;
    }

    switch (s.kind) {
      case "idle":
        if (e.type === "START") {
          return {
            kind: "racing",
            es: startEventSource(),
            rest: startRest(),
          };
        }
        return s;

      case "racing":
        if (e.type === "REST_RESOLVED") return restWon(s.es, e.flags);
        if (e.type === "SSE_SNAPSHOT") return streamingFromRace(s, e.flags);
        return s;

      case "rest_won":
        if (e.type === "SSE_SNAPSHOT") {
          onSnapshot(e.flags);
          return { kind: "streaming", es: s.es };
        }
        return s;

      case "streaming":
        if (e.type === "SSE_SNAPSHOT") {
          onSnapshot(e.flags);
          return s;
        }
        return s;

      case "bridging":
        if (e.type === "REST_RESOLVED") return restWon(s.es, e.flags);
        if (e.type === "SSE_SNAPSHOT") return streamingFromRace(s, e.flags);
        return s;

      case "closed":
        return s;
    }
  }

  function restWon(
    es: EventSourceClient,
    flags: Record<string, boolean>,
  ): State {
    onSnapshot(flags);
    return { kind: "rest_won", es };
  }

  function streamingFromRace(
    s: { es: EventSourceClient; rest: AbortController },
    flags: Record<string, boolean>,
  ): State {
    onSnapshot(flags);
    s.rest.abort();
    return { kind: "streaming", es: s.es };
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
