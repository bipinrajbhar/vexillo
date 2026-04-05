# Plan: Security — Authentication, CORS Allowlist & Security Headers

> Source PRD: https://github.com/bipinrajbhar/vexillo/issues/3

## Architectural decisions

- **Auth**: Better Auth with Okta OAuth/OIDC provider. No passwords or magic links managed by the app. Users sign in via their organisation's Okta account.
- **Session**: Better Auth session cookies, server-side validated on every protected request.
- **Roles**: Two roles — `admin` (full access) and `viewer` (read-only). Stored on the Better Auth user record. First user to sign in becomes admin; all others default to viewer.
- **Routes**: `/sign-in` and the OAuth callback route are the only public routes. All dashboard routes require an authenticated session via Next.js middleware.
- **API auth — two paths**:
  - SDK: `Authorization: Bearer <api-key>` validated against hashed keys in `apiKeys` table. No user session required.
  - Dashboard: Better Auth session cookie. Required for all write endpoints.
- **CORS**: Dynamic per-environment. `allowed_origins text[]` column on the `environments` table. SDK requests checked against this list at runtime.
- **Schema additions**:
  - `environments.allowed_origins` — `text[]`, default `{}`
  - Better Auth tables: `users`, `sessions`, `accounts` (no verification tokens — Okta handles identity)
- **Key models**: `User` (id, email, role, createdAt), `Session` (managed by Better Auth)
- **Okta config**: Client ID, client secret, and issuer URL configured via environment variables. Okta application must be registered in the Okta admin console before deployment.

---

## Phase 1: Okta SSO Authentication

**User stories**: 1, 2, 3, 4, 5, 18

### What to build

Install and configure Better Auth with the Okta OAuth/OIDC provider plugin. Add Better Auth's required database tables (users, sessions, accounts) via a Drizzle migration. Build a `/sign-in` page with a "Sign in with Okta" button that initiates the OAuth redirect. After a successful Okta login, the OAuth callback establishes a Better Auth session and redirects the user to the dashboard. Add a sign-out button to the dashboard layout. Sessions expire after a configurable period of inactivity.

This slice does not yet protect any routes — the goal is a working end-to-end auth flow that can be demoed in isolation.

### Acceptance criteria

- [ ] A user can visit `/sign-in` without being redirected
- [ ] Clicking "Sign in with Okta" redirects to the configured Okta login page
- [ ] After successful Okta authentication, the user is redirected back and a session is established
- [ ] The user lands on the dashboard after sign-in
- [ ] A signed-in user can sign out; subsequent page loads redirect back to `/sign-in`
- [ ] Sessions expire after inactivity (configurable duration)
- [ ] Better Auth tables exist in the database (migration applied)
- [ ] Okta client ID, client secret, and issuer URL are read from environment variables

---

## Phase 2: Dashboard & API Route Protection

**User stories**: 1, 12, 20, 21, 22

### What to build

Add a Next.js middleware that intercepts every request to dashboard routes and redirects unauthenticated users to `/sign-in`. Add session checks to all write API endpoints (flag create/update/delete/toggle, environment create, key rotation) — unauthenticated requests receive a 401. The SDK bearer token path on `GET /api/flags` is left unchanged. A new `PATCH /api/environments/[id]` endpoint (needed for the CORS allowlist in Phase 4) is also gated behind session auth.

### Acceptance criteria

- [ ] Visiting any dashboard route without a session redirects to `/sign-in`
- [ ] After sign-in, the user is redirected back to the originally requested route
- [ ] `POST /api/flags` without a session returns 401
- [ ] `PATCH /api/flags/[key]` without a session returns 401
- [ ] `DELETE /api/flags/[key]` without a session returns 401
- [ ] `PUT /api/flags/[key]/toggle` without a session returns 401
- [ ] `POST /api/environments` without a session returns 401
- [ ] `POST /api/environments/[id]/rotate-key` without a session returns 401
- [ ] `GET /api/flags` with a valid Bearer API key still returns flag data (SDK path unaffected)
- [ ] `GET /api/flags` without any auth header returns 401 (no longer open)

---

## Phase 3: RBAC — Roles & Member Management

**User stories**: 6, 7, 8, 9, 10, 11, 20

### What to build

Add a `role` field (`admin` | `viewer`) to the Better Auth user record. The first user to complete sign-in is automatically assigned the `admin` role; all subsequent users are assigned `viewer` by default. Build a Members settings page where admins can invite users by email, change a member's role, and remove members. All write API endpoints add a role check after the session check — non-admins receive a 403. The dashboard UI conditionally hides or disables write controls for viewers, but the server check is the source of truth.

### Acceptance criteria

- [x] First user to sign in has role `admin`; all others default to `viewer`
- [x] Any user who authenticates via Okta for the first time is automatically provisioned as a Viewer
- [x] An admin can change another member's role between `admin` and `viewer`
- [x] An admin can remove a member; that member's session is invalidated
- [x] A viewer visiting the dashboard cannot see create/edit/delete/toggle controls
- [x] A viewer calling any write API endpoint receives 403
- [x] An admin calling write API endpoints succeeds (2xx)
- [x] A viewer cannot access the Members settings page

---

## Phase 4: Per-Environment CORS Allowlist

**User stories**: 13, 14, 15, 16, 17

### What to build

Add an `allowed_origins text[]` column (default `{}`) to the `environments` table via a Drizzle migration. On the Environments page, add an "Allowed Origins" section per environment where admins can add and remove origins (e.g. `https://myapp.com`). A wildcard `*` entry opts the environment into open access. When the SDK calls `GET /api/flags` with a valid API key, the server reads the `Origin` header and checks it against the environment's `allowed_origins` list — matching origins get the appropriate `Access-Control-Allow-Origin` response header, non-matching origins receive a 403. The static `Access-Control-Allow-Origin: *` constant is removed.

### Acceptance criteria

- [x] `environments` table has an `allowed_origins` column (migration applied)
- [x] An admin can add an origin to an environment's allowlist via the UI
- [x] An admin can remove an origin from an environment's allowlist via the UI
- [x] The allowlist is visible on the environment detail UI
- [x] An SDK request from an origin on the allowlist receives the correct CORS headers and flag data
- [x] An SDK request from an origin NOT on the allowlist receives a 403
- [x] An environment with `*` in its allowlist accepts requests from any origin
- [x] An environment with an empty allowlist rejects all cross-origin SDK requests

---

## Phase 5: Security Headers

**User stories**: 18

### What to build

Add HTTP security headers to all responses via the Next.js `headers()` configuration. Audit the app's actual resource dependencies (fonts, external scripts, etc.) before finalising the CSP to avoid breaking the UI.

Headers to add:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy` — `default-src 'self'` plus explicit allowances for any external resources the app loads

### Acceptance criteria

- [x] All dashboard page responses include `X-Frame-Options: DENY`
- [x] All responses include `X-Content-Type-Options: nosniff`
- [x] All responses include `Strict-Transport-Security` with at least 1-year max-age
- [x] All responses include `Referrer-Policy: strict-origin-when-cross-origin`
- [x] All responses include a `Content-Security-Policy` header
- [ ] The dashboard UI renders without any CSP violations in the browser console
- [x] The SDK endpoint (`/api/flags`) is not broken by the headers (CORS headers still applied correctly)
