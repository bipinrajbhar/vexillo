import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { VexilloClientProvider } from "../provider";
import { useFlag } from "../use-flag";
import { createMockVexilloClient } from "../testing";

function FlagDisplay({ flagKey }: { flagKey: string }) {
  const value = useFlag(flagKey);
  return <span data-testid="value">{String(value)}</span>;
}

function renderWithFlags(
  flagKey: string,
  flags: Record<string, boolean>,
  fallbacks: Record<string, boolean> = {},
) {
  const client = createMockVexilloClient({ flags, fallbacks });
  return render(
    <VexilloClientProvider client={client} autoLoad={false}>
      <FlagDisplay flagKey={flagKey} />
    </VexilloClientProvider>,
  );
}

describe("useFlag", () => {
  it("returns the correct boolean for a flag that exists", () => {
    renderWithFlags("dark-mode", { "dark-mode": true });
    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  it("returns false for a key not in flags or fallbacks", () => {
    renderWithFlags("unknown-flag", { "some-other-flag": true });
    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  it("returns the fallback value for a key absent from remote flags", () => {
    renderWithFlags("beta-feature", { "other-flag": false }, { "beta-feature": true });
    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  it("throws a clear error when called outside a VexilloClientProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<FlagDisplay flagKey="any" />)).toThrow(
      "useFlag must be called inside a <VexilloClientProvider>.",
    );
    spy.mockRestore();
  });

  it("re-renders with new value when client.override() is called", async () => {
    const client = createMockVexilloClient({ flags: { "dark-mode": false } });
    render(
      <VexilloClientProvider client={client} autoLoad={false}>
        <FlagDisplay flagKey="dark-mode" />
      </VexilloClientProvider>,
    );

    expect(screen.getByTestId("value").textContent).toBe("false");

    await act(async () => {
      client.override({ "dark-mode": true });
    });

    expect(screen.getByTestId("value").textContent).toBe("true");
  });
});
