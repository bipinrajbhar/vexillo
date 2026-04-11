# @vexillo/web

Vite + React dashboard for managing feature flags, environments, org members, and API keys.

## Prerequisites

- [Node.js](https://nodejs.org) ≥ 20
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
| `/sign-in` | Public | Platform sign-in (Okta OAuth) |
| `/org/:slug/sign-in` | Public | Org-specific sign-in (org's own Okta) |
| `/org/:slug/flags` | Org member | Feature flags list |
| `/org/:slug/flags/:key` | Org member | Flag detail + per-environment toggles |
| `/org/:slug/environments` | Org member | Environments + API keys |
| `/org/:slug/members` | Org member | Members + invite management |
| `/invite` | Authenticated | Accept an org invite via token |
| `/admin` | Super-admin | Org list |
| `/admin/orgs/new` | Super-admin | Create an org |
| `/admin/orgs/:slug` | Super-admin | Org detail — edit Okta config, suspend/activate |

Authenticated users are redirected away from `/` and `/org/:slug/sign-in` to their dashboard automatically.

## Tech stack

- [Vite](https://vitejs.dev) + [React 19](https://react.dev)
- [TanStack Router](https://tanstack.com/router) — file-based routing with type-safe `beforeLoad` guards
- [Tailwind CSS v4](https://tailwindcss.com) + [Base UI](https://base-ui.com)
- [BetterAuth](https://better-auth.com) client for session management
