import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventSourceOptions } from "eventsource-client";
import { createVexilloClient, type VexilloClient } from "../client";
import {
  type FakeEventSource,
  makeFakeEs,
  makeRestFetch,
  resolveRestOk,
  snapshotMessage,
  flush,
} from "./helpers/wire-fakes";

const BASE_URL = "https://example.com";
const API_KEY = "test-key";

describe("VexilloClient — connect() / streaming", () => {
  let createES: ReturnType<typeof vi.fn>;
  let createdES: FakeEventSource[];
  let restHarness: ReturnType<typeof makeRestFetch>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createdES = [];
    createES = vi.fn((opts: EventSourceOptions) => {
      const es = makeFakeEs(opts);
      createdES.push(es);
      return es;
    });
    restHarness = makeRestFetch();
    onError = vi.fn();
  });

  function makeClient(): VexilloClient {
    return createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      onError,
      fetch: restHarness.fetch,
      createEventSource: createES,
    });
  }

  // ---------------------------------------------------------------------
  // initial state
  // ---------------------------------------------------------------------

  it("starts in idle and reports connectionStatus", () => {
    const client = makeClient();
    expect(client.connectionStatus).toBe("idle");
    expect(createES).not.toHaveBeenCalled();
  });

  it("on connect() spawns one EventSource and one REST request", () => {
    const client = makeClient();
    client.connect();
    expect(client.connectionStatus).toBe("racing");
    expect(createdES).toHaveLength(1);
    expect(restHarness.pending).toHaveLength(1);
  });

  it("forwards Authorization header to the EventSource", () => {
    const client = makeClient();
    client.connect();
    expect(createdES[0].options.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(createdES[0].options.url).toBe(`${BASE_URL}/api/sdk/flags/stream`);
  });

  // ---------------------------------------------------------------------
  // race resolution
  // ---------------------------------------------------------------------

  it("cold start, REST wins → rest_won; SSE snapshot transitions to streaming", async () => {
    const client = makeClient();
    client.connect();

    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(client.connectionStatus).toBe("rest_won");
    expect(client.getAllFlags()).toEqual({ a: true });
    expect(client.isReady).toBe(true);

    createdES[0].emit(snapshotMessage({ a: false, b: true }));
    expect(client.connectionStatus).toBe("streaming");
    expect(client.getAllFlags()).toEqual({ a: false, b: true });
  });

  it("cold start, SSE wins → streaming; pending REST is aborted", async () => {
    const client = makeClient();
    client.connect();

    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(client.connectionStatus).toBe("streaming");
    expect(client.getAllFlags()).toEqual({ a: true });
    expect(restHarness.pending).toHaveLength(0);
  });

  it("SSE snapshots while streaming keep the client authoritative", async () => {
    const client = makeClient();
    client.connect();

    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(client.connectionStatus).toBe("streaming");

    createdES[0].emit(snapshotMessage({ a: false, b: true }));
    expect(client.connectionStatus).toBe("streaming");
    expect(client.getAllFlags()).toEqual({ a: false, b: true });
  });

  // ---------------------------------------------------------------------
  // SSE disconnects
  // ---------------------------------------------------------------------

  it("disconnect from streaming → bridging; bridge REST wins → rest_won", async () => {
    const client = makeClient();
    client.connect();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(client.connectionStatus).toBe("streaming");

    createdES[0].drop();
    expect(client.connectionStatus).toBe("bridging");
    expect(restHarness.pending).toHaveLength(1);

    resolveRestOk(restHarness.pending[0], { a: false, b: true });
    await flush();
    expect(client.connectionStatus).toBe("rest_won");
    expect(client.getAllFlags()).toEqual({ a: false, b: true });
  });

  it("disconnect from streaming → bridging; SSE returns first → streaming, bridge REST aborted", async () => {
    const client = makeClient();
    client.connect();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    createdES[0].drop();
    expect(client.connectionStatus).toBe("bridging");
    expect(restHarness.pending).toHaveLength(1);

    createdES[0].emit(snapshotMessage({ c: true }));
    expect(client.connectionStatus).toBe("streaming");
    expect(client.getAllFlags()).toEqual({ c: true });
    expect(restHarness.pending).toHaveLength(0);
  });

  it("disconnect from rest_won → bridging (REST flags kept fresh during reconnect gap)", async () => {
    const client = makeClient();
    client.connect();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(client.connectionStatus).toBe("rest_won");

    createdES[0].drop();
    expect(client.connectionStatus).toBe("bridging");
    expect(restHarness.pending).toHaveLength(1);
  });

  it("disconnect during racing keeps state in racing (cold-start REST already in flight)", async () => {
    const client = makeClient();
    client.connect();
    expect(restHarness.pending).toHaveLength(1);

    createdES[0].drop();
    expect(client.connectionStatus).toBe("racing");
    expect(restHarness.pending).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // malformed / errors
  // ---------------------------------------------------------------------

  it("malformed SSE message is dropped (no transition)", () => {
    const client = makeClient();
    client.connect();
    expect(client.connectionStatus).toBe("racing");

    createdES[0].emit({ data: "{not json", event: undefined, id: undefined });
    expect(client.connectionStatus).toBe("racing");
    expect(client.getAllFlags()).toEqual({});
  });

  it("on REST HTTP error during racing, reports onError but stays in racing", async () => {
    const client = makeClient();
    client.connect();
    restHarness.pending[0].resolve({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(client.lastError).toBeInstanceOf(Error);
    expect(client.connectionStatus).toBe("racing");
    expect(client.getAllFlags()).toEqual({});
  });

  it("on REST HTTP error during bridging, reports onError but stays in bridging", async () => {
    const client = makeClient();
    client.connect();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    createdES[0].drop();
    expect(client.connectionStatus).toBe("bridging");

    restHarness.pending[0].resolve({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(client.connectionStatus).toBe("bridging");
    // Snapshot from before the disconnect must not be clobbered.
    expect(client.getAllFlags()).toEqual({ a: true });
  });

  // ---------------------------------------------------------------------
  // disconnect / STOP
  // ---------------------------------------------------------------------

  it("disconnect from racing closes the EventSource and aborts REST", () => {
    const client = makeClient();
    const disconnect = client.connect();
    expect(restHarness.pending).toHaveLength(1);

    disconnect();
    expect(client.connectionStatus).toBe("closed");
    expect(createdES[0].closed).toBe(true);
    expect(restHarness.pending).toHaveLength(0);
  });

  it("disconnect from bridging closes the EventSource and aborts the bridge REST", async () => {
    const client = makeClient();
    const disconnect = client.connect();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    createdES[0].drop();
    expect(client.connectionStatus).toBe("bridging");

    disconnect();
    expect(client.connectionStatus).toBe("closed");
    expect(createdES[0].closed).toBe(true);
    expect(restHarness.pending).toHaveLength(0);
  });

  it("disconnect from streaming closes the EventSource", async () => {
    const client = makeClient();
    const disconnect = client.connect();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();

    disconnect();
    expect(client.connectionStatus).toBe("closed");
    expect(createdES[0].closed).toBe(true);
  });

  // ---------------------------------------------------------------------
  // status listener
  // ---------------------------------------------------------------------

  it("emits status changes via subscribeConnectionStatus", async () => {
    const client = makeClient();
    const seen: string[] = [];
    client.subscribeConnectionStatus((s) => seen.push(s));

    client.connect();
    expect(seen).toContain("racing");
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(seen).toContain("rest_won");
    createdES[0].emit(snapshotMessage({ a: true }));
    expect(seen).toContain("streaming");
  });

  // ---------------------------------------------------------------------
  // idempotence
  // ---------------------------------------------------------------------

  it("connect() called twice in a row only opens one EventSource", () => {
    const client = makeClient();
    client.connect();
    expect(createdES).toHaveLength(1);
    client.connect();
    expect(createdES).toHaveLength(1);
  });

  it("connect() after disconnect() restarts a fresh EventSource", () => {
    const client = makeClient();
    const disconnect = client.connect();
    expect(createdES).toHaveLength(1);
    disconnect();
    expect(client.connectionStatus).toBe("closed");

    client.connect();
    expect(createdES).toHaveLength(2);
    expect(client.connectionStatus).toBe("racing");
  });

  // ---------------------------------------------------------------------
  // re-entrancy
  // ---------------------------------------------------------------------

  it("a subscribeAll listener that calls disconnect during a snapshot does not get clobbered", async () => {
    const client = makeClient();
    let disconnect: (() => void) | undefined;
    client.subscribeAll(() => {
      if (client.connectionStatus !== "closed") disconnect?.();
    });

    disconnect = client.connect();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();

    expect(client.connectionStatus).toBe("closed");
    expect(createdES[0].closed).toBe(true);
  });

  // ---------------------------------------------------------------------
  // load() backward compatibility
  // ---------------------------------------------------------------------

  it("load() walks idle → loading → closed and resolves when REST settles", async () => {
    const client = makeClient();
    const seen: string[] = [];
    client.subscribeConnectionStatus((s) => seen.push(s));

    const loaded = client.load();
    expect(client.connectionStatus).toBe("loading");
    expect(restHarness.pending).toHaveLength(1);

    resolveRestOk(restHarness.pending[0], { a: true });
    await loaded;

    expect(seen).toEqual(["loading", "closed"]);
    expect(client.connectionStatus).toBe("closed");
    expect(client.getAllFlags()).toEqual({ a: true });
    expect(client.isReady).toBe(true);
  });

  it("load() flips isReady=true and reports onError on HTTP failure", async () => {
    const client = makeClient();
    const loaded = client.load();
    restHarness.pending[0].resolve({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await loaded;
    expect(client.connectionStatus).toBe("closed");
    expect(client.isReady).toBe(true);
    expect(client.lastError).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalled();
  });

  it("load() while a stream is live is a no-op and resolves immediately", async () => {
    const client = makeClient();
    client.connect();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(client.connectionStatus).toBe("streaming");

    const before = restHarness.pending.length;
    await client.load();
    expect(restHarness.pending.length).toBe(before);
    expect(client.connectionStatus).toBe("streaming");
  });

  // ---------------------------------------------------------------------
  // connectStream() backward compatibility
  // ---------------------------------------------------------------------

  it("connectStream() is equivalent to connect() with default streaming", async () => {
    const client = makeClient();
    const disconnect = client.connectStream();
    expect(client.connectionStatus).toBe("racing");
    expect(createdES).toHaveLength(1);

    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(client.connectionStatus).toBe("streaming");

    disconnect();
    expect(client.connectionStatus).toBe("closed");
  });

  // ---------------------------------------------------------------------
  // connect({ streaming: false })
  // ---------------------------------------------------------------------

  it("connect({ streaming: false }) on a fresh client triggers a one-shot REST", async () => {
    const client = makeClient();
    client.connect({ streaming: false });
    expect(client.connectionStatus).toBe("loading");
    expect(restHarness.pending).toHaveLength(1);
    expect(createdES).toHaveLength(0);

    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(client.connectionStatus).toBe("closed");
  });

  it("connect({ streaming: false }) is a no-op when the client is already ready", () => {
    const client = createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      initialFlags: { a: true },
      fetch: restHarness.fetch,
      createEventSource: createES,
    });
    expect(client.isReady).toBe(true);

    client.connect({ streaming: false });
    expect(client.connectionStatus).toBe("idle");
    expect(restHarness.pending).toHaveLength(0);
  });
});
