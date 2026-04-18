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
| `/api/sdk/*` | API key | Public SDK endpoint — flag states, CDN-cacheable |
| `/api/dashboard/*` | Session (org member) | Org dashboard — flags, environments, members, API keys |
| `/api/superadmin/*` | Super-admin | Org CRUD, Okta config, status management |

### Dashboard access levels

Within `/api/dashboard/*`, most endpoints require an active org session. Role-specific restrictions:

- **All members (viewer + admin)** — read flags, environments, and members
- **Admins** — manage flags, environments, API keys, view suspended members, and change member roles (cannot change super-admin roles)
- **Super-admins** — suspend/restore members, manage orgs

## Caching

Two layers of caching apply to `GET /api/sdk/flags`:

| Layer | Where | TTL | Details |
|-------|-------|-----|---------|
| In-process LRU | API container | 30 s | `createFlagCache()` (`lib/flag-cache.ts`) — up to 500 environments, keyed by `environmentId`. Matches the CDN TTL so DB load is minimised across the full cache window. |
| HTTP / CDN | Browser + CloudFront | 30 s | `Cache-Control: s-maxage=30`. CloudFront caches per `Authorization` header. |

The OpenAPI spec has a longer cache:

| Route | Cache-Control |
|-------|---------------|
| `GET /api/openapi.json` | `public, max-age=300, stale-while-revalidate=60` |

All other routes (`/api/auth/*`, `/api/dashboard/*`, `/api/superadmin/*`) are uncached — they carry session state or mutate data.

## Auth

Authentication is per-org — each organisation configures its own Okta OIDC app. Members sign in through their org's Okta tenant via a PKCE flow. There is no global sign-in page.

Session management is handled by [BetterAuth](https://better-auth.com). Okta client secrets are encrypted at rest using AES-256-GCM (requires `OKTA_SECRET_KEY`).

The first user to sign in via an org's Okta app is provisioned as a viewer. Set `SUPER_ADMIN_EMAILS` to auto-promote specific accounts to super-admin on sign-in.
