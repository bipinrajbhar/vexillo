import { createVexilloClient, type VexilloClient, type VexilloClientConfig } from "./client";

/**
 * Creates a VexilloClient and calls load() before returning.
 *
 * Designed for Next.js App Router Server Components and other async server
 * contexts where you want flags pre-loaded before rendering.
 *
 * ```tsx
 * // app/layout.tsx (Server Component)
 * const client = await createServerVexilloClient({ baseUrl, apiKey });
 *
 * <VexilloClientProvider client={createVexilloClient({ ...config, initialFlags: client.getAllFlags() })}>
 *   <App />
 * </VexilloClientProvider>
 * ```
 *
 * The returned client is a plain object — safe to interrogate on the server,
 * but do not pass it directly to a Client Component (not serialisable).
 * Instead, call `client.getAllFlags()` and pass that as `initialFlags`.
 */
export async function createServerVexilloClient(
  config: VexilloClientConfig,
): Promise<VexilloClient> {
  const client = createVexilloClient(config);
  await client.load();
  return client;
}
