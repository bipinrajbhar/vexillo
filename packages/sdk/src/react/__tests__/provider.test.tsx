import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { Component, type ReactNode } from "react";
import { TogglrProvider } from "../provider";
import { useFlag } from "../use-flag";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://togglr.example.com";
const API_KEY = "sdk-test-key";
const ENVIRONMENT = "production";

function makeFetchOk(flags: Array<{ key: string; enabled: boolean }>) {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({ flags }),
  } as unknown as Response);
}

function makeFetchHttpError(status: number) {
  return vi.fn().mockResolvedValueOnce({
    ok: false,
    status,
    statusText: "Error",
    json: async () => ({}),
  } as unknown as Response);
}

function makeFetchNetworkError() {
  return vi.fn().mockRejectedValueOnce(new Error("Network failure"));
}

/** Simple error boundary that captures errors thrown during render. */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div data-testid="boundary-error">{this.state.error.message}</div>
      );
    }
    return this.props.children;
  }
}

/** Renders a component that reads a flag and shows its value. */
function FlagConsumer({ flagKey }: { flagKey: string }) {
  const value = useFlag(flagKey);
  return <span data-testid={`flag-${flagKey}`}>{String(value)}</span>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TogglrProvider", () => {
  it("calls fetch exactly once on mount with the correct URL and apiKey", async () => {
    const mockFetch = makeFetchOk([]);
    vi.stubGlobal("fetch", mockFetch);

    render(
      <TogglrProvider
        baseUrl={BASE_URL}
        apiKey={API_KEY}
        environment={ENVIRONMENT}
      >
        <div />
      </TogglrProvider>,
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/flags`);
    expect((init?.headers as Record<string, string>)?.["Authorization"]).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it("populates context so useFlag returns fetched values", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchOk([
        { key: "dark-mode", enabled: true },
        { key: "new-checkout", enabled: false },
      ]),
    );

    render(
      <TogglrProvider
        baseUrl={BASE_URL}
        apiKey={API_KEY}
        environment={ENVIRONMENT}
      >
        <FlagConsumer flagKey="dark-mode" />
        <FlagConsumer flagKey="new-checkout" />
      </TogglrProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("flag-dark-mode").textContent).toBe("true"),
    );
    expect(screen.getByTestId("flag-new-checkout").textContent).toBe("false");
  });

  it("returns fallback values before the fetch resolves", () => {
    // Never resolves — simulates a slow network.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise(() => {})),
    );

    render(
      <TogglrProvider
        baseUrl={BASE_URL}
        apiKey={API_KEY}
        environment={ENVIRONMENT}
        fallbacks={{ "beta-feature": true }}
      >
        <FlagConsumer flagKey="beta-feature" />
      </TogglrProvider>,
    );

    // Immediately after mount, before fetch resolves.
    expect(screen.getByTestId("flag-beta-feature").textContent).toBe("true");
  });

  it("throws when fetch rejects with a network error", async () => {
    vi.stubGlobal("fetch", makeFetchNetworkError());
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <TogglrProvider
          baseUrl={BASE_URL}
          apiKey={API_KEY}
          environment={ENVIRONMENT}
        >
          <div />
        </TogglrProvider>
      </ErrorBoundary>,
    );

    const el = await screen.findByTestId("boundary-error");
    expect(el.textContent).toMatch(/Network failure/);
    consoleSpy.mockRestore();
  });

  it("throws when the API returns a non-2xx status", async () => {
    vi.stubGlobal("fetch", makeFetchHttpError(401));
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <TogglrProvider
          baseUrl={BASE_URL}
          apiKey={API_KEY}
          environment={ENVIRONMENT}
        >
          <div />
        </TogglrProvider>
      </ErrorBoundary>,
    );

    const el = await screen.findByTestId("boundary-error");
    expect(el.textContent).toMatch(/401/);
    consoleSpy.mockRestore();
  });
});
