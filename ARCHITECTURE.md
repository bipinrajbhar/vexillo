# Vexillo — Architecture & Implementation Guide

A top-to-bottom walkthrough of how the codebase is built. Read this to understand the
design decisions, data flows, and key patterns before diving into individual files.

---

## Table of Contents

1. [Mental Model](#1-mental-model)
2. [Request Flow](#2-request-flow)
3. [Database Layer](#3-database-layer)
4. [API Layer](#4-api-layer)
5. [Auth & Sessions](#5-auth--sessions)
6. [Per-Org Okta OAuth (JIT Provisioning)](#6-per-org-okta-oauth-jit-provisioning)
7. [SDK Endpoint](#7-sdk-endpoint)
8. [Web Frontend](#8-web-frontend)
9. [React SDK Package](#9-react-sdk-package)
10. [Key Patterns](#10-key-patterns)

---

## 1. Mental Model

Vexillo has three distinct audiences and three corresponding surfaces:

| Audience | Surface | Entry Point |
|----------|---------|-------------|
| **Platform operator** | `/admin` — manage orgs, promote super-admins | `apps/web/src/routes/admin.tsx` |
| **Org members** | `/org/:slug/*` — manage flags, environments, members | `apps/web/src/routes/org.$slug.tsx` |
| **SDK consumers** | `GET /api/sdk/flags` — fetch flag states at runtime | `apps/api/src/routes/sdk.ts` |

Everything is multi-tenant. An **Organization** is the root container. Each org has its own:
- Flags (feature toggles)
- Environments (production, staging, …)
- Members (users + roles)
- API keys (one per environment, for SDK auth)
- Okta OAuth credentials (for JIT member provisioning)

---

## 2. Request Flow

### Dashboard request (org member → dashboard API)

```
Browser
  → CloudFront (HTTPS, no cache for /api/*)
  → ALB
  → ECS Fargate (Hono API)
  → Session middleware (validate cookie → resolve user)
  → Org middleware (resolve org slug → verify membership → check suspension)
  → Route handler
  → DashboardService (business logic + invariants)
  → packages/db queries (Drizzle + PostgreSQL)
```

### SDK request (app → flags endpoint)

```
App server / browser
  → CloudFront (30s s-maxage + 60s stale-while-revalidate)
  → ALB
  → ECS Fargate
  → Bearer API key auth (hash → DB lookup → resolve env)
  → CORS enforcement (allowedOrigins per environment)
  → queryEnvironmentFlagStates()
  → { flags: [{ key, enabled }] }
```

---

## 3. Database Layer

**Location:** `packages/db/`

The database package is shared between `apps/api` and `apps/web`. It owns the schema,
migrations, and all query functions.

### Schema overview

`packages/db/src/schema.ts` defines 11 tables. The key relationships:

```
organizations
├── organizationMembers (orgId, userId, role)   ← who can access the dashboard
├── environments (orgId, name, slug)
│   ├── apiKeys (environmentId, keyHash, keyHint)
│   └── flagStates (flagId, environmentId, enabled)
└── flags (orgId, name, key)
    └── flagStates (flagId, environmentId, enabled)

authUser (managed by BetterAuth)
├── authSession
├── authAccount
└── organizationMembers
```

`flagStates` is the cross-join between `flags` and `environments`. Every flag has a state
row for every environment — seeded to `enabled: false` when either is created.

### Query modules

Rather than scattering SQL across the app, every query lives in a dedicated module:

| File | Responsibility |
|------|---------------|
| `queries/flags.ts` | Flag CRUD, state toggle, per-env state backfill |
| `queries/environments.ts` | Environment + API key management |
| `queries/members.ts` | Membership reads and mutations |
| `queries/orgs.ts` | Org lookups, user → orgs listing |
| `queries/sdk.ts` | API key validation, flag state fetch (no user context) |

### Key query: flags with states

`queryOrgFlagsWithStates` (`queries/flags.ts`) is the most complex query — it returns
every flag for an org with a `states` map keyed by environment slug:

```ts
// Result shape
type FlagWithStates = {
  id: string;
  name: string;
  key: string;
  states: Record<envSlug, boolean>;  // { "production": true, "staging": false }
};
```

It does this with a single join across `flags`, `flagStates`, and `environments`, then
aggregates in JS.

### Backfill invariant

Whenever a new flag or environment is created, the missing `flagStates` rows are filled in
with `enabled: false` using `onConflictDoNothing()`. This keeps the cross-join complete
without duplicates.

- New flag → `backfillFlagStatesForFlag(db, flagId, allEnvIds)`
- New environment → `insertEnvironmentWithKey` runs a transaction that includes a
  backfill for all existing flags

### Client factory

```ts
// packages/db/src/client.ts
export function createDbClient(databaseUrl: string, options?: { max?: number })
```

Called once in `apps/api/src/index.ts` with the `DATABASE_URL` from the environment.
The `max` option controls the postgres.js connection pool size (default 10, use 1 for
serverless).

---

## 4. API Layer

**Location:** `apps/api/src/`

The API is a [Hono](https://hono.dev) app running on the Bun runtime.

### Composition (`index.ts`)

```
createAuth(db)          → auth  (BetterAuth instance)
createDashboardService(db) → dashboardService
                             ↓
app.route('/api/auth', auth.handler)
app.route('/api/auth/org-oauth', orgOAuth(db, auth))
app.route('/api/sdk', sdk(db))
app.route('/api/dashboard', dashboard(db, dashboardService, getSession))
app.route('/api/superadmin', superadmin(db, getSession))
```

Each router receives exactly the dependencies it needs — no global state.

### Service layer (`services/dashboard-service.ts`)

The `DashboardService` sits between the route handlers and the DB queries. It enforces
business invariants that the DB can't express:

- Can't delete the last admin in an org
- Can't create a flag if the org has no environments
- Generates and hashes API keys before storing them
- Calls `backfillFlagStatesForFlag` after creating a flag

Domain errors have a `code` property that `handleServiceError()` maps to HTTP status:

```ts
class NotFoundError   extends Error { code = 'NOT_FOUND' }     // → 404
class ConflictError   extends Error { code = 'CONFLICT' }      // → 409
class PreconditionError extends Error { code = 'PRECONDITION' } // → 400
```

### Middleware pattern (dashboard routes)

Every dashboard route goes through two middleware layers before the handler runs:

**1. Session middleware** — reads `GET /api/auth/get-session` headers and resolves
the BetterAuth session. Returns 401 if missing.

**2. Org context middleware** — reads `:orgSlug` from the URL, fetches the org, verifies
the user is a member, and checks the org is not suspended. Attaches `{ org, role }` to
the Hono context.

```ts
// All org routes share this setup
const app = new Hono()
  .use('/:orgSlug/*', sessionMiddleware)
  .use('/:orgSlug/*', orgContextMiddleware)
  // Then route handlers can call c.get('org') and c.get('role')
```

### API key hashing (`lib/api-key.ts`)

API keys are never stored in plaintext:

```
generate  →  sdk-<40 hex chars>           (returned to user once)
store     →  SHA-256(key)                 (stored in apiKeys table)
display   →  sdk-abcd1234…ef56           (keyHint, always safe to show)
validate  →  hash incoming → compare DB  (O(1) lookup)
```

Rotation atomically deletes the old key and inserts the new one in a transaction.

---

## 5. Auth & Sessions

**Location:** `apps/api/src/lib/auth.ts`

Authentication uses [BetterAuth](https://better-auth.com). It manages users, sessions,
and OAuth accounts in the four `auth*` tables in the schema.

### Session lifecycle

1. User signs in via Okta (see §6)
2. BetterAuth sets a `better-auth.session_token` cookie
3. On every dashboard request, the session middleware calls
   `auth.api.getSession({ headers })` to resolve the user
4. Sessions expire after 7 days; refreshed after 1 day of inactivity

### Super-admin flag

`authUser.isSuperAdmin` is a boolean on the user record. It is set when:
- The user's email is in `SUPER_ADMIN_EMAILS` at sign-in time
- A super-admin promotes them via `PATCH /api/superadmin/users/:userId`

Super-admins get access to `/admin` in the dashboard and all `/api/superadmin/*` endpoints.
The superadmin router checks `isSuperAdmin` on every request and returns 403 if false.

### Org-level roles

`organizationMembers.role` is either `'admin'` or `'viewer'`. The org context middleware
attaches the role to the request context. Route handlers that mutate state check it:

```ts
if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
```

The first person to join an org automatically becomes an admin (handled in JIT
provisioning, §6).

---

## 6. Per-Org Okta OAuth (JIT Provisioning)

**Location:** `apps/api/src/routes/org-oauth.ts`

Each organization configures its own Okta application. Members sign in through their
org's Okta tenant — there is no global sign-in page.

### Flow

```
1. User → GET /api/auth/org-oauth/:slug/authorize?next=/org/acme/flags
           Server: fetch Okta OIDC discovery, generate PKCE verifier + challenge,
                   generate nonce, set signed state cookie, redirect to Okta

2. Okta  → GET /api/auth/org-oauth/callback?code=...&state=...
           Server: verify state cookie (HMAC-SHA256), exchange code for tokens,
                   fetch userinfo from Okta, upsert user in DB,
                   add to org as viewer (JIT), create BetterAuth session,
                   redirect to `next` URL

3. Browser has session cookie → dashboard loads
```

### Security mechanisms

| Mechanism | Purpose |
|-----------|---------|
| PKCE (SHA-256 code challenge) | Prevents authorization code interception |
| HMAC-SHA256 signed state cookie | Prevents CSRF; binds callback to initiator |
| Nonce in state | Prevents replay attacks |
| 10-minute state cookie expiry | Limits attack window |
| OIDC discovery | Avoids hardcoding Okta endpoint URLs |

### JIT provisioning

On every successful Okta sign-in:
1. `upsert` the user into `authUser` (create on first visit, update name on return)
2. If their email is in `SUPER_ADMIN_EMAILS`, set `isSuperAdmin = true`
3. Insert into `organizationMembers` with `role = 'viewer'` using `onConflictDoNothing`
   (so returning members keep their current role)
4. No invite required — access is controlled by who can authenticate with the org's Okta

---

## 7. SDK Endpoint

**Location:** `apps/api/src/routes/sdk.ts`

The SDK endpoint is the only one that doesn't require a user session. It's designed for
high-frequency reads with aggressive caching.

### Authentication

```
Authorization: Bearer sdk-<key>
  → hash key → lookup apiKeys table → resolve environment
  → check org status (reject if suspended)
```

### CORS

Each environment has an `allowedOrigins` array. The logic:

```
No Origin header       → return Access-Control-Allow-Origin: *  (server-to-server)
allowedOrigins = ['*'] → return *  (wildcard env)
Origin in list         → reflect exact origin
Origin not in list     → 403
```

This lets you lock down production to your domain while leaving a dev environment open.

### Caching

The response carries:
```
Cache-Control: public, s-maxage=30, stale-while-revalidate=60
```

CloudFront caches per `Authorization` header value (the API key). A CDN hit never
reaches the API container — flag changes propagate within 30–90 seconds.

### SSE stream stub

`GET /api/sdk/flags/stream` is a stub that sends a keepalive comment every 25 seconds.
It exists to reserve the URL for a real push-based invalidation system later.

---

## 8. Web Frontend

**Location:** `apps/web/`

The dashboard is a Vite + React SPA using [TanStack Router](https://tanstack.com/router)
for file-based routing with type-safe params and loaders.

### Route tree

```
__root.tsx          → ThemeProvider wrapper
├── index.tsx       → Workspace page (enter org slug)
├── org.$slug.tsx   → Org layout (sidebar, nav) — resolves org context in beforeLoad
│   ├── _auth/index.tsx      → Flags page
│   ├── _auth/environments.tsx → Environments + API keys
│   └── _auth/members.tsx    → Member management
├── org-sign-in.tsx → Per-org Okta sign-in page
└── admin.tsx       → Super-admin layout
    ├── admin/index.tsx      → Organizations list
    └── admin/super-admins.tsx → Super-admin users
```

### Data loading pattern

Routes use TanStack Router's `beforeLoad` / `loader` lifecycle:

```ts
// org.$slug.tsx
beforeLoad: async ({ params }) => {
  const ctx = await api.dashboard.orgSlug.context.get({ params })
  if (!ctx) throw redirect({ to: '/org-sign-in/$slug', params })
  return { org: ctx.org, role: ctx.role }
}
```

The loaded data flows as route context to all child routes — no prop drilling.

### API client (`lib/api-client.ts`)

A typed wrapper around `fetch` that maps every API endpoint to a function with
TypeScript-inferred request/response types. Route handlers call these functions
rather than raw `fetch`.

### Optimistic UI

Flag toggles update the local state immediately before the API call resolves, then
roll back if the request fails:

```ts
// Immediately flip the toggle in local state
setFlags(flags => toggle(flags, key, envSlug))

try {
  await api.toggle(orgSlug, key, envId)
} catch {
  // Roll back
  setFlags(flags => toggle(flags, key, envSlug))
  toast.error('Failed to toggle flag')
}
```

### Theme system (`src/globals.css`)

CSS custom properties define the design tokens. The palette is Vercel-inspired:
- Light: white background, black primary
- Dark: `#000` background, white primary
- Muted, border, and radius tokens scale from the base values

`ThemeProvider` from `next-themes` toggles the `dark` class on `<html>`.

---

## 9. React SDK Package

**Location:** `packages/react-sdk/`

Published as `@vexillo/react-sdk`. Consumers install this in their apps to read
feature flags.

### Core: `VexilloClient` (`src/client.ts`)

The client holds three maps:

```ts
remote:    Map<key, boolean>   // fetched from /api/sdk/flags
overrides: Map<key, boolean>   // set imperatively (tests / manual control)
listeners: Map<key, Set<fn>>   // per-key React subscribers
```

Flag resolution priority: **overrides → remote → fallbacks → false**

`load()` calls the API and notifies all subscribers. `subscribe(key, fn)` returns an
unsubscribe function, used by `useFlag`.

### React layer

```
VexilloClientProvider   → puts client in context, calls load() on mount
useFlag(key)            → [value, isLoading] — subscribes to one key
useVexilloClient()      → escape hatch for full client access
```

`useFlag` only re-renders when the specific key's value changes. Subscribing to 20
flags means 20 independent subscriptions — each component re-renders only for its own
flag.

### SSR support (`src/fetch-flags.ts`)

```ts
// On the server, before rendering:
const flags = await fetchFlags(baseUrl, apiKey)

// Pass to provider:
<VexilloClientProvider client={new VexilloClient({ ..., initialFlags: flags })}>
```

`initialFlags` pre-seeds the remote map so the first render has the correct values
without a loading flash.

### Testing (`src/testing.ts`)

```ts
const client = createMockVexilloClient({ flags: { newCheckout: true } })
// isReady = true immediately, load() is a no-op
// override() works normally for per-test mutations
```

---

## 10. Key Patterns

### Layered architecture

```
Route handler   →  validates input, maps errors to HTTP status
Service layer   →  enforces business invariants, orchestrates multi-step ops
Query layer     →  single-responsibility DB functions, no business logic
```

Never skip layers: routes don't call queries directly, queries don't enforce business rules.

### Typed errors

```ts
throw new NotFoundError('Flag not found')   // → 404
throw new ConflictError('Key already exists') // → 409
throw new PreconditionError('No environments') // → 400
```

`handleServiceError()` in each route maps these to HTTP responses. Adding a new error
type is one change, not scattered `if` checks.

### Atomic transactions

Multi-step writes use `db.transaction()`:

- Create environment → insert env + insert API key + backfill flag states (all or nothing)
- Rotate API key → delete old + insert new (no gap where both or neither exist)

### CORS per environment

Production environments typically list `['https://app.example.com']`. Dev environments
might list `['*']`. The SDK route enforces this without any application code on the
consumer side — the API key is bound to an environment, and the environment carries its
own CORS policy.

### Flag state matrix

The `flagStates` table is always a complete cross-join. Backfill runs on every flag and
environment creation so there are no missing rows. Queries never need to `LEFT JOIN` and
handle nulls — every flag always has a state in every environment.

### API key masking

Full keys are returned exactly once (creation/rotation), never stored in plaintext, and
never returned again by the API. `keyHint` (`sdk-abcd…ef56`) is always safe to display.
Validation hashes the incoming key and compares to `keyHash` — the plaintext never
touches the DB.
