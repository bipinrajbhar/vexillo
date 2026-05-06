import type {
  EventSourceClient,
  EventSourceMessage,
  EventSourceOptions,
} from "eventsource-client";

// ---------------------------------------------------------------------------
// Fake EventSource: drives the client's wire callbacks.
// ---------------------------------------------------------------------------

export interface FakeEventSource extends EventSourceClient {
  options: EventSourceOptions;
  closed: boolean;
  emit(msg: EventSourceMessage): void;
  drop(): void;
}

export function makeFakeEs(opts: EventSourceOptions): FakeEventSource {
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

export interface PendingRest {
  url: string;
  init: RequestInit;
  resolve: (response: unknown) => void;
  reject: (err: Error) => void;
}

export function makeRestFetch(): {
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

export function resolveRestOk(
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

export function snapshotMessage(
  flags: Record<string, boolean>,
): EventSourceMessage {
  const arr = Object.entries(flags).map(([key, enabled]) => ({ key, enabled }));
  return {
    data: JSON.stringify({ flags: arr }),
    event: undefined,
    id: undefined,
  };
}

export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
