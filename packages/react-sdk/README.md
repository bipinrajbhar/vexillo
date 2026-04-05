# @vexillo/react-sdk

React bindings for [Vexillo](https://vexillo-web.vercel.app) — a self-hosted feature flag service.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [SPA](#spa)
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

For client-side only apps (Create React App, Vite, etc.). Flags are fetched on mount; components read them with `useFlag`.

**1. Create a client**

```ts
// lib/vexillo.ts
import { createVexilloClient } from "@vexillo/react-sdk";

export const client = createVexilloClient({
  baseUrl: "https://your-vexillo.example.com",
  apiKey: "your-api-key",
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

**3. Read flags in components**

```tsx
import { useFlag } from "@vexillo/react-sdk";

export function CheckoutButton() {
  const [newCheckout, isLoading] = useFlag("new-checkout");

  if (isLoading) return null;

  return newCheckout ? <NewCheckout /> : <OldCheckout />;
}
```

`useFlag` returns `[value, isLoading]`. The component re-renders only when the value of that specific flag changes.

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
| `initialFlags` | `Record<string, boolean>` | No | Pre-seed flags and skip the initial fetch |
| `fallbacks` | `Record<string, boolean>` | No | Default values for unknown keys |
| `onError` | `(err: Error) => void` | No | Called when `load()` fails |

### `<VexilloClientProvider>`

| Prop | Type | Required | Description |
|---|---|---|---|
| `client` | `VexilloClient` | Yes | Client instance to provide to the tree |
| `children` | `ReactNode` | Yes | |

### `useFlag(key)`

Returns `[value: boolean, isLoading: boolean]`. Must be called inside a `<VexilloClientProvider>`.

### `useVexilloClient()`

Returns the `VexilloClient` instance from context. Use this for imperative access inside components — e.g. calling `override()`, `getAllFlags()`, or reading `isReady` directly.

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
| `isReady` | `boolean` | `true` once `load()` has resolved or `initialFlags` was provided |
| `lastError` | `Error \| null` | The error from the most recent failed `load()`, or `null` |
| `load()` | `() => Promise<void>` | Fetches flags from the API. Called automatically by `<VexilloClientProvider>` on mount |
| `getFlag(key)` | `(key: string) => boolean` | Synchronous flag read |
| `getAllFlags()` | `() => Record<string, boolean>` | Snapshot of all resolved flags |
| `override(flags)` | `(flags: Record<string, boolean>) => void` | Force flag values and notify subscribers |
| `clearOverride(key)` | `(key: string) => void` | Remove override for a specific key |
| `clearOverrides()` | `() => void` | Remove all overrides |
| `subscribe(key, fn)` | `(key: string, fn: (value: boolean) => void) => () => void` | Subscribe to a specific flag key. Returns unsubscribe |
| `subscribeAll(fn)` | `(fn: (flags: Record<string, boolean>) => void) => () => void` | Subscribe to any flag change. Returns unsubscribe |

### `createMockVexilloClient(options?)`

| Option | Type | Description |
|---|---|---|
| `flags` | `Record<string, boolean>` | Flag values returned by `useFlag` |
| `fallbacks` | `Record<string, boolean>` | Fallback values for keys absent from `flags` |

---

## Error handling

`load()` failures (network errors, non-2xx responses) are caught silently — flags will never crash your app. When a load fails:

- `useFlag` falls back to `fallbacks[key] ?? false`
- `client.lastError` is set to the error
- The `onError` callback is called if provided

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
