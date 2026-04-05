import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { VexilloClientProvider } from "../provider";
import { useFlag } from "../use-flag";
import { createVexilloClient } from "../client";
import { createMockVexilloClient } from "../testing";

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
  const [value] = useFlag(flagKey);
  return <span data-testid={`flag-${flagKey}`}>{String(value)}</span>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VexilloClientProvider — initialFlags (synchronous path)", () => {
  it("renders immediately with provided flags, no fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createMockVexilloClient({ flags: { "dark-mode": true } });

    render(
      <VexilloClientProvider client={client} autoLoad={false}>
        <FlagConsumer flagKey="dark-mode" />
      </VexilloClientProvider>,
    );

    expect(screen.getByTestId("flag-dark-mode").textContent).toBe("true");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns fallback for keys absent in initialFlags", () => {
    const client = createMockVexilloClient({
      flags: {},
      fallbacks: { "beta-feature": true },
    });

    render(
      <VexilloClientProvider client={client} autoLoad={false}>
        <FlagConsumer flagKey="beta-feature" />
      </VexilloClientProvider>,
    );

    expect(screen.getByTestId("flag-beta-feature").textContent).toBe("true");
  });
});

describe("VexilloClientProvider — autoLoad fetch path", () => {
  it("loads and renders fetched flag values", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      makeFetchOk([
        { key: "dark-mode", enabled: true },
        { key: "new-checkout", enabled: false },
      ]),
    );

    const client = createVexilloClient({ baseUrl: BASE_URL, apiKey: API_KEY });

    await act(async () => {
      render(
        <VexilloClientProvider client={client}>
          <FlagConsumer flagKey="dark-mode" />
          <FlagConsumer flagKey="new-checkout" />
        </VexilloClientProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("flag-dark-mode").textContent).toBe("true");
      expect(screen.getByTestId("flag-new-checkout").textContent).toBe("false");
    });
  });

  it("calls fetch with the correct URL and Authorization header", async () => {
    const mockFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(makeFetchOk([]));

    const client = createVexilloClient({ baseUrl: BASE_URL, apiKey: API_KEY });

    await act(async () => {
      render(
        <VexilloClientProvider client={client}>
          <div />
        </VexilloClientProvider>,
      );
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/flags`);
    expect((init?.headers as Record<string, string>)?.["Authorization"]).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it("falls back to fallbacks on HTTP error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchHttpError(401));

    const client = createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fallbacks: { "some-flag": true },
    });

    await act(async () => {
      render(
        <VexilloClientProvider client={client}>
          <FlagConsumer flagKey="some-flag" />
        </VexilloClientProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("flag-some-flag").textContent).toBe("true");
    });
  });

  it("falls back to fallbacks on network error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchNetworkError());

    const client = createVexilloClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fallbacks: { "some-flag": true },
    });

    await act(async () => {
      render(
        <VexilloClientProvider client={client}>
          <FlagConsumer flagKey="some-flag" />
        </VexilloClientProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("flag-some-flag").textContent).toBe("true");
    });
  });
});

describe("VexilloClientProvider — override()", () => {
  it("override() takes effect immediately and is reversible", async () => {
    const client = createMockVexilloClient({ flags: { feature: false } });

    render(
      <VexilloClientProvider client={client} autoLoad={false}>
        <FlagConsumer flagKey="feature" />
      </VexilloClientProvider>,
    );

    expect(screen.getByTestId("flag-feature").textContent).toBe("false");

    let cleanup!: () => void;
    await act(async () => {
      cleanup = client.override({ feature: true });
    });
    expect(screen.getByTestId("flag-feature").textContent).toBe("true");

    await act(async () => {
      cleanup();
    });
    expect(screen.getByTestId("flag-feature").textContent).toBe("false");
  });
});
