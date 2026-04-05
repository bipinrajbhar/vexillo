# @vexillo/react-sdk

React bindings for [Vexillo](https://vexillo-web.vercel.app) — a self-hosted feature flag service.

## Requirements

- React 19+
- A running Vexillo deployment

## Installation

```sh
npm install @vexillo/react-sdk
```

## Usage

### SPA (no SSR)

Wrap your app with `<VexilloProvider>` inside a `<Suspense>` boundary. The provider fetches flags on mount and suspends the subtree until they resolve.

```tsx
import { Suspense } from "react";
import { VexilloProvider, useFlag } from "@vexillo/react-sdk";

function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <VexilloProvider
        baseUrl="https://your-vexillo.example.com"
        apiKey="your-api-key"
        fallbacks={{ "new-checkout": false }}
      >
        <MyApp />
      </VexilloProvider>
    </Suspense>
  );
}

function MyApp() {
  const newCheckout = useFlag("new-checkout");
  return newCheckout ? <NewCheckout /> : <OldCheckout />;
}
```

---

### Next.js App Router (RSC)

Fetch flags in your server component and pass them as `initialFlags`. The provider renders synchronously on the server with no Suspense needed.

```tsx
// app/layout.tsx
import { fetchFlags, VexilloProvider } from "@vexillo/react-sdk";

export default async function RootLayout({ children }) {
  const flags = await fetchFlags(
    process.env.VEXILLO_BASE_URL,
    process.env.VEXILLO_API_KEY,
  );

  return (
    <html>
      <body>
        <VexilloProvider
          baseUrl={process.env.VEXILLO_BASE_URL}
          apiKey={process.env.VEXILLO_API_KEY}
          initialFlags={flags}
        >
          {children}
        </VexilloProvider>
      </body>
    </html>
  );
}
```

Client components use `useFlag` as normal:

```tsx
"use client";
import { useFlag } from "@vexillo/react-sdk";

export function CheckoutButton() {
  const newCheckout = useFlag("new-checkout");
  return newCheckout ? <NewCheckoutButton /> : <OldCheckoutButton />;
}
```

---

### Node.js SSR with `renderToPipeableStream`

Suspense is supported — `initialFlags` is optional. The provider suspends inline and the resolved flags are streamed to the client.

```tsx
import { renderToPipeableStream } from "react-dom/server";
import { VexilloProvider } from "@vexillo/react-sdk";

const { pipe } = renderToPipeableStream(
  <Suspense fallback={<Spinner />}>
    <VexilloProvider baseUrl={BASE_URL} apiKey={API_KEY}>
      <App />
    </VexilloProvider>
  </Suspense>,
);

pipe(res);
```

Or pass `initialFlags` to skip the suspension entirely:

```tsx
import { fetchFlags, VexilloProvider } from "@vexillo/react-sdk";

const flags = await fetchFlags(BASE_URL, API_KEY);

const { pipe } = renderToPipeableStream(
  <VexilloProvider baseUrl={BASE_URL} apiKey={API_KEY} initialFlags={flags}>
    <App />
  </VexilloProvider>,
);
```

---

### Node.js SSR with `renderToString`

> **`renderToString` does not support Suspense.** You must call `fetchFlags` before rendering and pass the result as `initialFlags`, otherwise the provider will throw.

```tsx
import { renderToString } from "react-dom/server";
import { fetchFlags, VexilloProvider } from "@vexillo/react-sdk";

// In your request handler:
const flags = await fetchFlags(BASE_URL, API_KEY);

const html = renderToString(
  <VexilloProvider baseUrl={BASE_URL} apiKey={API_KEY} initialFlags={flags}>
    <App />
  </VexilloProvider>,
);
```

---

## API

### `<VexilloProvider>`

| Prop | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | Yes | Base URL of your Vexillo deployment |
| `apiKey` | `string` | Yes | SDK API key for the target environment |
| `initialFlags` | `Record<string, boolean>` | No* | Pre-resolved flags from the server. **Required when using `renderToString`** |
| `fallbacks` | `Record<string, boolean>` | No | Default values for unknown flag keys (default: `{}`) |
| `children` | `ReactNode` | Yes | |

### `useFlag(key: string): boolean`

Returns the current value of a feature flag. Falls back to `fallbacks[key] ?? false` for unknown keys. Must be called inside a `<VexilloProvider>`.

### `fetchFlags(baseUrl: string, apiKey: string): Promise<Record<string, boolean>>`

Fetches flags from the Vexillo API. Use this on the server to get `initialFlags`. Returns an empty object on error — never throws.

## Error handling

Fetch failures (network errors, non-2xx responses) silently resolve with an empty flag map. All `useFlag` calls fall back to `fallbacks[key] ?? false`. Feature flags will never crash your app.

## Caching

On the **client**, flags are cached in memory by `baseUrl + apiKey`. The cache is invalidated when either prop changes, triggering a new fetch and re-suspension.

On the **server**, every render fetches fresh — there is no server-side cache to prevent flag data from leaking across requests in Node.js.
