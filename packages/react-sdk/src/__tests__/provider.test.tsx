import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { Suspense } from "react";
import { VexilloProvider, clearFlagCache } from "../provider";
import { useFlag } from "../use-flag";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://vexillo.example.com";
const API_KEY = "sdk-test-key";

function makeFetchOk(flags: Array<{ key: string; enabled: boolean }>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ flags }),
  } as unknown as Response);
}

function makeFetchHttpError(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
  } as unknown as Response);
}

function makeFetchNetworkError() {
  return vi.fn().mockRejectedValue(new Error("Network failure"));
}

function FlagConsumer({ flagKey }: { flagKey: string }) {
  const value = useFlag(flagKey);
  return <span data-testid={`flag-${flagKey}`}>{String(value)}</span>;
}

async function renderWithSuspense(ui: React.ReactNode) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        {ui}
      </Suspense>,
    );
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearFlagCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VexilloProvider — initialFlags (synchronous / renderToString path)", () => {
  it("renders immediately with provided flags, no fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(
      <VexilloProvider
        baseUrl={BASE_URL}
        apiKey={API_KEY}
        initialFlags={{ "dark-mode": true }}
      >
        <FlagConsumer flagKey="dark-mode" />
      </VexilloProvider>,
    );

    expect(screen.getByTestId("flag-dark-mode").textContent).toBe("true");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns fallback for keys absent in initialFlags", () => {
    render(
      <VexilloProvider
        baseUrl={BASE_URL}
        apiKey={API_KEY}
        initialFlags={{}}
        fallbacks={{ "beta-feature": true }}
      >
        <FlagConsumer flagKey="beta-feature" />
      </VexilloProvider>,
    );

    expect(screen.getByTestId("flag-beta-feature").textContent).toBe("true");
  });
});

describe("VexilloProvider — fetch path (Suspense / SPA / streaming SSR)", () => {
  it("suspends then renders fetched flag values", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      makeFetchOk([
        { key: "dark-mode", enabled: true },
        { key: "new-checkout", enabled: false },
      ]),
    );

    await renderWithSuspense(
      <VexilloProvider baseUrl={BASE_URL} apiKey={API_KEY}>
        <FlagConsumer flagKey="dark-mode" />
        <FlagConsumer flagKey="new-checkout" />
      </VexilloProvider>,
    );

    expect(screen.getByTestId("flag-dark-mode").textContent).toBe("true");
    expect(screen.getByTestId("flag-new-checkout").textContent).toBe("false");
  });

  it("calls fetch with the correct URL and Authorization header", async () => {
    const mockFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(makeFetchOk([]));

    await renderWithSuspense(
      <VexilloProvider baseUrl={BASE_URL} apiKey={API_KEY}>
        <div />
      </VexilloProvider>,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/flags`);
    expect((init?.headers as Record<string, string>)?.["Authorization"]).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it("silently falls back to fallbacks on HTTP error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchHttpError(401));

    await renderWithSuspense(
      <VexilloProvider
        baseUrl={BASE_URL}
        apiKey={API_KEY}
        fallbacks={{ "some-flag": true }}
      >
        <FlagConsumer flagKey="some-flag" />
      </VexilloProvider>,
    );

    expect(screen.getByTestId("flag-some-flag").textContent).toBe("true");
  });

  it("silently falls back to fallbacks on network error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchNetworkError());

    await renderWithSuspense(
      <VexilloProvider
        baseUrl={BASE_URL}
        apiKey={API_KEY}
        fallbacks={{ "some-flag": true }}
      >
        <FlagConsumer flagKey="some-flag" />
      </VexilloProvider>,
    );

    expect(screen.getByTestId("flag-some-flag").textContent).toBe("true");
  });

  it("uses cached Promise on re-render — fetch called only once", async () => {
    const mockFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(makeFetchOk([{ key: "x", enabled: true }]));

    const { rerender } = await renderWithSuspense(
      <VexilloProvider baseUrl={BASE_URL} apiKey={API_KEY}>
        <FlagConsumer flagKey="x" />
      </VexilloProvider>,
    );

    await act(async () => {
      rerender(
        <Suspense fallback={null}>
          <VexilloProvider baseUrl={BASE_URL} apiKey={API_KEY}>
            <FlagConsumer flagKey="x" />
          </VexilloProvider>
        </Suspense>,
      );
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
