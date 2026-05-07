import { useState, useEffect } from "react";
import { useVexilloClientContext } from "./provider";

/**
 * Returns `[value, isLoading]` for a feature flag key.
 *
 * - `value` — current boolean value. Falls back to `fallbacks` config then
 *   `false` for unknown keys or while the client is still loading.
 * - `isLoading` — `true` only while the client's `status` is `"loading"`
 *   (cold start with no `initialFlags`). It flips to `false` once flags
 *   arrive, AND on cold-start failure (the consumer should branch on
 *   `client.status === "error"` for that case rather than spinning forever).
 *
 *   ```tsx
 *   const [newCheckout, isLoading] = useFlag("new-checkout");
 *   if (isLoading) return null;
 *   return newCheckout ? <NewCheckout /> : <OldCheckout />;
 *   ```
 *
 * Re-renders on this key's value changes and on status transitions.
 *
 * @throws if called outside a `<VexilloClientProvider>`.
 */
export function useFlag(key: string): [value: boolean, isLoading: boolean] {
  const client = useVexilloClientContext();

  const [state, setState] = useState(() => ({
    value: client.getFlag(key),
    isLoading: client.status === "loading",
  }));

  useEffect(() => {
    const sync = () => {
      setState({
        value: client.getFlag(key),
        isLoading: client.status === "loading",
      });
    };
    sync();
    const unsubKey = client.subscribe(key, sync);
    const unsubStatus = client.subscribeStatus(sync);
    return () => {
      unsubKey();
      unsubStatus();
    };
  }, [client, key]);

  return [state.value, state.isLoading];
}
