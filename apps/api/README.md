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
| `GET /api/sdk/flags/stream` | API key | SSE stream — delivers the full flag snapshot immediately, then pushes a new snapshot on every toggle. Keepalive comment every 25 s. Includes `id:` and `retry:` fields per the SSE spec. |
| `/api/dashboard/*` | Session (org member) | Org dashboard — flags, environments, members, API keys |
| `/api/superadmin/*` | Super-admin | Org CRUD, Okta config, status management |
| `POST /internal/flag-change` | `X-Internal-Secret` header | Cross-region propagation — receives a flag snapshot from the primary region, writes it to the local snapshot cache, and broadcasts to locally connected SSE clients. Not exposed via CloudFront; only accessible via the ALB directly. |

### Dashboard access levels

Within `/api/dashboard/*`, most endpoints require an active org session. Role-specific restrictions:

- **All members (viewer + admin)** — read flags, environments, and members
- **Admins** — manage flags, environments, API keys, view suspended members, and change member roles (cannot change super-admin roles)
- **Super-admins** — suspend/restore members, manage orgs

## Caching

**Dashboard service** caches flags, environments, and members in-process (LRU, 30 s TTL, keyed by `orgId`) with write-through invalidation on every mutation.

**SDK routes** maintain two additional in-process caches to minimise DB round-trips on SSE connects:

| Cache | Key | TTL | Description |
|-------|-----|-----|-------------|
| Auth cache | API key hash | 30 s | Resolved `environmentId`, `orgId`, `allowedOrigins`, and org status. Shared by `GET /flags` and `GET /flags/stream`. |
| Snapshot cache | `environmentId` | 30 s | Full flag snapshot JSON. Kept warm by `notifyFlagChange` on every toggle — subsequent SSE connects skip the DB entirely. |

On a warm connection (same API key, at least one recent toggle) SSE stream connect time drops from ~150 ms to under 20 ms.

**CloudFront** caches `GET /api/sdk/flags` for 5 minutes (300 s default TTL, 600 s max TTL), keyed on `Authorization` and `CloudFront-Viewer-Country` so each API key + viewer country combination gets its own cache entry. The origin also sends `Cache-Control: s-maxage=300, stale-while-revalidate=60` to align intermediate caches with the CloudFront policy.

| Route | Cache-Control (origin) | CloudFront TTL |
|-------|------------------------|----------------|
| `GET /api/openapi.json` | `public, max-age=300, stale-while-revalidate=60` | Not cached (dashboard policy) |
| `GET /api/sdk/flags` | `s-maxage=300, stale-while-revalidate=60` | 5 min (300 s default) |
| `GET /api/sdk/flags/stream` | `no-cache` | Not cached (TTL=0 stream policy) |

> SDK clients using `connectStream()` fetch `GET /api/sdk/flags` first (CDN cache hit, typically < 50 ms) to populate flags immediately, then open the SSE connection for real-time updates. The SSE snapshot overwrites the cached REST response once the stream connects.

## Multi-region propagation

When `SECONDARY_REGION_URLS` is set, every call to `notifyFlagChange` (triggered by a flag toggle or country rule update on the primary region) fires a **fire-and-forget** HTTP POST to each secondary region's `/internal/flag-change` endpoint:

```
POST https://<secondary-alb>/internal/flag-change
X-Internal-Secret: <INTERNAL_SECRET>
Content-Type: application/json

{ "envId": "<environmentId>", "payload": "<flag snapshot JSON>" }
```

The secondary:
1. Validates `X-Internal-Secret` — returns 401 if missing or wrong.
2. Writes `payload` to its local `snapshotCache`.
3. Publishes to its local Redis pub/sub channel (or broadcasts directly if no Redis), pushing the snapshot to all SSE clients connected to that region.

A failure (network error, non-2xx response) is logged but does not block the primary's response. The secondary falls back to serving stale snapshots until its 30 s cache TTL expires and it refetches from RDS.

**Setup** (operator steps after deploying a secondary region):
1. Generate a shared secret: `openssl rand -hex 32`
2. Store it as `/vexillo/INTERNAL_SECRET` SecureString in SSM in **every** region.
3. After the secondary stack is deployed, copy its ALB DNS name into `/vexillo/SECONDARY_REGION_URLS` in the primary region's SSM, then redeploy the primary ECS service to pick up the new value.

## Auth

Authentication is per-org — each organisation configures its own Okta OIDC app. Members sign in through their org's Okta tenant via a PKCE flow. There is no global sign-in page.

Session management is handled by [BetterAuth](https://better-auth.com). Okta client secrets are encrypted at rest using AES-256-GCM (requires `OKTA_SECRET_KEY`).

The first user to sign in via an org's Okta app is provisioned as a viewer. Set `SUPER_ADMIN_EMAILS` to auto-promote specific accounts to super-admin on sign-in.
