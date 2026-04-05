import { useTogglrContext } from "./provider";

/**
 * Returns the current boolean value for a feature flag key.
 *
 * - Before the provider's fetch resolves (including SSR), returns the value
 *   from `fallbacks`, or `false` if the key is absent.
 * - After the fetch resolves, returns the live value from the API, falling
 *   back to `fallbacks[key] ?? false` for keys not present in the response.
 * - Throws if called outside a `<TogglrProvider>`.
 */
export function useFlag(key: string): boolean {
  const { flags, fallbacks } = useTogglrContext();

  if (flags !== null && key in flags) {
    return flags[key];
  }

  return fallbacks[key] ?? false;
}
