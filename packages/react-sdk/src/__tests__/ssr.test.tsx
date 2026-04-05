// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VexilloProvider, clearFlagCache } from "../provider";
import { fetchFlags } from "../fetch-flags";
import { useFlag } from "../use-flag";

function Child({ flagKey }: { flagKey: string }) {
  const value = useFlag(flagKey);
  return <div>{String(value)}</div>;
}

beforeEach(() => {
  clearFlagCache();
});

describe("SSR — renderToString path (requires initialFlags)", () => {
  it("renders with initialFlags synchronously — no fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const html = renderToStaticMarkup(
      <VexilloProvider
        baseUrl="https://vexillo.example.com"
        apiKey="sdk-key"
        initialFlags={{ "some-flag": true }}
      >
        <Child flagKey="some-flag" />
      </VexilloProvider>,
    );

    expect(html).toContain("true");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses fallback for keys absent in initialFlags", () => {
    const html = renderToStaticMarkup(
      <VexilloProvider
        baseUrl="https://vexillo.example.com"
        apiKey="sdk-key"
        initialFlags={{}}
        fallbacks={{ "some-flag": true }}
      >
        <Child flagKey="some-flag" />
      </VexilloProvider>,
    );

    expect(html).toContain("true");
  });
});

describe("fetchFlags", () => {
  it("returns parsed flag map on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        flags: [
          { key: "dark-mode", enabled: true },
          { key: "checkout-v2", enabled: false },
        ],
      }),
    } as unknown as Response);

    const flags = await fetchFlags("https://vexillo.example.com", "sdk-key");
    expect(flags).toEqual({ "dark-mode": true, "checkout-v2": false });
  });

  it("returns empty object on HTTP error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as unknown as Response);

    const flags = await fetchFlags("https://vexillo.example.com", "sdk-key");
    expect(flags).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns empty object on network error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network failure"),
    );

    const flags = await fetchFlags("https://vexillo.example.com", "sdk-key");
    expect(flags).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });
});
