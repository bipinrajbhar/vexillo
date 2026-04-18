import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import {
  VexilloClientProvider,
  createMockVexilloClient,
  createVexilloClient,
} from "@vexillo/react-sdk";
import { ConnectionStatus } from "../components/ConnectionStatus";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConnectionStatus", () => {
  it("shows connected when client is already ready", () => {
    const client = createMockVexilloClient({});
    render(
      <VexilloClientProvider client={client}>
        <ConnectionStatus />
      </VexilloClientProvider>,
    );
    expect(screen.getByText(/Connected/)).toBeTruthy();
  });

  it("shows connecting while client has not loaded", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const client = createVexilloClient({ baseUrl: "http://mock.invalid", apiKey: "mock" });
    render(
      <VexilloClientProvider client={client}>
        <ConnectionStatus />
      </VexilloClientProvider>,
    );
    expect(screen.getByText(/Connecting/)).toBeTruthy();
  });

  it("transitions to connected after the client loads flags", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ flags: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createVexilloClient({ baseUrl: "http://mock.invalid", apiKey: "mock" });
    render(
      <VexilloClientProvider client={client}>
        <ConnectionStatus />
      </VexilloClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Connected/)).toBeTruthy();
    });
  });
});
