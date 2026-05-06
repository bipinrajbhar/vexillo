import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventSourceOptions } from "eventsource-client";
import { createVexilloClient, type VexilloClient } from "../client";
import {
  type FakeEventSource,
  type FakeFocusSignal,
  makeFakeEs,
  makeFakeFocusSignal,
  makeRestFetch,
  resolveRestOk,
  snapshotMessage,
  flush,
} from "./helpers/wire-fakes";

const BASE_URL = "https://example.com";
const API_KEY = "test-key";

describe("VexilloClient — REST mode", () => {
  let createES: ReturnType<typeof vi.fn>;
  let createdES: FakeEventSource[];
  let restHarness: ReturnType<typeof makeRestFetch>;
  let focus: FakeFocusSignal;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createdES = [];
    createES = vi.fn((opts: EventSourceOptions) => {
      const es = makeFakeEs(opts);
      createdES.push(es);
      return es;
    });
    restHarness = makeRestFetch();
    focus = makeFakeFocusSignal();
    onError = vi.fn();
  });

  function makeClient(
    opts: Partial<Parameters<typeof createVexilloClient>[0]> = {},
  ): VexilloClient {
    return createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      onError,
      fetch: restHarness.fetch,
      createEventSource: createES,
      focusSignal: focus.signal,
      ...opts,
    });
  }

  it("starts in idle status before start() is called", () => {
    const client = makeClient();
    expect(client.status).toBe("idle");
    expect(client.isReady).toBe(false);
    expect(restHarness.pending).toHaveLength(0);
  });

  it("status walks idle → loading → ready on cold start", async () => {
    const client = makeClient();
    const seen: string[] = [];
    client.subscribeStatus((s) => seen.push(s));

    client.start();
    expect(client.status).toBe("loading");
    expect(restHarness.pending).toHaveLength(1);

    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();

    expect(seen).toEqual(["loading", "ready"]);
    expect(client.status).toBe("ready");
    expect(client.isReady).toBe(true);
    expect(client.getAllFlags()).toEqual({ a: true });
  });

  it("status walks idle → loading → error on cold-start REST failure with no initialFlags", async () => {
    const client = makeClient();
    const seen: string[] = [];
    client.subscribeStatus((s) => seen.push(s));

    client.start();
    restHarness.pending[0].resolve({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await flush();

    expect(seen).toEqual(["loading", "error"]);
    expect(client.status).toBe("error");
    expect(client.isReady).toBe(false);
    expect(client.lastError).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalled();
  });

  it("with initialFlags: status starts at ready and start() does not fetch", () => {
    const client = makeClient({ initialFlags: { a: true } });
    expect(client.status).toBe("ready");
    expect(client.isReady).toBe(true);

    client.start();
    expect(restHarness.pending).toHaveLength(0);
  });

  it("subscribes to focus by default in REST mode and refreshes on focus", async () => {
    const client = makeClient();
    client.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(client.status).toBe("ready");
    expect(focus.listenerCount).toBe(1);

    focus.fire();
    expect(restHarness.pending).toHaveLength(1);
    resolveRestOk(restHarness.pending[0], { a: false, b: true });
    await flush();

    expect(client.getAllFlags()).toEqual({ a: false, b: true });
    // Status stays ready across silent refreshes — no flicker.
    expect(client.status).toBe("ready");
  });

  it("autoRefresh.onFocus=false suppresses the focus listener entirely", async () => {
    const client = makeClient({ autoRefresh: { onFocus: false } });
    client.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(focus.listenerCount).toBe(0);

    focus.fire();
    expect(restHarness.pending).toHaveLength(0);
  });

  it("manual refresh() works regardless of autoRefresh", async () => {
    const client = makeClient({ autoRefresh: { onFocus: false } });
    client.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();

    const r = client.refresh();
    expect(restHarness.pending).toHaveLength(1);
    resolveRestOk(restHarness.pending[0], { a: false });
    await r;
    expect(client.getAllFlags()).toEqual({ a: false });
  });

  it("a refresh failure after ready updates lastError but keeps status=ready", async () => {
    const client = makeClient();
    client.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(client.status).toBe("ready");

    const r = client.refresh();
    restHarness.pending[0].resolve({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await r;
    expect(client.status).toBe("ready");
    expect(client.lastError).toBeInstanceOf(Error);
  });

  it("stop() unsubscribes the focus listener and a subsequent focus event does nothing", async () => {
    const client = makeClient();
    const stop = client.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(focus.listenerCount).toBe(1);

    stop();
    expect(focus.listenerCount).toBe(0);

    focus.fire();
    expect(restHarness.pending).toHaveLength(0);
  });

  it("start() called twice without stop returns the same handle and does not double-fetch", () => {
    const client = makeClient();
    const stop1 = client.start();
    const stop2 = client.start();
    expect(stop1).toBe(stop2);
    expect(restHarness.pending).toHaveLength(1);
    expect(focus.listenerCount).toBe(1);
  });

  it("start() after stop() begins a fresh wire activity", async () => {
    const client = makeClient();
    const stop1 = client.start();
    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    stop1();
    expect(focus.listenerCount).toBe(0);

    client.start();
    // status was ready; restart in REST mode with ready=true is a no-op fetch
    expect(restHarness.pending).toHaveLength(0);
    expect(focus.listenerCount).toBe(1);
  });
});

describe("VexilloClient — stream mode", () => {
  let createES: ReturnType<typeof vi.fn>;
  let createdES: FakeEventSource[];
  let restHarness: ReturnType<typeof makeRestFetch>;
  let focus: FakeFocusSignal;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createdES = [];
    createES = vi.fn((opts: EventSourceOptions) => {
      const es = makeFakeEs(opts);
      createdES.push(es);
      return es;
    });
    restHarness = makeRestFetch();
    focus = makeFakeFocusSignal();
    onError = vi.fn();
  });

  function makeClient(
    opts: Partial<Parameters<typeof createVexilloClient>[0]> = {},
  ): VexilloClient {
    return createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      mode: "stream",
      onError,
      fetch: restHarness.fetch,
      createEventSource: createES,
      focusSignal: focus.signal,
      ...opts,
    });
  }

  it("on start() spawns one EventSource and one REST request", () => {
    const client = makeClient();
    client.start();
    expect(client.status).toBe("loading");
    expect(createdES).toHaveLength(1);
    expect(restHarness.pending).toHaveLength(1);
    expect(createdES[0].options.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(createdES[0].options.url).toBe(`${BASE_URL}/api/sdk/flags/stream`);
  });

  it("ignores autoRefresh — no focus listener even with default onFocus=true", () => {
    const client = makeClient();
    client.start();
    expect(focus.listenerCount).toBe(0);
  });

  it("REST wins the race: status loading → ready, getAllFlags has REST flags; SSE message later replaces them", async () => {
    const client = makeClient();
    client.start();

    resolveRestOk(restHarness.pending[0], { a: true });
    await flush();
    expect(client.status).toBe("ready");
    expect(client.getAllFlags()).toEqual({ a: true });

    createdES[0].emit(snapshotMessage({ a: false, b: true }));
    expect(client.getAllFlags()).toEqual({ a: false, b: true });
    expect(client.status).toBe("ready");
  });

  it("SSE wins the race: in-flight REST is aborted and only the SSE flags reach subscribers", async () => {
    const client = makeClient();
    const seen: Record<string, boolean>[] = [];
    client.subscribeAll((flags) => seen.push(flags));
    client.start();

    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();

    expect(client.status).toBe("ready");
    expect(client.getAllFlags()).toEqual({ a: true });
    expect(restHarness.pending).toHaveLength(0);
    expect(seen).toEqual([{ a: true }]);
  });

  it("SSE drop from streaming bridges with a fresh REST; subscribers see the bridge result; SSE return overwrites", async () => {
    const client = makeClient();
    client.start();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();
    expect(client.status).toBe("ready");

    createdES[0].drop();
    expect(restHarness.pending).toHaveLength(1);
    expect(client.status).toBe("ready"); // never flips back

    resolveRestOk(restHarness.pending[0], { a: false, b: true });
    await flush();
    expect(client.getAllFlags()).toEqual({ a: false, b: true });

    createdES[0].emit(snapshotMessage({ c: true }));
    expect(client.getAllFlags()).toEqual({ c: true });
  });

  it("malformed SSE messages are dropped (no transition)", () => {
    const client = makeClient();
    client.start();
    expect(client.status).toBe("loading");

    createdES[0].emit({ data: "{not json", event: undefined, id: undefined });
    expect(client.status).toBe("loading");
    expect(client.isReady).toBe(false);
  });

  it("stop() closes the EventSource and aborts pending REST", () => {
    const client = makeClient();
    const stop = client.start();
    expect(restHarness.pending).toHaveLength(1);

    stop();
    expect(createdES[0].closed).toBe(true);
    expect(restHarness.pending).toHaveLength(0);
  });

  it("manual refresh() works while streaming and overwrites flags", async () => {
    const client = makeClient();
    client.start();
    createdES[0].emit(snapshotMessage({ a: true }));
    await flush();

    const r = client.refresh();
    expect(restHarness.pending).toHaveLength(1);
    resolveRestOk(restHarness.pending[0], { a: false });
    await r;

    expect(client.getAllFlags()).toEqual({ a: false });
    expect(client.status).toBe("ready");
  });

  it("start() is idempotent — only one EventSource opens", () => {
    const client = makeClient();
    client.start();
    client.start();
    expect(createdES).toHaveLength(1);
  });
});

