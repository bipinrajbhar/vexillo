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
  children: ReactNode;
  /**
   * When true, opens a persistent SSE stream via `client.connectStream()`
   * instead of calling `client.load()`. The stream reconnects automatically
   * with exponential backoff on disconnect.
   */
  streaming?: boolean;
}

/**
 * Provides a VexilloClient to the React tree. Calls `client.load()` on mount
 * if the client is not already ready (i.e. no `initialFlags` were provided).
 * Pass `streaming` to use SSE for real-time flag updates instead.
 *
 * ```tsx
 * const client = createVexilloClient({ baseUrl: "...", apiKey: "..." });
 *
 * <VexilloClientProvider client={client} streaming>
 *   <App />
 * </VexilloClientProvider>
 * ```
 */
export function VexilloClientProvider({
  client,
  children,
  streaming = false,
}: VexilloClientProviderProps): React.ReactElement {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsub = client.subscribeAll(() => forceUpdate());
    let disconnect: (() => void) | undefined;
    if (streaming) {
      disconnect = client.connectStream();
    } else if (!client.isReady) {
      client.load();
    }
    return () => {
      unsub();
      disconnect?.();
    };
  }, [client, streaming]);

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
