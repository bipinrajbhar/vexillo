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
}

/**
 * Provides a VexilloClient to the React tree and drives its lifecycle.
 * Calls `client.start()` on mount and the returned stop on unmount. Wire mode
 * (REST vs streaming) and auto-refresh policy live on the client config — the
 * Provider is mode-agnostic.
 *
 * ```tsx
 * const client = createVexilloClient({ baseUrl: "...", apiKey: "...", mode: "stream" });
 *
 * <VexilloClientProvider client={client}>
 *   <App />
 * </VexilloClientProvider>
 * ```
 */
export function VexilloClientProvider({
  client,
  children,
}: VexilloClientProviderProps): React.ReactElement {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsub = client.subscribeAll(() => forceUpdate());
    const stop = client.start();
    return () => {
      unsub();
      stop();
    };
  }, [client]);

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
