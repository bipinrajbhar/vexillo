import { useVexilloContext } from "./provider";

/**
 * Returns the current boolean value for a feature flag key.
 *
 * - Before the provider's fetch resolves (including SSR), returns the value
 *   from `fallbacks`, or `false` if the key is absent.
 * - After the fetch resolves, returns the live value from the API, falling
 *   back to `fallbacks[key] ?? false` for keys not present in the response.
 * - Throws if called outside a `<VexilloProvider>`.
 */
export function useFlag(key: string): boolean {
  const { flags, fallbacks } = useVexilloContext();

  if (key in flags) {
    return flags[key];
  }

  return fallbacks[key] ?? false;
}
