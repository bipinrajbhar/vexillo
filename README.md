# Vexillo

Self-hosted feature flag service. Manage flags per environment and organisation, with a React SDK for consumption.

## Packages

| Package | Description |
|---------|-------------|
| `apps/api` | Hono API (Bun runtime) — auth, dashboard, SDK, and super-admin endpoints; Okta JIT member provisioning |
| `apps/web` | Vite + React dashboard — org management, flags, environments, and members |
| `packages/db` | Drizzle ORM schema + PostgreSQL migrations |
| `packages/react-sdk` | `@vexillo/react-sdk` — React bindings for consuming flags in any app |

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- [pnpm](https://pnpm.io) ≥ 10
- PostgreSQL ≥ 14
- An [Okta](https://developer.okta.com) account (one app per organisation)

## Getting started

```sh
pnpm install
```

Set required environment variables for `apps/api`:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_URL` | Base URL of the API (e.g. `http://localhost:3000`) |
| `BETTER_AUTH_SECRET` | Random secret for session signing |
| `OKTA_SECRET_KEY` | 64-char hex string for encrypting Okta client secrets at rest — generate with `openssl rand -hex 32` |
| `SUPER_ADMIN_EMAILS` | Comma-separated list of emails auto-promoted to super-admin on first sign-in |

Push the schema to your database:

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

Sign-in requires an org to exist. Seed the first one directly into the database:

```sh
DATABASE_URL=<value> OKTA_SECRET_KEY=<value> \
  bun run apps/api/scripts/seed-org.ts \
  "Acme Corp" acme https://acme.okta.com/oauth2/default <clientId> <clientSecret>
```

The script is idempotent — safe to re-run.

Then:

1. Sign in at `http://localhost:5173/org/<slug>/sign-in` via Okta
2. Your account is auto-promoted to super-admin if your email is in `SUPER_ADMIN_EMAILS`
3. Use `/org/<slug>/admin` to create additional organisations and configure their Okta credentials
4. Org members sign in at `/org/<slug>/sign-in` — their account is provisioned automatically on first sign-in via Okta JIT

## Member roles

| Role | Capabilities |
|------|-------------|
| Viewer | Read flags, environments, and members |
| Admin | All viewer permissions + manage flags, environments, and API keys |
| Super-admin | All admin permissions + change member roles, suspend/restore members, manage orgs |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in watch mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all test suites |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint all packages |

## Deployment

See [`infra/DEPLOY.md`](infra/DEPLOY.md) for deploying to AWS (CDK, ECS Fargate, RDS, CloudFront).

## React SDK

See [`packages/react-sdk/README.md`](packages/react-sdk/README.md) for installation and usage.
