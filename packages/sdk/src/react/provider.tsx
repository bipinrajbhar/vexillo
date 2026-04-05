import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export interface TogglrContextValue {
  flags: Record<string, boolean> | null;
  fallbacks: Record<string, boolean>;
}

export const TogglrContext = createContext<TogglrContextValue | null>(null);

export interface TogglrProviderProps {
  /** Base URL of your Togglr deployment (e.g. "https://togglr.example.com") */
  baseUrl: string;
  /** SDK API key for the target environment */
  apiKey: string;
  /** Environment slug — stored in context for consumer reference */
  environment: string;
  /** Flag values used before the fetch resolves and for unknown keys */
  fallbacks?: Record<string, boolean>;
  children: ReactNode;
}

export function TogglrProvider({
  baseUrl,
  apiKey,
  fallbacks = {},
  children,
}: TogglrProviderProps): ReactNode {
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
            `Togglr: API responded with status ${res.status} ${res.statusText}`,
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
            : new Error(`Togglr: unexpected error — ${String(err)}`),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, baseUrl]);

  if (error) throw error;

  return (
    <TogglrContext.Provider value={{ flags, fallbacks }}>
      {children}
    </TogglrContext.Provider>
  );
}

/** @internal — exported for use-flag.ts only */
export function useTogglrContext(): TogglrContextValue {
  const ctx = useContext(TogglrContext);
  if (ctx === null) {
    throw new Error("useFlag must be called inside a <TogglrProvider>.");
  }
  return ctx;
}
