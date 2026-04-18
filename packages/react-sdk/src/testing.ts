import { createVexilloClient, type VexilloClient } from "./client";

export interface MockVexilloClientOptions {
  /** Flags returned by getFlag() / useFlag(). Default: {} */
  flags?: Record<string, boolean>;
  /** Fallback values for keys absent from flags. Default: {} */
  fallbacks?: Record<string, boolean>;
}

/**
 * Creates a VexilloClient pre-seeded with the given flags.
 *
 * - `isReady` is `true` immediately — no network call.
 * - `load()` is a no-op.
 * - `override()` works normally — useful for per-test overrides.
 *
 * ```tsx
 * const client = createMockVexilloClient({ flags: { newCheckout: true } });
 *
 * render(
 *   <VexilloClientProvider client={client}>
 *     <CheckoutButton />
 *   </VexilloClientProvider>
 * );
 * ```
 */
export function createMockVexilloClient(
  options: MockVexilloClientOptions = {},
): VexilloClient {
  const client = createVexilloClient({
    baseUrl: "http://mock.invalid",
    apiKey: "mock",
    initialFlags: options.flags ?? {},
    fallbacks: options.fallbacks ?? {},
  });
  // Override connectStream with a no-op so component tests don't need a real server.
  client.connectStream = () => () => {};
  return client;
}
