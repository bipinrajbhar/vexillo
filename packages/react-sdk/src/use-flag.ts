import { useState, useEffect } from "react";
import { useVexilloClientContext } from "./provider";

/**
 * Returns the current boolean value for a feature flag key.
 *
 * Falls back to `defaultValue` (then `false`) for unknown keys or while the
 * client is loading. Re-renders only when this specific key's value changes.
 *
 * If you need to know whether flags have loaded yet, use `useVexilloClient()`
 * and check `client.isReady`.
 *
 * @throws if called outside a `<VexilloClientProvider>`.
 */
export function useFlag(key: string, defaultValue?: boolean): boolean {
  const client = useVexilloClientContext();

  const [value, setValue] = useState(() => client.getFlag(key, defaultValue));

  useEffect(() => {
    // Sync if the client updated between render and this effect running.
    setValue(client.getFlag(key, defaultValue));

    return client.subscribe(key, () => {
      setValue(client.getFlag(key, defaultValue));
    });
  }, [client, key, defaultValue]);

  return value;
}
