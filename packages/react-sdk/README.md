# @vexillo/react-sdk

React bindings for [Vexillo](https://vexillo-web.vercel.app) — a self-hosted feature flag service.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [SPA](#spa)
- [Real-time streaming](#real-time-streaming)
- [Next.js App Router (RSC)](#nextjs-app-router-rsc)
- [Node.js SSR](#nodejs-ssr)
- [Fallbacks](#fallbacks)
- [Overriding flags](#overriding-flags)
- [Error handling](#error-handling)
- [Testing](#testing)
- [API reference](#api-reference)

---

## Requirements

- React 18 or 19
- A running Vexillo deployment

---

## Installation

```sh
npm install @vexillo/react-sdk
```

---

## SPA

For client-side only apps (Create React App, Vite, etc.). The default `mode: "rest"` fetches once on mount and refreshes on window focus; components read flags with `useFlag`.

**1. Create a client**

```ts
// lib/vexillo.ts
import { createVexilloClient } from "@vexillo/react-sdk";

export const client = createVexilloClient({
  baseUrl: "https://your-vexillo.example.com",
  apiKey: "your-api-key",
  // mode: "rest" is the default — one-shot fetch + auto-refresh on focus.
  // Set autoRefresh: { onFocus: false } to disable focus-triggered refreshes.
});
```

**2. Wrap your app**

```tsx
import { VexilloClientProvider } from "@vexillo/react-sdk";
import { client } from "@/lib/vexillo";

export default function App() {
  return (
    <VexilloClientProvider client={client}>
      <MyApp />
    </VexilloClientProvider>
  );
}
```

The provider calls `client.start()` on mount and the returned `stop` on unmount — wire mode is configured on the client, not the provider.

**3. Read flags in components**

```tsx
import { useFlag } from "@vexillo/react-sdk";

export function CheckoutButton() {
  const [newCheckout, isLoading] = useFlag("new-checkout");

  if (isLoading) return null;

  return newCheckout ? <NewCheckout /> : <OldCheckout />;
}
```

`useFlag` returns `[value, isLoading]`. `isLoading` is `true` only during the cold-start fetch (when there are no `initialFlags`); it flips to `false` on the first snapshot **and** on cold-start failure — branch on `client.status === "error"` if you need to distinguish the two. The component re-renders on changes to that specific key and on status transitions.

---

## Real-time streaming

Set `mode: "stream"` on the client to open a persistent SSE connection. Components update automatically whenever a flag is toggled in the dashboard — no polling, no page reload.

```ts
import { createVexilloClient } from "@vexillo/react-sdk";

export const client = createVexilloClient({
  baseUrl: "https://your-vexillo.example.com",
  apiKey: "your-api-key",
  mode: "stream",
});
```

The provider does not change — `<VexilloClientProvider client={client}>` works the same in both modes.

**How it works**

- On mount the provider calls `client.start()`.
- In `mode: "stream"` the client races a REST fetch (`GET /api/sdk/flags`, CDN-cached, typically < 50 ms) against the SSE handshake. Whichever resolves first hydrates flags so `useFlag` can render real values immediately; if REST wins, the first SSE snapshot then overwrites the REST response with the authoritative live state.
- The server pushes a new snapshot whenever a flag is toggled.
- The connection sends a keepalive comment every 25 seconds so proxies and firewalls don't close idle connections.
- If the SSE connection drops mid-stream, the client transitions into a `bridging` state — it kicks off a one-shot REST refresh to keep flags fresh while the underlying `EventSource` reconnects, then resumes streaming once SSE is back. On every reconnect the client sends a `Last-Event-ID` header so the server can continue the event ID sequence.
- On unmount the provider's stop function aborts the in-flight REST request and closes the SSE connection.
- `autoRefresh.onFocus` is ignored in stream mode — SSE is authoritative.

**Manual refresh**

Force a one-shot REST refresh at any time:

```ts
await client.refresh();
```

This works in both modes — useful for "Refresh flags" debug buttons or for driving refreshes from a router instead of focus events.

**Lifecycle outside React**

If you manage lifecycle outside React, call `start()` yourself:

```ts
const stop = client.start();

// later — e.g. when the user signs out
stop();
```

`start()` is idempotent: calling it again without an intervening `stop()` returns the same handle and does not open a second connection (so React StrictMode double-mount is safe).

**Error handling**

Wire errors (cold-start REST, race REST, bridge REST, SSE) are surfaced via `onError` and `client.lastError`:

```ts
const client = createVexilloClient({
  baseUrl: "https://your-vexillo.example.com",
  apiKey: "your-api-key",
  mode: "stream",
  onError: (err) => {
    console.error("Wire error:", err);
  },
});
```

The client retries automatically after every error, so `onError` is informational — you do not need to reconnect manually. A successful refresh during a `bridging` window clears `lastError` without flipping `status` away from `ready`.

---

## Next.js App Router (RSC)

Fetch flags in your server component with `fetchFlags` and pass them as `initialFlags` to the client. This way flags are embedded in the HTML on the first render — no loading state, no hydration mismatch.

```tsx
// app/layout.tsx (Server Component)
import { fetchFlags, createVexilloClient, VexilloClientProvider } from "@vexillo/react-sdk";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialFlags = await fetchFlags(
    process.env.VEXILLO_BASE_URL!,
    process.env.VEXILLO_API_KEY!,
  );

  const client = createVexilloClient({
    baseUrl: process.env.NEXT_PUBLIC_VEXILLO_BASE_URL!,
    apiKey: process.env.NEXT_PUBLIC_VEXILLO_API_KEY!,
    initialFlags,
  });

  return (
    <html>
      <body>
        <VexilloClientProvider client={client}>
          {children}
        </VexilloClientProvider>
      </body>
    </html>
  );
}
```

Client components use `useFlag` as normal. Because `initialFlags` is provided, `isLoading` is `false` on the first render:

```tsx
"use client";
import { useFlag } from "@vexillo/react-sdk";

export function CheckoutButton() {
  const [newCheckout, isLoading] = useFlag("new-checkout");

  if (isLoading) return null;

  return newCheckout ? <NewCheckout /> : <OldCheckout />;
}
```

> When `initialFlags` is provided and `mode: "stream"` is set, the client skips the cold-start REST race (flags are already ready) and opens the SSE connection directly. The first SSE snapshot then overwrites the seeded flags with the authoritative live state.

---

## Node.js SSR

For `renderToString` / `renderToPipeableStream` setups. Use `fetchFlags` before rendering to pre-load flags so the HTML is correct on the first render.

```tsx
import { renderToString } from "react-dom/server";
import { fetchFlags, createVexilloClient, VexilloClientProvider } from "@vexillo/react-sdk";

// In your request handler:
const initialFlags = await fetchFlags(BASE_URL, API_KEY);

const client = createVexilloClient({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  initialFlags,
});

const html = renderToString(
  <VexilloClientProvider client={client}>
    <App />
  </VexilloClientProvider>,
);
```

> **Note:** If you skip `initialFlags`, flags will not be in the server-rendered HTML. Components will use their fallback values on the server and load real values after hydration.

---

## Fallbacks

Pass a `fallbacks` map to define default values used when a flag is unknown or while the client is still loading.

```ts
const client = createVexilloClient({
  baseUrl: "https://your-vexillo.example.com",
  apiKey: "your-api-key",
  fallbacks: {
    "new-checkout": false,
    "dark-mode": false,
  },
});
```

Resolution order: **overrides → remote flags → fallbacks → `false`**

---

## Overriding flags

Use `client.override()` to force flag values at runtime — useful for feature previews, demos, or debugging.

```ts
// Turn a flag on
client.override({ "new-checkout": true });

// Restore a single flag to its remote value
client.clearOverride("new-checkout");

// Restore all flags
client.clearOverrides();
```

---

## Testing

Use `createMockVexilloClient` to create a pre-seeded client. `isReady` is `true` immediately — no network calls, no async setup.

```tsx
import { render, screen } from "@testing-library/react";
import { VexilloClientProvider, createMockVexilloClient } from "@vexillo/react-sdk";
import { CheckoutButton } from "./CheckoutButton";

function renderWithFlags(flags: Record<string, boolean>) {
  const client = createMockVexilloClient({ flags });
  return render(
    <VexilloClientProvider client={client}>
      <CheckoutButton />
    </VexilloClientProvider>,
  );
}

it("shows the new checkout when the flag is on", () => {
  renderWithFlags({ "new-checkout": true });
  expect(screen.getByTestId("new-checkout")).toBeInTheDocument();
});

it("shows the old checkout when the flag is off", () => {
  renderWithFlags({ "new-checkout": false });
  expect(screen.getByTestId("old-checkout")).toBeInTheDocument();
});
```

For per-test overrides on a shared client, use `override` and `clearOverrides`:

```ts
beforeEach(() => {
  client.override({ "new-checkout": true });
});

afterEach(() => {
  client.clearOverrides();
});
```

---

## API reference

### `createVexilloClient(config)`

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | Yes | Base URL of your Vexillo deployment |
| `apiKey` | `string` | Yes | API key for authentication |
| `initialFlags` | `Record<string, boolean>` | No | Pre-resolved flags. When provided, `status` starts at `"ready"` and the cold-start fetch is skipped |
| `fallbacks` | `Record<string, boolean>` | No | Default values for unknown keys |
| `mode` | `"rest" \| "stream"` | No | Wire mode. Default `"rest"` (one-shot fetch + focus-triggered refresh). `"stream"` races REST against SSE on cold start, then keeps an SSE connection open with REST as a bridge during reconnects |
| `autoRefresh` | `{ onFocus?: boolean }` | No | REST-mode policy. Default `{ onFocus: true }`. Stream mode ignores this |
| `onError` | `(err: Error) => void` | No | Called on every wire error (cold-start REST, race REST, bridge REST, refresh) |

### `<VexilloClientProvider>`

| Prop | Type | Required | Description |
|---|---|---|---|
| `client` | `VexilloClient` | Yes | Client instance to provide to the tree |
| `children` | `ReactNode` | Yes | |

The provider calls `client.start()` on mount and the returned stop on unmount. Wire mode lives on the client config, not the provider.

### `useFlag(key)`

Returns `[value: boolean, isLoading: boolean]`. Must be called inside a `<VexilloClientProvider>`. Re-renders on this key's value changes and on status transitions.

### `useVexilloClient()`

Returns the `VexilloClient` instance from context. Use this for imperative access inside components — e.g. calling `override()`, `getAllFlags()`, or reading `status` directly.

```tsx
import { useVexilloClient } from "@vexillo/react-sdk";

export function DevTools() {
  const client = useVexilloClient();
  return <pre>{JSON.stringify(client.getAllFlags(), null, 2)}</pre>;
}
```

Must be called inside a `<VexilloClientProvider>`.

### `fetchFlags(baseUrl, apiKey)`

Low-level fetch helper. Returns a flat `Record<string, boolean>`, or an empty object on error — never throws. Use this in server components and request handlers to pre-load flags before rendering.

### `VexilloClient` instance

| Member | Type | Description |
|---|---|---|
| `status` | `"idle" \| "loading" \| "ready" \| "error"` | Lifecycle status. `idle` = never started; `loading` = cold start in flight with no flags; `ready` = flags available (stays `ready` across silent refreshes); `error` = cold start failed and there are no flags to fall back on |
| `isReady` | `boolean` | `true` once flags have been resolved (kept for ergonomic checks; equivalent to `status === "ready"`) |
| `lastError` | `Error \| null` | The error from the most recent failed wire attempt, or `null`. Cleared on the next successful snapshot |
| `start()` | `() => () => void` | Begin the configured wire activity. Idempotent. Returns a stop function that aborts in-flight requests and closes any SSE connection. Called automatically by `<VexilloClientProvider>` |
| `refresh()` | `() => Promise<void>` | One-shot REST refresh. Works in both modes — useful for forced refreshes or as the focus handler when `autoRefresh.onFocus` is disabled |
| `getFlag(key)` | `(key: string) => boolean` | Synchronous flag read. Priority: overrides > remote > fallbacks > false |
| `getAllFlags()` | `() => Record<string, boolean>` | Snapshot of all resolved flags (overrides + remote + fallbacks merged) |
| `override(flags)` | `(flags: Record<string, boolean>) => void` | Force flag values and notify subscribers |
| `clearOverride(key)` | `(key: string) => void` | Remove override for a specific key |
| `clearOverrides()` | `() => void` | Remove all overrides |
| `subscribe(key, fn)` | `(key: string, fn: (value: boolean) => void) => () => void` | Subscribe to a specific flag key. Returns unsubscribe |
| `subscribeAll(fn)` | `(fn: (flags: Record<string, boolean>) => void) => () => void` | Subscribe to any flag change. Returns unsubscribe |
| `subscribeStatus(fn)` | `(fn: (status: ClientStatus) => void) => () => void` | Subscribe to status transitions. Returns unsubscribe |

### `createMockVexilloClient(options?)`

| Option | Type | Description |
|---|---|---|
| `flags` | `Record<string, boolean>` | Flag values returned by `useFlag` |
| `fallbacks` | `Record<string, boolean>` | Fallback values for keys absent from `flags` |

---

## Error handling

Wire failures (network errors, non-2xx responses) are caught silently — flags will never crash your app. When a fetch fails:

- `useFlag` falls back to `fallbacks[key] ?? false`
- `client.lastError` is set to the error
- The `onError` callback is called if provided
- `client.status` becomes `"error"` only if the **cold start** failed and there are no flags to fall back on. Refresh and bridge-REST failures update `lastError` without flipping `status` away from `ready`.

```ts
const client = createVexilloClient({
  baseUrl: "https://your-vexillo.example.com",
  apiKey: "your-api-key",
  onError: (err) => {
    console.error("Failed to load flags:", err);
    Sentry.captureException(err);
  },
});
```
