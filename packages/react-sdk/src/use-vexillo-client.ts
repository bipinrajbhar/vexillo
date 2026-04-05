import { useVexilloClientContext } from "./provider";
import { type VexilloClient } from "./client";

/**
 * Returns the nearest VexilloClient from context.
 *
 * Use this escape hatch when you need imperative access to the client
 * (e.g. calling load(), getAllFlags(), or override() directly in a component).
 *
 * @throws if called outside a `<VexilloClientProvider>`.
 */
export function useVexilloClient(): VexilloClient {
  return useVexilloClientContext();
}
