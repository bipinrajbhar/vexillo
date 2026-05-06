import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  EventSourceClient,
  EventSourceMessage,
  EventSourceOptions,
} from "eventsource-client";
import { createStreamConnection } from "../stream-connection";

const BASE_URL = "https://example.com";
const API_KEY = "test-key";

// ---------------------------------------------------------------------------
// Fake EventSource: drives the state machine via the lib's callback contract.
// ---------------------------------------------------------------------------

interface FakeEventSource extends EventSourceClient {
  options: EventSourceOptions;
  closed: boolean;
  emit(msg: EventSourceMessage): void;
  drop(): void;
}

function makeFakeEs(opts: EventSourceOptions): FakeEventSource {
  let readyState: EventSourceClient["readyState"] = "connecting";
  let closed = false;
  const fake = {
    options: opts,
    get closed() {
      return closed;
    },
    get readyState() {
      return readyState;
    },
    lastEventId: undefined,
    url: typeof opts.url === "string" ? opts.url : opts.url.toString(),
    close() {
      closed = true;
      readyState = "closed";
    },
    connect() {
      readyState = "connecting";
    },
    [Symbol.iterator](): never {
      throw new Error("sync iteration unsupported");
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<EventSourceMessage> {
      throw new Error("async iteration not used in tests");
    },
    emit(msg: EventSourceMessage) {
      opts.onMessage?.(msg);
    },
    drop() {
      readyState = "connecting";
      opts.onDisconnect?.();
    },
  };
  return fake as unknown as FakeEventSource;
}

// ---------------------------------------------------------------------------
// REST fake: pending fetches resolved/rejected by the test.
// ---------------------------------------------------------------------------

interface PendingRest {
  url: string;
  init: RequestInit;
  resolve: (response: unknown) => void;
  reject: (err: Error) => void;
}

function makeRestFetch(): {
  fetch: typeof fetch;
  pending: PendingRest[];
} {
  const pending: PendingRest[] = [];
  const fakeFetch: typeof fetch = ((
    url: string | URL | Request,
    init: RequestInit = {},
  ) => {
    return new Promise((nativeResolve, nativeReject) => {
      const u = typeof url === "string" ? url : url.toString();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        const i = pending.indexOf(p);
        if (i !== -1) pending.splice(i, 1);
      };
      const p: PendingRest = {
        url: u,
        init,
        resolve: (r) => {
          settle();
          nativeResolve(r as Response);
        },
        reject: (e) => {
          settle();
          nativeReject(e);
        },
      };
      pending.push(p);
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        p.reject(err);
      });
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, pending };
}

function resolveRestOk(
  p: PendingRest,
  flags: Record<string, boolean>,
): void {
  const arr = Object.entries(flags).map(([key, enabled]) => ({ key, enabled }));
  p.resolve({
    ok: true,
    status: 200,
    json: async () => ({ flags: arr }),
  });
}

function snapshotMessage(flags: Record<string, boolean>): EventSourceMessage {
  const arr = Object.entries(flags).map(([key, enabled]) => ({ key, enabled }));
  return {
    data: JSON.stringify({ flags: arr }),
    event: undefined,
    id: undefined,
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createStreamConnection", () => {
  let createES: ReturnType<typeof vi.fn>;
  let createdES: FakeEventSource[];
  let restHarness: ReturnType<typeof makeRestFetch>;
  let onSnapshot: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createdES = [];
    createES = vi.fn((opts: EventSourceOptions) => {
      const es = makeFakeEs(opts);
      createdES.push(es);
      return es;
    });
    restHarness = makeRestFetch();
    onSnapshot = vi.fn();
    onError = vi.fn();
  });

  function makeConn() {
    return createStreamConnection({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      onSnapshot,
      onError,
      fetch: restHarness.fetch,
      createEventSource: createES,
    });
  }

  it("starts in idle and reports status", () => {
    const conn = makeConn();
    expect(conn.status).toBe("idle");
    expect(createES).not.toHaveBeenCalled();
  });

  it("on start() spawns one EventSource and one REST request", () => {
    const conn = makeConn();
    conn.start();
    expect(conn.status).toBe("racing");
    expect(createdES).toHaveLength(1);
    expect(restHarness.pending).toHaveLength(1);
  });

  it("forwards Authorization header to the EventSource", () => {
    const conn = makeConn();
    conn.start();
    expect(createdES[0].options.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(createdES[0].options.url).toBe(`${BASE_URL}/api/sdk/flags/stream`);
  });

  it("cold start, REST wins → rest_won; SSE snapshot then transitions to streaming", async () => {
    const conn = makeConn();
    conn.start();

    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(conn.status).toBe("rest_won");
    expect(onSnapshot).toHaveBeenCalledWith({ a: true });

    createdES[0].emit(snapshotMessage({ a: false, b: true }));
    expect(conn.status).toBe("streaming");
    expect(onSnapshot).toHaveBeenLastCalledWith({ a: false, b: true });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it("cold start, SSE wins → streaming; pending REST is aborted", async () => {
    const conn = makeConn();
    conn.start();

    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(conn.status).toBe("streaming");
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith({ a: true });
    // REST was aborted — nothing pending.
    expect(restHarness.pending).toHaveLength(0);
  });

  it("REST_RESOLVED has no transition from streaming (SSE-authoritative)", async () => {
    const conn = makeConn();
    conn.start();

    // Settle into streaming.
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(conn.status).toBe("streaming");
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    // Pending REST is aborted, but verify nothing else can apply.
    expect(restHarness.pending).toHaveLength(0);
  });

  it("disconnect from streaming → bridging; bridge REST wins → rest_won", async () => {
    const conn = makeConn();
    conn.start();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(conn.status).toBe("streaming");

    createdES[0].drop();
    expect(conn.status).toBe("bridging");
    expect(restHarness.pending).toHaveLength(1);

    resolveRestOk(restHarness.pending[0], { a: false, b: true });
    await flush();
    expect(conn.status).toBe("rest_won");
    expect(onSnapshot).toHaveBeenLastCalledWith({ a: false, b: true });
  });

  it("disconnect from streaming → bridging; SSE returns first → streaming, bridge REST aborted", async () => {
    const conn = makeConn();
    conn.start();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    createdES[0].drop();
    expect(conn.status).toBe("bridging");
    expect(restHarness.pending).toHaveLength(1);

    createdES[0].emit(snapshotMessage({ c: true }));
    expect(conn.status).toBe("streaming");
    expect(onSnapshot).toHaveBeenLastCalledWith({ c: true });
    expect(restHarness.pending).toHaveLength(0);
  });

  it("disconnect from rest_won → bridging (REST flags kept fresh during reconnect gap)", async () => {
    const conn = makeConn();
    conn.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(conn.status).toBe("rest_won");

    createdES[0].drop();
    expect(conn.status).toBe("bridging");
    expect(restHarness.pending).toHaveLength(1);
  });

  it("disconnect during racing keeps state in racing (cold-start REST already in flight)", async () => {
    const conn = makeConn();
    conn.start();
    expect(restHarness.pending).toHaveLength(1);

    createdES[0].drop();
    expect(conn.status).toBe("racing");
    // No second REST spawned — the initial one is still pending.
    expect(restHarness.pending).toHaveLength(1);
  });

  it("malformed SSE message is dropped (no transition)", async () => {
    const conn = makeConn();
    conn.start();
    expect(conn.status).toBe("racing");

    createdES[0].emit({ data: "{not json", event: undefined, id: undefined });
    expect(conn.status).toBe("racing");
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("STOP from racing closes the EventSource and aborts REST", async () => {
    const conn = makeConn();
    conn.start();
    expect(restHarness.pending).toHaveLength(1);

    conn.stop();
    expect(conn.status).toBe("closed");
    expect(createdES[0].closed).toBe(true);
    expect(restHarness.pending).toHaveLength(0);
  });

  it("STOP from bridging closes the EventSource and aborts the bridge REST", async () => {
    const conn = makeConn();
    conn.start();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    createdES[0].drop();
    expect(conn.status).toBe("bridging");

    conn.stop();
    expect(conn.status).toBe("closed");
    expect(createdES[0].closed).toBe(true);
    expect(restHarness.pending).toHaveLength(0);
  });

  it("STOP from streaming closes the EventSource", async () => {
    const conn = makeConn();
    conn.start();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();

    conn.stop();
    expect(conn.status).toBe("closed");
    expect(createdES[0].closed).toBe(true);
  });

  it("emits status changes to subscribers", async () => {
    const conn = makeConn();
    const seen: string[] = [];
    conn.subscribe((s) => seen.push(s));

    conn.start();
    expect(seen).toContain("racing");
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(seen).toContain("rest_won");
    createdES[0].emit(snapshotMessage({ a: true }));
    expect(seen).toContain("streaming");
  });

  it("repeated start() while not idle is a no-op", () => {
    const conn = makeConn();
    conn.start();
    expect(createdES).toHaveLength(1);
    conn.start();
    expect(createdES).toHaveLength(1);
  });

  it("on REST HTTP error, reports onError but stays in racing for SSE to resolve", async () => {
    const conn = makeConn();
    conn.start();
    restHarness.pending[0].resolve({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await flush();
    expect(onError).toHaveBeenCalled();
    // REST failure no longer overwrites with empty flags — fresh streaming
    // data must not be clobbered by a 500 from a bridge REST.
    expect(conn.status).toBe("racing");
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("a listener that calls stop() during onSnapshot does not get clobbered by re-entrant dispatch", async () => {
    const conn = makeConn();
    conn.subscribe(() => {});
    onSnapshot.mockImplementation(() => {
      // First snapshot from REST triggers a synchronous stop.
      if (conn.status !== "closed") conn.stop();
    });

    conn.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();

    // Without the re-entrancy queue, the outer reduce would overwrite
    // 'closed' with 'rest_won'. With it, stop wins.
    expect(conn.status).toBe("closed");
    expect(createdES[0].closed).toBe(true);
  });
});