describe("VexilloClient — overrides survive remote updates", () => {
  let restHarness: ReturnType<typeof makeRestFetch>;
  let focus: FakeFocusSignal;

  beforeEach(() => {
    restHarness = makeRestFetch();
    focus = makeFakeFocusSignal();
  });

  it("override() takes precedence over remote; clearOverride reveals the remote value", async () => {
    const client = createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: restHarness.fetch,
      focusSignal: focus.signal,
    });
    client.start();
    resolveRestOk(restHarness.pending[0], { foo: false });
    await flush();
    expect(client.getFlag("foo")).toBe(false);

    client.override({ foo: true });
    expect(client.getFlag("foo")).toBe(true);

    // Another remote update arrives — override still wins.
    focus.fire();
    resolveRestOk(restHarness.pending[0], { foo: false });
    await flush();
    expect(client.getFlag("foo")).toBe(true);

    client.clearOverride("foo");
    expect(client.getFlag("foo")).toBe(false);
  });
});

describe("VexilloClient — re-entrancy", () => {
  let restHarness: ReturnType<typeof makeRestFetch>;
  let focus: FakeFocusSignal;

  beforeEach(() => {
    restHarness = makeRestFetch();
    focus = makeFakeFocusSignal();
  });

  it("a subscribeAll listener that calls stop() during a snapshot does not get clobbered", async () => {
    const client = createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      mode: "stream",
      fetch: restHarness.fetch,
      createEventSource: ((opts: EventSourceOptions) => {
        const es = makeFakeEs(opts);
        // capture so we can emit
        capturedES = es;
        return es;
      }) as unknown as Parameters<
        typeof createVexilloClient
      >[0]["createEventSource"],
      focusSignal: focus.signal,
    });
    let capturedES: ReturnType<typeof makeFakeEs> | undefined;
    let stop: (() => void) | undefined;
    client.subscribeAll(() => {
      if (client.status !== "idle") stop?.();
    });

    stop = client.start();
    capturedES!.emit(snapshotMessage({ a: true }));
    await flush();

    // The listener calls stop during the SSE_SNAPSHOT reduction. Without the
    // queue, the outer reduce would overwrite "closed" with "streaming".
    expect(capturedES!.closed).toBe(true);
    expect(client.getAllFlags()).toEqual({ a: true });
  });
});
