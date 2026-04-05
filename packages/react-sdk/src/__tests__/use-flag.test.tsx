import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { VexilloContext } from "../provider";
import { useFlag } from "../use-flag";

function FlagDisplay({ flagKey }: { flagKey: string }) {
  const value = useFlag(flagKey);
  return <span data-testid="value">{String(value)}</span>;
}

function renderWithFlags(
  flagKey: string,
  flags: Record<string, boolean>,
  fallbacks: Record<string, boolean> = {},
) {
  return render(
    <VexilloContext.Provider value={{ flags, fallbacks }}>
      <FlagDisplay flagKey={flagKey} />
    </VexilloContext.Provider>,
  );
}

describe("useFlag", () => {
  it("returns the correct boolean for a flag that exists in context", () => {
    renderWithFlags("dark-mode", { "dark-mode": true });
    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  it("returns false for a flag key not in the fetched set and not in fallbacks", () => {
    renderWithFlags("unknown-flag", { "some-other-flag": true });
    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  it("returns the fallback value for a key in fallbacks but not in the fetched set", () => {
    renderWithFlags("beta-feature", { "other-flag": false }, { "beta-feature": true });
    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  it("returns false for a key absent from both flags and fallbacks", () => {
    renderWithFlags("missing", {});
    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  it("throws a clear error when called outside a VexilloProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<FlagDisplay flagKey="any" />)).toThrow(
      "useFlag must be called inside a <VexilloProvider>.",
    );
    spy.mockRestore();
  });
});
