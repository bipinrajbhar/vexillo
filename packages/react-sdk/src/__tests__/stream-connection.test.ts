import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamConnection } from "../stream-connection";

const BASE_URL = "https://example.com";
const API_KEY = "test-key";

// ---------------------------------------------------------------------------
// Test harness: fake fetch + fake reader (control SSE byte stream by hand)
// ---------------------------------------------------------------------------

interface PendingFetch {
  url: string;
  init: RequestInit;
  resolve: (response: unknown) => void;
  reject: (err: Error) => void;
}

class FakeReader {
  private current: {
    resolve: (r: { done: boolean; value?: Uint8Array }) => void;
    reject: (e: Error) => void;
  } | null = null;

  read(): Promise<{ done: boolean; value?: Uint8Array }> {
    return new Promise((resolve, reject) => {
      this.current = { resolve, reject };
    });
  }

  push(text: string): void {
    const c = this.current;
    if (!c) throw new Error("FakeReader.push: no pending read");
    this.current = null;
    c.resolve({ done: false, value: new TextEncoder().encode(text) });
  }

  endStream(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.resolve({ done: true, value: undefined });
  }

  errorOut(err: Error): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.reject(err);
  }

  cancel(): void {
    this.errorOut(makeAbortError());
  }
}

class FakeFetchHarness {
  private rest: PendingFetch[] = [];
  private sse: PendingFetch[] = [];

  fetch: typeof fetch = ((url: string | URL, init: RequestInit = {}) => {
    const u = typeof url === "string" ? url : url.toString();
    const slot = u.endsWith("/stream") ? this.sse : this.rest;
    return new Promise((resolve, reject) => {
      const p: PendingFetch = {
        url: u,
        init,
        resolve: resolve as (r: unknown) => void,
        reject,
      };
      slot.push(p);
      init.signal?.addEventListener("abort", () => {
        const i = slot.indexOf(p);
        if (i !== -1) slot.splice(i, 1);
        reject(makeAbortError());
      });
    });
  }) as typeof fetch;

