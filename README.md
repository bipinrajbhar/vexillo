# Vexillo

Self-hosted feature flag service. Manage flags per environment and organisation, with a React SDK for consumption — including real-time streaming so flag changes reach clients instantly.

## Packages

| Package | Description |
|---------|-------------|
| `apps/api` | Hono API (Bun runtime) — auth, dashboard, SDK, and super-admin endpoints; Okta JIT member provisioning. Interactive docs at `/api/docs` |
| `apps/web` | Vite + React dashboard — org management, flags, environments, and members |
| `apps/demo` | Vite + React reference app for the React SDK — wired in `mode: "stream"`, useful for local end-to-end testing |
| `packages/db` | Drizzle ORM schema + PostgreSQL migrations |
| `packages/react-sdk` | `@vexillo/react-sdk` — React bindings for consuming flags in any app |

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- [pnpm](https://pnpm.io) ≥ 10
- PostgreSQL ≥ 14
- An [Okta](https://developer.okta.com) account (one app per organisation)
- Redis _(optional)_ — required only for cross-container SSE fan-out in multi-instance deployments

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
| `REDIS_URL` | _(Optional)_ Redis connection string — enables SSE fan-out across multiple API containers |
| `INTERNAL_SECRET` | _(Optional)_ Shared secret for cross-region `/internal/flag-change` calls — must match in all regions. Generate with `openssl rand -hex 32`. If unset a random value is generated at startup, locking the endpoint. |
| `SECONDARY_REGION_URLS` | _(Optional)_ Comma-separated ALB base URLs of secondary regions, e.g. `https://eu-alb.example.com`. Set only on the primary region. |

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
| Admin | All viewer permissions + manage flags, environments, API keys, and change member roles (except super-admin roles) |
| Super-admin | All admin permissions + suspend/restore members, manage orgs |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in watch mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all test suites |
| `pnpm typecheck` | Type-check all packages |
| `pnpm lint` | Lint all packages |

## Deployment

Vexillo is built and promoted by the rhapsody Jenkins pipeline
([`Jenkinsfile`](Jenkinsfile)) and deployed as a Kubernetes service
in EKS via the per-environment Helm values under [`k8s/`](k8s/). On the
`develop` branch, builds are promoted to **DEV → QA → STAGING**.

The Hono API and the Vite SPA ship in a single container image
([`Dockerfile`](Dockerfile)); the API serves the built SPA for non-`/api/*`
paths. When the SPA is later moved to S3 + Akamai/CloudFront, set
`SERVE_SPA=false` and the same image becomes API-only with no code change.

PostgreSQL is provisioned as a managed RDS instance outside K8s — see
[`infra/README.md`](infra/README.md) for the RDS, Vault, and SPA-hosting
plan.

## React SDK

See [`packages/react-sdk/README.md`](packages/react-sdk/README.md) for installation and usage.
