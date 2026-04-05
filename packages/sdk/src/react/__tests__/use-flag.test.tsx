import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { TogglrContext } from "../provider";
import { useFlag } from "../use-flag";

// Helper: renders a component that reads a flag and displays it.
function FlagDisplay({ flagKey }: { flagKey: string }) {
  const value = useFlag(flagKey);
  return <span data-testid="value">{String(value)}</span>;
}

function renderWithFlags(
  flagKey: string,
  flags: Record<string, boolean> | null,
  fallbacks: Record<string, boolean> = {},
) {
  return render(
    <TogglrContext.Provider value={{ flags, fallbacks }}>
      <FlagDisplay flagKey={flagKey} />
    </TogglrContext.Provider>,
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

  it("returns the fallback value before flags have loaded (flags === null)", () => {
    renderWithFlags("beta-feature", null, { "beta-feature": true });
    expect(screen.getByTestId("value").textContent).toBe("true");
  });

  it("returns false before flags have loaded when key is absent from fallbacks", () => {
    renderWithFlags("missing", null);
    expect(screen.getByTestId("value").textContent).toBe("false");
  });

  it("throws a clear error when called outside a TogglrProvider", () => {
    // Suppress React's expected console.error output for error boundaries.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<FlagDisplay flagKey="any" />)).toThrow(
      "useFlag must be called inside a <TogglrProvider>.",
    );
    spy.mockRestore();
  });
});
