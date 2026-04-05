import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export interface VexilloContextValue {
  flags: Record<string, boolean> | null;
  fallbacks: Record<string, boolean>;
}

export const VexilloContext = createContext<VexilloContextValue | null>(null);

export interface VexilloProviderProps {
  /** Base URL of your Vexillo deployment (e.g. "https://vexillo.example.com") */
  baseUrl: string;
  /** SDK API key for the target environment */
  apiKey: string;
  /** Environment slug — stored in context for consumer reference */
  environment: string;
  /** Flag values used before the fetch resolves and for unknown keys */
  fallbacks?: Record<string, boolean>;
  children: ReactNode;
}

export function VexilloProvider({
  baseUrl,
  apiKey,
  fallbacks = {},
  children,
}: VexilloProviderProps): ReactNode {
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`${baseUrl}/api/flags`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(
            `Vexillo: API responded with status ${res.status} ${res.statusText}`,
          );
        }
        return res.json() as Promise<{
          flags: Array<{ key: string; enabled: boolean }>;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const f of data.flags) {
          map[f.key] = f.enabled;
        }
        setFlags(map);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err
            : new Error(`Vexillo: unexpected error — ${String(err)}`),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, baseUrl]);

  if (error) throw error;

  return (
    <VexilloContext.Provider value={{ flags, fallbacks }}>
      {children}
    </VexilloContext.Provider>
  );
}

/** @internal — exported for use-flag.ts only */
export function useVexilloContext(): VexilloContextValue {
  const ctx = useContext(VexilloContext);
  if (ctx === null) {
    throw new Error("useFlag must be called inside a <VexilloProvider>.");
  }
  return ctx;
}
