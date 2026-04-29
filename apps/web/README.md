# @vexillo/web

Vite + React dashboard for managing feature flags, environments, org members, and API keys.

## Prerequisites

- [pnpm](https://pnpm.io) ≥ 10
- The API (`apps/api`) running locally

## Running locally

The web app proxies all `/api/*` requests to the API server (configured in `vite.config.ts`), so you only need the API running — no separate env file required for local development.

Start everything from the repo root:

```sh
pnpm dev
```

Or start just the web app:

```sh
pnpm --filter @vexillo/web dev
```

Dashboard runs at `http://localhost:5173`.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Vite dev server |
| `pnpm build` | Production build to `dist/` |
| `pnpm preview` | Preview the production build |
| `pnpm typecheck` | TypeScript type check |
| `pnpm lint` | ESLint |

## Routes

| Path | Access | Description |
|------|--------|-------------|
| `/` | Public | Workspace finder — enter an org slug to navigate to it |
| `/org/:slug/sign-in` | Public | Org-specific sign-in via Okta |
| `/org/:slug/flags` | Org member | Feature flags list with per-environment status and geo-targeting rules |
| `/org/:slug/environments` | Org member | Environments, API key hints, and allowed origins |
| `/org/:slug/members` | Org member | Members list (read-only for viewers, managed by admins) |
| `/org/:slug/admin` | Super-admin | Org list |
| `/org/:slug/admin/orgs/new` | Super-admin | Create an org |
| `/org/:slug/admin/orgs/:orgSlug` | Super-admin | Org detail — edit Okta config, suspend/activate; delete is hidden when the super-admin is an active member of that org |

## Tech stack

- [Vite](https://vitejs.dev) + [React 19](https://react.dev)
- [TanStack Router](https://tanstack.com/router) — type-safe routing with `beforeLoad` guards
- [TanStack Query](https://tanstack.com/query) — server state, caching, and mutations
- [TanStack Table](https://tanstack.com/table) — headless data tables
- [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) components
- [BetterAuth](https://better-auth.com) client for session management