  pendingRest(): number {
    return this.rest.length;
  }
  pendingSse(): number {
    return this.sse.length;
  }
  takeRest(): PendingFetch {
    const p = this.rest.shift();
    if (!p) throw new Error("FakeFetchHarness: no pending REST request");
    return p;
  }
  takeSse(): PendingFetch {
    const p = this.sse.shift();
    if (!p) throw new Error("FakeFetchHarness: no pending SSE request");
    return p;
  }
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function resolveRestOk(p: PendingFetch, flags: Record<string, boolean>): void {
  const arr = Object.entries(flags).map(([key, enabled]) => ({ key, enabled }));
  p.resolve({
    ok: true,
    status: 200,
    json: async () => ({ flags: arr }),
  });
}

function resolveSseOk(p: PendingFetch, reader: FakeReader): void {
  p.resolve({
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  });
  // Mirror real fetch behaviour: aborting cancels the reader.
  p.init.signal?.addEventListener("abort", () => reader.cancel());
}

function snapshotChunk(flags: Record<string, boolean>): string {
  const arr = Object.entries(flags).map(([key, enabled]) => ({ key, enabled }));
  return `data: ${JSON.stringify({ flags: arr })}\n`;
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createStreamConnection", () => {
  let harness: FakeFetchHarness;
  let onSnapshot: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let setTimeoutSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = new FakeFetchHarness();
    onSnapshot = vi.fn();
    onError = vi.fn();
    setTimeoutSpy = vi.fn((cb: () => void, ms: number) =>
      globalThis.setTimeout(cb, ms),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeConn() {
    return createStreamConnection({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      onSnapshot,
      onError,
      fetch: harness.fetch,
      setTimeout: setTimeoutSpy as unknown as (
        cb: () => void,
        ms: number,
      ) => ReturnType<typeof setTimeout>,
    });
  }

  it("starts in idle and reports status", () => {
    const conn = makeConn();
    expect(conn.status).toBe("idle");
  });

  it("emits status changes to subscribers", async () => {
    const conn = makeConn();
    const seen: string[] = [];
    conn.subscribe((s) => seen.push(s));

    conn.start();
    expect(seen).toContain("racing");

    resolveRestOk(harness.takeRest(), { a: true });
    await flush();
    expect(seen).toContain("rest_won");
  });

  it("cold start, REST wins: racing → rest_won; later SSE snapshot → streaming and overwrites", async () => {
    const conn = makeConn();
    conn.start();
    expect(conn.status).toBe("racing");
    expect(harness.pendingRest()).toBe(1);
    expect(harness.pendingSse()).toBe(1);

    resolveRestOk(harness.takeRest(), { a: true });
    await flush();
    expect(conn.status).toBe("rest_won");
    expect(onSnapshot).toHaveBeenCalledWith({ a: true });

    const reader = new FakeReader();
    resolveSseOk(harness.takeSse(), reader);
    await flush();
    reader.push(snapshotChunk({ a: false, b: true }));
    await flush();

    expect(conn.status).toBe("streaming");
    expect(onSnapshot).toHaveBeenLastCalledWith({ a: false, b: true });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it("cold start, SSE wins: racing → streaming; pending REST is aborted and never applied", async () => {
    const conn = makeConn();
    conn.start();

    const reader = new FakeReader();
    resolveSseOk(harness.takeSse(), reader);
    await flush();
    reader.push(snapshotChunk({ a: true }));
    await flush();

    expect(conn.status).toBe("streaming");
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith({ a: true });
    // Cold-start REST was aborted on SSE win — nothing pending.
    expect(harness.pendingRest()).toBe(0);
  });

  it("SSE error from streaming → reconnecting; timer fires → rebridging; REST wins rerace", async () => {
    const conn = makeConn();
    conn.start();

    // Settle into streaming.
    resolveRestOk(harness.takeRest(), {});
    await flush();
    const reader1 = new FakeReader();
    resolveSseOk(harness.takeSse(), reader1);
    await flush();
    reader1.push(snapshotChunk({ a: true }));
    await flush();
    expect(conn.status).toBe("streaming");

    // SSE errors → reconnecting.
    reader1.errorOut(new Error("connection dropped"));
    await flush();
    expect(conn.status).toBe("reconnecting");
    expect(onError).toHaveBeenCalled();

    // Initial backoff delay is 1000ms.
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);

    // Timer fires → rebridging spawns BOTH REST and SSE.
    vi.advanceTimersByTime(1000);
    await flush();
    expect(conn.status).toBe("rebridging");
    expect(harness.pendingRest()).toBe(1);
    expect(harness.pendingSse()).toBe(1);

    // REST wins the rerace.
    resolveRestOk(harness.takeRest(), { a: false, b: true });
    await flush();
    expect(conn.status).toBe("rest_won");
    expect(onSnapshot).toHaveBeenLastCalledWith({ a: false, b: true });
  });

  it("rebridging: SSE wins the rerace; late REST is dropped", async () => {
    const conn = makeConn();
    conn.start();
    resolveRestOk(harness.takeRest(), {});
    await flush();
    const reader1 = new FakeReader();
    resolveSseOk(harness.takeSse(), reader1);
    await flush();
    reader1.push(snapshotChunk({ a: true }));
    await flush();

    reader1.errorOut(new Error("dropped"));
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(conn.status).toBe("rebridging");

    // SSE arrives before REST.
    const reader2 = new FakeReader();
    resolveSseOk(harness.takeSse(), reader2);
    await flush();
    reader2.push(snapshotChunk({ c: true }));
    await flush();
    expect(conn.status).toBe("streaming");
    expect(onSnapshot).toHaveBeenLastCalledWith({ c: true });

    // Pending REST was aborted; nothing left in harness.
    expect(harness.pendingRest()).toBe(0);
  });

  it("backoff doubles to the 30s cap on consecutive failures", async () => {
    const conn = makeConn();
    conn.start();
    resolveRestOk(harness.takeRest(), {});
    await flush();

    // Fail SSE repeatedly and observe each scheduled backoff.
    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

    for (let i = 0; i < expected.length; i++) {
      const reader = new FakeReader();
      resolveSseOk(harness.takeSse(), reader);
      await flush();
      reader.errorOut(new Error("e"));
      await flush();
      expect(conn.status).toBe("reconnecting");
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(
        expect.any(Function),
        expected[i],
      );
      vi.advanceTimersByTime(expected[i]);
      await flush();
      expect(conn.status).toBe("rebridging");
      // Drain the rebridge REST so it doesn't pollute the next iteration.
      if (harness.pendingRest() > 0) {
        resolveRestOk(harness.takeRest(), {});
        await flush();
      }
    }
  });

  it("server retry: hint resets backoff for the next failure", async () => {
    const conn = makeConn();
    conn.start();
    resolveRestOk(harness.takeRest(), {});
    await flush();

    // First snapshot — establishes streaming, backoff at 1000.
    const reader1 = new FakeReader();
    resolveSseOk(harness.takeSse(), reader1);
    await flush();
    reader1.push(snapshotChunk({ a: true }));
    await flush();

    // First failure: backoff = 1000.
    reader1.errorOut(new Error("e"));
    await flush();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);
    vi.advanceTimersByTime(1000);
    await flush();

    // Rebridge: serve a retry: hint then a snapshot.
    const reader2 = new FakeReader();
    resolveSseOk(harness.takeSse(), reader2);
    await flush();
    reader2.push("retry: 250\n");
    await flush();
    reader2.push(snapshotChunk({ a: true }));
    await flush();
    expect(conn.status).toBe("streaming");

    // Next failure should schedule with the hinted 250ms, not the doubled value.
    reader2.errorOut(new Error("e"));
    await flush();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 250);
  });

  it("forwards Last-Event-ID on the rebridge SSE request", async () => {
    const conn = makeConn();
    conn.start();
    resolveRestOk(harness.takeRest(), {});
    await flush();

    const reader1 = new FakeReader();
    const sseReq1 = harness.takeSse();
    resolveSseOk(sseReq1, reader1);
    await flush();
    // First request had no Last-Event-ID.
    expect(
      (sseReq1.init.headers as Record<string, string>)["Last-Event-ID"],
    ).toBeUndefined();

    reader1.push("id: 17\n");
    await flush();
    reader1.push(snapshotChunk({ a: true }));
    await flush();

    reader1.errorOut(new Error("e"));
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();

    const sseReq2 = harness.takeSse();
    expect(
      (sseReq2.init.headers as Record<string, string>)["Last-Event-ID"],
    ).toBe("17");
  });

  it("STOP from racing closes and aborts both pending requests", async () => {
    const conn = makeConn();
    conn.start();
    expect(harness.pendingRest()).toBe(1);
    expect(harness.pendingSse()).toBe(1);

    conn.stop();
    expect(conn.status).toBe("closed");
    // Aborts removed both pending entries.
    expect(harness.pendingRest()).toBe(0);
    expect(harness.pendingSse()).toBe(0);
  });

  it("STOP from reconnecting clears the timer; no further transitions", async () => {
    const conn = makeConn();
    conn.start();
    resolveRestOk(harness.takeRest(), {});
    await flush();
    const reader = new FakeReader();
    resolveSseOk(harness.takeSse(), reader);
    await flush();
    reader.push(snapshotChunk({ a: true }));
    await flush();
    reader.errorOut(new Error("e"));
    await flush();
    expect(conn.status).toBe("reconnecting");

    conn.stop();
    expect(conn.status).toBe("closed");

    // Advancing past the original 1000ms must not transition.
    vi.advanceTimersByTime(5000);
    await flush();
    expect(conn.status).toBe("closed");
    expect(harness.pendingSse()).toBe(0);
  });

  it("repeated start() while not idle is a no-op", async () => {
    const conn = makeConn();
    conn.start();
    expect(harness.pendingSse()).toBe(1);

    conn.start();
    expect(harness.pendingSse()).toBe(1);
  });
});
