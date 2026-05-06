import { createVexilloClient, type VexilloClient } from "./client";

export interface MockVexilloClientOptions {
  /** Flags returned by getFlag() / useFlag(). Default: {} */
  flags?: Record<string, boolean>;
  /** Fallback values for keys absent from flags. Default: {} */
  fallbacks?: Record<string, boolean>;
}

/**
 * Creates a VexilloClient pre-seeded with the given flags. `start()` and
 * `refresh()` are no-ops so component tests don't need a real server or any
 * fake-fetch wiring.
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
  client.start = () => () => {};
  client.refresh = async () => {};
  return client;
}
