import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type ReactNode,
} from "react";
import { type VexilloClient } from "./client";

const VexilloClientContext = createContext<VexilloClient | null>(null);

export interface VexilloClientProviderProps {
  client: VexilloClient;
  /**
   * When true, calls client.load() on mount.
   * Set to false if you've already called load() (e.g. via createServerVexilloClient).
   * Default: true
   */
  autoLoad?: boolean;
  children: ReactNode;
}

/**
 * Provides a VexilloClient to the React tree.
 *
 * ```tsx
 * const client = createVexilloClient({ baseUrl: "...", apiKey: "..." });
 *
 * <VexilloClientProvider client={client}>
 *   <App />
 * </VexilloClientProvider>
 * ```
 */
export function VexilloClientProvider({
  client,
  autoLoad = true,
  children,
}: VexilloClientProviderProps): React.ReactElement {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    // Re-render whenever any flag changes (covers load() and override()).
    const unsub = client.subscribeAll(() => forceUpdate());
    if (autoLoad && !client.isReady) {
      client.load();
    }
    return unsub;
  }, [client, autoLoad]);

  return (
    <VexilloClientContext.Provider value={client}>
      {children}
    </VexilloClientContext.Provider>
  );
}

/** @internal — used by useFlag and useVexilloClient */
export function useVexilloClientContext(): VexilloClient {
  const client = useContext(VexilloClientContext);
  if (client === null) {
    throw new Error("useFlag must be called inside a <VexilloClientProvider>.");
  }
  return client;
}
