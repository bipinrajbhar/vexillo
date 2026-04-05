import React, {
  createContext,
  use,
  useContext,
  type ReactNode,
} from "react";
import { fetchFlags } from "./fetch-flags";

export interface VexilloContextValue {
  flags: Record<string, boolean>;
  fallbacks: Record<string, boolean>;
}

export const VexilloContext = createContext<VexilloContextValue | null>(null);

export interface VexilloProviderProps {
  /** Base URL of your Vexillo deployment (e.g. "https://vexillo.example.com") */
  baseUrl: string;
  /** SDK API key for the target environment */
  apiKey: string;
  /**
   * Pre-resolved flags from the server.
   *
   * **Required when using `renderToString`** — pass the result of
   * `fetchFlags(baseUrl, apiKey)` here, as `renderToString` does not support
   * Suspense. Without this, the provider will throw during server rendering.
   *
   * Optional for `renderToPipeableStream`, RSC, and SPA — the provider will
   * suspend and fetch flags on its own if omitted.
   */
  initialFlags?: Record<string, boolean>;
  /** Flag values used as defaults for unknown keys */
  fallbacks?: Record<string, boolean>;
  children: ReactNode;
}

/** @internal — for tests only */
export function clearFlagCache() {
  clientCache.clear();
}

// Client-side module-level cache keyed by `${baseUrl}__${apiKey}`.
// Prevents a new fetch on every re-render and keeps the Promise stable
// for React.use(). Not used on the server — each request fetches fresh
// to avoid leaking one request's flags into another.
const clientCache = new Map<string, Promise<Record<string, boolean>>>();

function getOrCreateFlagPromise(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, boolean>> {
  const key = `${baseUrl}__${apiKey}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, fetchFlags(baseUrl, apiKey));
  }
  return clientCache.get(key)!;
}

/**
 * Provides feature flag values to the React tree via Suspense.
 *
 * The subtree suspends until flags are resolved — wrap with `<Suspense>`
 * to show a loading state.
 *
 * ```tsx
 * <Suspense fallback={<Spinner />}>
 *   <VexilloProvider baseUrl="..." apiKey="...">
 *     <App />
 *   </VexilloProvider>
 * </Suspense>
 * ```
 *
 * ### SSR with `renderToString`
 * `renderToString` does not support Suspense. Call `fetchFlags` before
 * rendering and pass the result as `initialFlags`:
 * ```ts
 * const flags = await fetchFlags(baseUrl, apiKey);
 * renderToString(<VexilloProvider initialFlags={flags} ...>);
 * ```
 *
 * ### SSR with `renderToPipeableStream` / RSC
 * `initialFlags` is optional. The provider suspends and streams the resolved
 * flags inline. Pass `initialFlags` to avoid the suspension entirely.
 */
export function VexilloProvider({
  baseUrl,
  apiKey,
  initialFlags,
  fallbacks = {},
  children,
}: VexilloProviderProps): React.ReactElement {
  const isServer = typeof window === "undefined";

  if (initialFlags) {
    // Pre-seed the client cache so subsequent renders resolve synchronously.
    const key = `${baseUrl}__${apiKey}`;
    if (!isServer && !clientCache.has(key)) {
      clientCache.set(key, Promise.resolve(initialFlags));
    }
    // Bypass use() entirely — no Suspense needed, works with renderToString.
    return (
      <VexilloContext.Provider value={{ flags: initialFlags, fallbacks }}>
        {children}
      </VexilloContext.Provider>
    );
  }

  let flagPromise: Promise<Record<string, boolean>>;

  if (isServer) {
    // Server with no initialFlags: fetch fresh (no cache — prevents
    // cross-request flag leakage in Node.js).
    flagPromise = fetchFlags(baseUrl, apiKey);
  } else {
    // Client / SPA: use module-level cache keyed by baseUrl + apiKey.
    // Stable across re-renders; invalidated when props change.
    flagPromise = getOrCreateFlagPromise(baseUrl, apiKey);
  }

  const flags = use(flagPromise);

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
