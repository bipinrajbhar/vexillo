# @vexillo/db

Drizzle ORM schema and database client for Vexillo. Shared by `apps/api` and `apps/web`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://user:pass@localhost:5432/vexillo` |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm db:push` | Push the current schema directly to the database (dev) |
| `pnpm db:generate` | Generate a new migration file from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Open Drizzle Studio at `https://local.drizzle.studio` |

Run these from the repo root with `pnpm --filter @vexillo/db <script>`.

## Schema overview

**Organisations & access**

| Table | Description |
|-------|-------------|
| `organizations` | Tenants — name, slug, Okta OAuth config (client secret stored AES-256-GCM encrypted), status (`active` / `suspended`) |
| `organization_members` | Per-org RBAC — links users to orgs with a role (`admin` / `viewer`); `removedAt` for soft-delete |
| `invites` | Pending org invitations — `tokenHash`, role, expiry, optional `acceptedAt` |

**Auth (BetterAuth managed)**

| Table | Description |
|-------|-------------|
| `user` | User accounts — includes `role` and `isSuperAdmin` fields |
| `session` | Active sessions |
| `account` | OAuth provider accounts |
| `verification` | Verification tokens |

**Feature flags**

| Table | Description |
|-------|-------------|
| `environments` | Deployment environments per org (e.g. production, staging) |
| `flags` | Feature flag definitions per org |
| `flag_states` | Enabled/disabled state per flag per environment, with an optional `allowedCountries` array for geo-targeting |
| `api_keys` | Hashed API keys for SDK access, scoped to an environment |

**Audit**

| Table | Description |
|-------|-------------|
| `audit_logs` | Immutable audit trail of all dashboard mutations — actor, action, target, metadata |

## Usage

```ts
import { createDbClient } from '@vexillo/db';

const db = createDbClient(process.env.DATABASE_URL, { max: 10 });
```

The client is a typed Drizzle instance. Import table schemas directly:

```ts
import { organizations, flags, flagStates } from '@vexillo/db';
```
