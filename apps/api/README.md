# @vexillo/api

Hono API server running on Bun. Handles authentication, the dashboard API, the public SDK endpoint, and super-admin management.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- PostgreSQL ≥ 14
- An [Okta](https://developer.okta.com) app per organisation (configured by super-admins in the dashboard)

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://user:pass@localhost:5432/vexillo` |
| `BETTER_AUTH_URL` | Base URL of this API server, e.g. `http://localhost:3000` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated origins allowed to make auth requests, e.g. `http://localhost:5173` |
| `BETTER_AUTH_SECRET` | Random secret for signing sessions — generate with `openssl rand -base64 32` |
| `OKTA_SECRET_KEY` | 64-char hex string for encrypting per-org Okta client secrets at rest — generate with `openssl rand -hex 32` |
| `SUPER_ADMIN_EMAILS` | Comma-separated emails auto-promoted to super-admin on first sign-in |
| `REDIS_URL` | _(Optional)_ Redis connection string, e.g. `redis://localhost:6379`. Enables cross-container SSE fan-out. Omit for single-container deployments — flag toggles still reach all local SSE connections. |
| `INTERNAL_SECRET` | _(Optional)_ Shared secret for cross-region propagation. The primary region includes it as `X-Internal-Secret` on outbound POSTs; each secondary verifies it on inbound requests. Must be identical in all regions. If unset a random value is generated at startup. |
| `SECONDARY_REGION_URLS` | _(Optional)_ Comma-separated ALB base URLs of secondary regions, e.g. `https://eu-alb.example.com,https://ap-alb.example.com`. Set only on the primary. Leave empty or unset in secondary regions. |

> Per-org Okta credentials are stored encrypted in the database and configured via the super-admin dashboard, not via environment variables.

## Running locally

```sh
bun run dev
```

The API starts on `http://localhost:3000` with hot reload.

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start with hot reload |
| `bun run start` | Start without hot reload |
| `bun run typecheck` | TypeScript type check |
| `bun test` | Run test suite |

## Route overview

| Prefix | Auth | Description |
|--------|------|-------------|
| `GET /health` | None | Health check for load balancers |
| `GET /api/docs` | None | Interactive API docs (Scalar UI) |
| `GET /api/openapi.json` | None | OpenAPI spec (JSON) |
| `/api/auth/org-oauth/*` | None | Per-org Okta PKCE OAuth flow (authorize + callback) |
| `/api/auth/*` | None | BetterAuth — session management |
| `GET /api/sdk/flags` | API key | Current flag snapshot for an environment (JSON, CDN-cacheable) |
| `GET /api/sdk/flags/stream` | API key | SSE stream — delivers the full flag snapshot immediately, then pushes a new snapshot on every toggle. Keepalive comment every 25 s. Includes `id:` and `retry:` fields per the SSE spec. Reconnects send `Last-Event-ID` so the server continues the id sequence. |
| `/api/dashboard/*` | Session (org member) | Org dashboard — flags, environments, members, API keys |
| `/api/superadmin/*` | Super-admin | Org CRUD, Okta config, status management |
| `POST /internal/flag-change` | `X-Internal-Secret` header | Cross-region propagation — receives a flag snapshot from the primary region and hands it to `FlagSnapshotWriter.ingestRemote()` (writes local cache + broadcasts to locally connected SSE clients, but skips region fanout). Not exposed via CloudFront; only accessible via the ALB directly. |

### Dashboard access levels

Within `/api/dashboard/*`, most endpoints require an active org session. Role-specific restrictions:

- **All members (viewer + admin)** — read flags, environments, and members
- **Admins** — manage flags, environments, API keys, view suspended members, and change member roles (cannot change super-admin roles)
- **Super-admins** — suspend/restore members, manage orgs; cannot delete an org they are an active member of (returns 403)

## Architecture

The hot paths are organised around two modules:

- **`FlagSnapshots`** (`src/lib/flag-snapshots/`) — owns everything the SDK reads: the per-`environmentId` snapshot cache (LRU, 30 s TTL, SWR refresh), country-rule evaluation, the inter-container bus (Redis pub/sub or in-memory), the SSE listener registry, the SSE response shape (TransformStream, keepalive, id sequencing, `retry:` hint, abort cleanup), and cross-region fanout. The factory returns a `{ reader, writer }` split. The reader powers `GET /api/sdk/flags` and `/flags/stream`; the writer is handed only to mutation paths. `writer.publishLocal()` writes locally, broadcasts to the inter-container bus, and fans out to peer regions. `writer.ingestRemote()` does the first two but never fans out — the no-region-loop invariant is enforced structurally at the route boundary.
- **`FlagOps`** (`src/services/flag-ops/`) — single mutation orchestrator for the dashboard write path. `DashboardService` writes to the DB; `flagOps.commit(event)` fans out the consequences. Each `DomainEvent` (e.g. `flag.toggled`, `env.key_rotated`, `member.removed`) maps to a fixed combination of: audit-log insert (atomic with the caller's tx when supplied), `FlagSnapshotWriter.publishLocal()` for state-changing flag/env events, eviction of the four orgId-keyed list caches FlagOps owns, `SdkAuthenticator.evictByEnvironment()` for env mutations, and `OrgContextResolver.invalidate()` for membership changes. Ordering is enforced inside `commit` and not visible to callers. List endpoints route through `flagOps.read.*` (read-through caches keyed by `orgId`); the cache layout is private.

`SdkAuthenticator` (`src/lib/sdk-authenticator.ts`) owns the SDK auth+origin gate end-to-end: 3-table join (api key hash → environment → org) on cold miss, LRU slot cache (1000 entries, 30 s TTL), per-env generation counter for O(1) eviction on rotation, and dead-slot tracking so a failed background refresh forces the next request to re-validate synchronously.

## Caching

| Cache | Owner | Key | TTL | Description |
|-------|-------|-----|-----|-------------|
| Snapshot cache | `FlagSnapshots` | `environmentId` | 30 s | Raw flag-snapshot JSON. Kept warm by `writer.publishLocal` on every toggle and by `writer.ingestRemote` on cross-region delivery — subsequent REST/SSE serves skip the DB entirely. SWR: a stale hit serves immediately and triggers a background refresh. |
| Auth cache | `SdkAuthenticator` | API key hash | 30 s | Resolved `environmentId`, `orgId`, `allowedOrigins`, and org status. Shared by `GET /flags` and `GET /flags/stream`. Evicted by FlagOps on `env.key_rotated` / `env.origins_updated` / `env.deleted`. |
| Dashboard list caches | `FlagOps` | `orgId` | 30 s | Four LRU caches behind `flagOps.read.*` — flags-with-states, environments, members, removed-members. Busted on every `commit(event)` for the matching org. |

On a warm connection (same API key, at least one recent toggle) SSE stream connect time drops from ~150 ms to under 20 ms.

**CloudFront** caches `GET /api/sdk/flags` for 5 minutes (300 s default TTL, 600 s max TTL), keyed on `Authorization` and `CloudFront-Viewer-Country` so each API key + viewer country combination gets its own cache entry. The origin also sends `Cache-Control: s-maxage=300, stale-while-revalidate=60` to align intermediate caches with the CloudFront policy.

| Route | Cache-Control (origin) | CloudFront TTL |
|-------|------------------------|----------------|
| `GET /api/openapi.json` | `public, max-age=300, stale-while-revalidate=60` | Not cached (dashboard policy) |
| `GET /api/sdk/flags` | `s-maxage=300, stale-while-revalidate=60` | 5 min (300 s default) |
| `GET /api/sdk/flags/stream` | `no-cache` | Not cached (TTL=0 stream policy) |

> SDK clients in `mode: "stream"` race REST against SSE on cold start — `GET /api/sdk/flags` (CDN cache hit, typically < 50 ms) populates flags immediately while the SSE handshake completes, and the first SSE snapshot then overwrites the REST response.

## Testing FlagSnapshots and FlagOps

`src/lib/flag-snapshots/test-adapters.ts` exposes the seams the module is built around. Use these instead of stubbing the public surface:

| Adapter | Purpose |
|---------|---------|
| `createFakeClock()` | Fixed-time clock with `advance(ms)` — turn SWR staleness into a deterministic synchronous assertion. |
| `createImmediateScheduler()` | Runs background tasks synchronously up to the first `await`; call `flush()` in the test to drain the SWR refresh promise. |
| `createFakeLoader(initial)` | Versioned in-memory snapshot loader; `setVersion(envId, v)` lets you assert which version a `serve()` returned. |
| `createInMemoryStore()` | Map-backed `SnapshotStore` (no eviction). |
| `createCapturingFanout()` | Records `[envId, payload]` for region-fanout assertions. |
| `createFakeIntervalScheduler()` | Manual ticker for the SSE keepalive timer (`tick()`, `activeCount()`). |

For service-level tests of `DashboardService` you typically construct a real `FlagOps` with a fake `FlagSnapshotWriter` (`{ publishLocal: vi.fn() }`) and assert that the right `commit(event)` ran — the audit row, the publish call, and the cache busts are atomic by construction.

## Multi-region propagation

When `SECONDARY_REGION_URLS` is set, every call to `FlagSnapshotWriter.publishLocal()` (driven by `FlagOps.commit` on flag toggles or country-rule updates) fires a **fire-and-forget** HTTP POST to each secondary region's `/internal/flag-change` endpoint:

```
POST https://<secondary-alb>/internal/flag-change
X-Internal-Secret: <INTERNAL_SECRET>
Content-Type: application/json

{ "envId": "<environmentId>", "payload": "<flag snapshot JSON>" }
```

The secondary:
1. Validates `X-Internal-Secret` — returns 401 if missing or wrong.
2. Hands the body to `FlagSnapshotWriter.ingestRemote()`, which writes the payload to its local snapshot cache and publishes onto its inter-container bus (Redis pub/sub when `REDIS_URL` is set, in-memory otherwise) — pushing the snapshot to all SSE clients connected to that region. `ingestRemote` deliberately does **not** call `regionFanout`, so a primary→secondary→primary loop is impossible.

A failure (network error, non-2xx response) is logged but does not block the primary's response. The secondary falls back to serving stale snapshots until its 30 s cache TTL expires and it refetches from RDS via the SWR refresh path.

**Setup** (operator steps after deploying a secondary region):
1. Generate a shared secret: `openssl rand -hex 32`
2. Store it as `/vexillo/INTERNAL_SECRET` SecureString in SSM in **every** region.
3. After the secondary stack is deployed, copy its ALB DNS name into `/vexillo/SECONDARY_REGION_URLS` in the primary region's SSM, then redeploy the primary ECS service to pick up the new value.

## Auth

Authentication is per-org — each organisation configures its own Okta OIDC app. Members sign in through their org's Okta tenant via a PKCE flow. There is no global sign-in page.

Session management is handled by [BetterAuth](https://better-auth.com). Okta client secrets are encrypted at rest using AES-256-GCM (requires `OKTA_SECRET_KEY`).

The first user to sign in via an org's Okta app is provisioned as a viewer. Set `SUPER_ADMIN_EMAILS` to auto-promote specific accounts to super-admin on sign-in.
