# @vexillo/api

Hono API server running on Bun. Handles authentication, the dashboard API, the public SDK endpoints, super-admin management, and org member invites.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- PostgreSQL ≥ 14
- An [Okta](https://developer.okta.com) OIDC app for platform sign-in

## Environment variables

Copy and fill in the values:

```sh
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://user:pass@localhost:5432/vexillo` |
| `BETTER_AUTH_URL` | Public base URL of the web dashboard (used as the auth base URL), e.g. `http://localhost:5173` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated list of origins allowed to make auth requests, e.g. `http://localhost:5173` |
| `BETTER_AUTH_SECRET` | Random secret for signing sessions — generate with `openssl rand -base64 32` |
| `OKTA_CLIENT_ID` | Client ID of the Okta OIDC app used for platform sign-in |
| `OKTA_CLIENT_SECRET` | Client secret of the platform Okta app |
| `OKTA_ISSUER` | Issuer URL of the platform Okta org, e.g. `https://dev-xxxxx.okta.com` |

> **Per-org Okta credentials** (for org member sign-in) are stored in the database and configured via the super-admin dashboard, not via environment variables.

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
| `bun run promote:super-admin -- --email you@example.com` | Promote a user to super-admin |

## Route overview

| Prefix | Auth | Description |
|--------|------|-------------|
| `GET /health` | None | Health check for load balancers |
| `/api/auth/org-oauth/*` | None | Per-org Okta PKCE OAuth flow |
| `/api/auth/*` | None | BetterAuth — platform Okta OAuth, session management |
| `/api/sdk/*` | API key | Public SDK endpoint — flag evaluation, CDN-cacheable |
| `/api/dashboard/*` | Session | Org dashboard — flags, environments, members, API keys |
| `/api/superadmin/*` | Super-admin | Org CRUD, status management |
| `/api/invites/*` | Session (no org) | Accept org member invites |

## Auth

Platform sign-in (super-admins and initial org setup) uses Okta OAuth via [BetterAuth](https://better-auth.com). Org member sign-in uses a per-org PKCE flow with each org's own Okta credentials.

The first user account created is assigned the `admin` role. Use `promote:super-admin` to grant `isSuperAdmin` to an existing account.
