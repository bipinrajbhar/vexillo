# Vexillo

Self-hosted feature flag service. Manage flags per environment and organisation, with a React SDK for consumption.

## Packages

| Package | Description |
|---------|-------------|
| `apps/api` | Hono API (Bun runtime) — auth, dashboard, SDK, super-admin, and invite endpoints |
| `apps/web` | Vite + React dashboard — org management, flags, environments, and members |
| `packages/db` | Drizzle ORM schema + PostgreSQL migrations shared by `api` and `web` |
| `packages/react-sdk` | `@vexillo/react-sdk` — React bindings for consuming flags in any app |

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x (API runtime)
- [Node.js](https://nodejs.org) ≥ 20 (web tooling)
- [pnpm](https://pnpm.io) ≥ 10
- PostgreSQL ≥ 14
- An [Okta](https://developer.okta.com) account

## Getting started

```sh
pnpm install
```

Set up environment variables for each app (see their individual READMEs), then push the schema to your database:

```sh
pnpm --filter @vexillo/db db:push
```

Start everything in development mode:

```sh
pnpm dev
```

- API: `http://localhost:3000`
- Web dashboard: `http://localhost:5173`

## First-time setup

1. Sign in at `http://localhost:5173/sign-in` via your platform Okta app — the first account created becomes an admin
2. Promote that account to super-admin:
   ```sh
   pnpm --filter @vexillo/api promote:super-admin -- --email you@example.com
   ```
3. Sign in again — you'll be redirected to `/admin`
4. Create an organisation and configure its Okta OAuth credentials (use `https://<domain>.okta.com` as the issuer, not `/oauth2/default`)
5. Org members sign in at `http://localhost:5173/org/<slug>/sign-in`

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in watch mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all test suites |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint all packages |

## React SDK

See [`packages/react-sdk/README.md`](packages/react-sdk/README.md) for installation and usage.
