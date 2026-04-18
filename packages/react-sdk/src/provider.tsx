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
 * Provides a VexilloClient to the React tree. Calls `client.load()` on mount
 * if the client is not already ready (i.e. no `initialFlags` were provided).
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
  children,
}: VexilloClientProviderProps): React.ReactElement {
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsub = client.subscribeAll(() => forceUpdate());
    if (!client.isReady) client.load();
    return unsub;
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
