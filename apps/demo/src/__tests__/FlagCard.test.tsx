import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import {
  VexilloClientProvider,
  createMockVexilloClient,
  createVexilloClient,
} from "@vexillo/react-sdk";
import { FlagCard } from "../components/FlagCard";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderFlagCard(flagKey: string, flags: Record<string, boolean> = {}) {
  const client = createMockVexilloClient({ flags });
  render(
    <VexilloClientProvider client={client}>
      <FlagCard flagKey={flagKey} />
    </VexilloClientProvider>,
  );
  return client;
}

describe("FlagCard", () => {
  it("displays ON when the flag is true", () => {
    renderFlagCard("my-flag", { "my-flag": true });
    expect(screen.getByTestId("value-my-flag").textContent).toBe("ON");
  });

  it("displays OFF when the flag is false", () => {
    renderFlagCard("my-flag", { "my-flag": false });
    expect(screen.getByTestId("value-my-flag").textContent).toBe("OFF");
  });

  it("displays OFF for an unknown flag key", () => {
    renderFlagCard("unknown-flag", {});
    expect(screen.getByTestId("value-unknown-flag").textContent).toBe("OFF");
  });

  it("shows loading state while client is not ready", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const client = createVexilloClient({
      baseUrl: "http://mock.invalid",
      apiKey: "mock",
    });
    render(
      <VexilloClientProvider client={client}>
        <FlagCard flagKey="my-flag" />
      </VexilloClientProvider>,
    );
    expect(screen.getByTestId("loading-my-flag")).toBeTruthy();
  });

  it("updates display in real time when the flag value changes", async () => {
    const client = renderFlagCard("live-flag", { "live-flag": false });
    expect(screen.getByTestId("value-live-flag").textContent).toBe("OFF");

    await act(async () => {
      client.override({ "live-flag": true });
    });

    expect(screen.getByTestId("value-live-flag").textContent).toBe("ON");
  });
});
