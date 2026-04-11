# Plan: AWS Migration (Next.js → Vite + Hono + AWS)

> Source PRD: [bipinrajbhar/vexillo#5](https://github.com/bipinrajbhar/vexillo/issues/5)

## Architectural Decisions

Durable decisions that apply across all phases:

- **Entry point:** Single CloudFront distribution — `/api/*` → App Runner, `/*` → S3. No custom domain required; use default `*.cloudfront.net` URL.
- **Routes:**
  - `GET /api/sdk/flags` — public flag fetch (API key auth, CORS `*`, 30s CDN cache)
  - `GET /api/sdk/flags/stream` — SSE stream (stubbed, keepalive every 25s)
  - `GET|POST /api/dashboard/flags` — flag management (session auth)
  - `PATCH /api/dashboard/flags/:key` — update flag
  - `POST /api/dashboard/flags/:key/toggle` — toggle flag per environment
  - `GET|POST /api/dashboard/environments` — environment management
  - `POST /api/dashboard/environments/:id/rotate-key` — rotate API key
  - `GET|POST|DELETE /api/dashboard/members` — member management
  - `* /api/auth/*` — BetterAuth (Okta OAuth, session)
- **Schema (unchanged):** `user`, `session`, `account`, `verification`, `environments`, `flags`, `flag_states`, `api_keys`
- **Key models:** `environments` (name, slug, allowedOrigins), `flags` (name, key, description), `flag_states` (flagId + environmentId composite PK, enabled boolean), `api_keys` (environmentId, keyHash, keyHint)
- **Auth:** BetterAuth + Okta OAuth, Hono adapter, session cookies scoped to CloudFront domain
- **Runtime:** Hono on Bun (`apps/api`), Vite + TanStack Router (`apps/web`), pnpm + Turbo (monorepo tooling)
- **Secrets:** AWS SSM Parameter Store — `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`, `OKTA_ISSUER`

---

## Phase 1: AWS Infrastructure Skeleton

**User stories:** 1, 8, 9, 12, 13, 20

### What to build

Provision the full AWS infrastructure using CDK in a new `infra/` package — VPC, RDS Postgres, ECR repository, App Runner service (with a placeholder image), App Runner VPC connector (for RDS access), S3 bucket (private, OAC), CloudFront distribution with two origins (S3 default, App Runner for `/api/*`), and SSM Parameter Store entries for all secrets. The CloudFront URL should be reachable and return a 200 from the App Runner health check and a 403/404 from S3 (no files yet).

### Acceptance criteria

- [ ] `cdk deploy` runs without errors from `infra/`
- [ ] CloudFront distribution is live with a `*.cloudfront.net` URL
- [ ] App Runner service is running a placeholder image and returns 200 on `/health`
- [ ] `GET <cloudfront-url>/api/health` proxies to App Runner and returns 200
- [ ] RDS Postgres is reachable from App Runner (validated via a DB ping in the health endpoint)
- [ ] SSM Parameter Store entries exist for all required secrets
- [ ] All AWS resources are defined in CDK — nothing created manually in the console

---

## Phase 2: Shared Database Package

**User stories:** 6

### What to build

Extract the Drizzle schema from `apps/web` into a new `packages/db` workspace package. Replace the `@neondatabase/serverless` HTTP driver with a standard persistent TCP Postgres driver. Export the schema definitions, a Drizzle client factory, and all inferred TypeScript types. Run Drizzle migrations against RDS to confirm schema applies cleanly. Both `apps/api` and `apps/web` will import from this package going forward.

### Acceptance criteria

- [ ] `packages/db` is a pnpm workspace package importable by other packages
- [ ] All schema tables (`user`, `session`, `account`, `verification`, `environments`, `flags`, `flag_states`, `api_keys`) are exported from `packages/db`
- [ ] `drizzle-kit migrate` runs successfully against RDS with no errors
- [ ] TypeScript types for all schema tables are exported and usable in consuming packages
- [ ] `apps/web` (still Next.js at this point) imports schema from `packages/db` without breakage

---

## Phase 3: Hono API — SDK Route

**User stories:** 2, 7, 16, 17, 18, 24, 25

### What to build

Bootstrap `apps/api` as a new Hono + Bun workspace package. Implement the `/api/sdk/*` router: `GET /api/sdk/flags` authenticates via bearer API key, looks up the environment, and returns all flag states as `{ flags: [{ key, enabled }] }`. Apply CORS `Access-Control-Allow-Origin: *` and `Cache-Control: s-maxage=30, stale-while-revalidate=60` headers. Stub `/api/sdk/flags/stream` as an SSE endpoint that emits only keepalive comments (``: keepalive``) every 25 seconds. Add a `GET /health` endpoint. Write a Dockerfile using `oven/bun`. Deploy the image to ECR and update the App Runner service to use it.

### Acceptance criteria

- [ ] `GET <cloudfront-url>/api/sdk/flags` with a valid `Authorization: Bearer <key>` returns `{ flags: [...] }` with correct enabled states
- [ ] Request with an invalid API key returns 401
- [ ] Request for a disabled environment returns 403
- [ ] Response includes `Access-Control-Allow-Origin: *` header
- [ ] Response includes `Cache-Control: s-maxage=30, stale-while-revalidate=60` header
- [ ] `GET /api/sdk/flags/stream` opens an SSE connection and emits a keepalive comment within 25 seconds
- [ ] Docker image builds from `oven/bun` base image and runs on Bun
- [ ] App Runner serves the Hono API behind CloudFront `/api/*`

---

## Phase 4: Hono API — Dashboard Routes + Auth

**User stories:** 2, 7, 14, 15

### What to build

Add BetterAuth to `apps/api` using the official Hono adapter, configured with the Okta provider and session cookies scoped to the CloudFront domain. Implement the full `/api/dashboard/*` router behind a session auth middleware: flags CRUD (list, create, update, toggle per environment), environments CRUD (list, create, delete, rotate API key), and members management (list, invite, remove). Admin-only mutations must reject viewer sessions with 403.

### Acceptance criteria

- [ ] `GET /api/auth/okta` initiates the Okta OAuth flow
- [ ] After Okta callback, a session cookie is set on the CloudFront domain
- [ ] `GET /api/dashboard/flags` with a valid session returns all flags
- [ ] Unauthenticated request to any `/api/dashboard/*` route returns 401
- [ ] Viewer session attempting a mutation (create flag, toggle, etc.) returns 403
- [ ] Flag toggle correctly updates `flag_states` for the specified environment
- [ ] API key rotation generates a new key, hashes it, updates the DB, and returns the new raw key once
- [ ] Environment deletion cascades to `flag_states` and `api_keys`

---

## Phase 5: Vite SPA — Auth Shell

**User stories:** 3, 4, 15

### What to build

Bootstrap `apps/web` as a Vite + React + TanStack Router workspace package, replacing the Next.js app. Set up file-based routing with TanStack Router. Implement the sign-in page that initiates the Okta OAuth flow via `/api/auth/okta`. Implement an authenticated layout shell (nav, sidebar) that fetches the current session from `/api/auth/session`. Unauthenticated users are redirected to sign-in. Deploy the Vite build to S3, serve via CloudFront.

### Acceptance criteria

- [ ] `<cloudfront-url>/` loads the Vite SPA (served from S3)
- [ ] Unauthenticated visit redirects to `/sign-in`
- [ ] Sign-in page renders and "Sign in with Okta" initiates the OAuth flow
- [ ] After successful Okta login, user lands on the authenticated shell
- [ ] Session is persisted across page refreshes (cookie-based)
- [ ] TanStack Router handles 404s and SPA deep-link navigation correctly (CloudFront 404 → `index.html`)

---

## Phase 6: Vite SPA — Flags

**User stories:** 3, 4

### What to build

Implement the flags list page and flag detail page inside the authenticated shell. The list page fetches from `GET /api/dashboard/flags` and displays all flags with their per-environment states. The detail page allows toggling a flag per environment via `POST /api/dashboard/flags/:key/toggle`. Admins see create and edit controls; viewers see read-only state.

### Acceptance criteria

- [ ] Flags list page renders all flags with correct enabled/disabled state per environment
- [ ] Admin can create a new flag via the UI
- [ ] Toggling a flag in an environment updates its state immediately in the UI and persists via the API
- [ ] Viewer role sees flags but toggle controls are disabled or hidden
- [ ] Flag detail page is reachable via TanStack Router and reflects current flag state

---

## Phase 7: Vite SPA — Environments + Members

**User stories:** 3, 4

### What to build

Implement the environments management page and the members management page inside the authenticated shell. Environments page: list environments, create new environment, rotate API key (shows new key once), delete environment (with confirmation). Members page: list members with roles, invite by email, remove member. All destructive actions require admin role.

### Acceptance criteria

- [ ] Environments page lists all environments with their slugs and API key hints
- [ ] Admin can create a new environment; it appears immediately in the list
- [ ] API key rotation displays the new raw key once and then shows only the hint
- [ ] Environment deletion requires confirmation and removes it from the list
- [ ] Members page lists all members with their roles
- [ ] Admin can invite a new member by email
- [ ] Admin can remove a member
- [ ] Viewer cannot access admin controls (hidden or returns 403)

---

## Phase 8: SDK v4.0.0

**User stories:** 16, 17, 18, 19

### What to build

Update `packages/react-sdk` to call `${baseUrl}/api/sdk/flags` instead of `${baseUrl}/api/flags`. This is the only breaking change. Bump the package version to 4.0.0, update the changelog, and publish to npm. Coordinate the publish timing with the Phase 3 API deploy so both sides of the contract change together.

### Acceptance criteria

- [ ] `fetchFlags(baseUrl, apiKey)` calls `${baseUrl}/api/sdk/flags`
- [ ] All existing SDK behavior (override priority, fallback resolution, subscriber notification) is unchanged
- [ ] Package version is `4.0.0` in `package.json`
- [ ] SDK is published to npm as `@vexillo/react-sdk@4.0.0`
- [ ] SDK works end-to-end against a running Vexillo instance via CloudFront URL as `baseUrl`

---

## Phase 9: CI/CD Pipeline

**User stories:** 10, 11, 22, 23

### What to build

Replace the existing GitHub Actions workflows with a single `deploy.yml` workflow triggered on push to `main`. Steps in order: (1) run `drizzle-kit migrate` against RDS, (2) build the Docker image and push to ECR, (3) trigger App Runner deployment and wait for it to become healthy, (4) build the Vite SPA, (5) sync `dist/` to S3, (6) issue a CloudFront invalidation for `/*`. All secrets pulled from GitHub Actions secrets (mirroring SSM values).

### Acceptance criteria

- [ ] Push to `main` triggers the full deployment pipeline automatically
- [ ] Migrations run before the new API image is deployed
- [ ] A failed migration aborts the pipeline — the old API version stays running
- [ ] App Runner deployment completes before S3 upload begins
- [ ] After pipeline completes, the CloudFront URL serves the latest frontend and API
- [ ] Pipeline fails loudly (non-zero exit) if any step errors — no silent failures
