/**
 * Fetches feature flags from your Vexillo deployment.
 *
 * Use this on the server before rendering to pass resolved flags as
 * `initialFlags` to `<VexilloProvider>`.
 *
 * ## When to use
 *
 * - **`renderToString`** — Suspense is not supported. You MUST call
 *   `fetchFlags` before rendering and pass the result as `initialFlags`:
 *   ```ts
 *   const flags = await fetchFlags(baseUrl, apiKey);
 *   renderToString(<VexilloProvider initialFlags={flags} ...>);
 *   ```
 *
 * - **`renderToPipeableStream` / `renderToReadableStream`** — Suspense is
 *   supported. `initialFlags` is optional; the provider will suspend and
 *   fetch flags inline. You may still pass `initialFlags` to avoid the
 *   suspension entirely.
 *
 * - **React Server Components (Next.js App Router)** — call `fetchFlags`
 *   in your server component and pass the result as `initialFlags`.
 *
 * - **SPA (no SSR)** — omit `initialFlags`. The provider fetches on the
 *   client and suspends until resolved.
 */
export async function fetchFlags(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, boolean>> {
  try {
    const res = await fetch(`${baseUrl}/api/sdk/flags`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      console.warn(
        `Vexillo: fetchFlags received status ${res.status} ${res.statusText}. Returning empty flags.`,
      );
      return {};
    }

    const data = (await res.json()) as {
      flags: Array<{ key: string; enabled: boolean }>;
    };

    const map: Record<string, boolean> = {};
    for (const f of data.flags) {
      map[f.key] = f.enabled;
    }
    return map;
  } catch {
    console.warn("Vexillo: fetchFlags failed. Returning empty flags.");
    return {};
  }
}
