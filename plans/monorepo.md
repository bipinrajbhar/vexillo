# Plan: Monorepo Conversion + @togglr/sdk

> Source PRD: https://github.com/bipinrajbhar/togglr/issues/2

## Architectural decisions

- **Workspaces**: `apps/*` and `packages/*` declared in `pnpm-workspace.yaml`
- **Orchestration**: Turborepo pipeline tasks — `build`, `dev`, `lint`; SDK must build before web app
- **Package scope**: `@togglr/*` (e.g. `@togglr/web`, `@togglr/sdk`)
- **SDK subpath export**: `@togglr/sdk/react` via `package.json` `exports` field
- **SDK build output**: ESM + CJS bundles + `.d.ts` type definitions via `tsup`
- **SDK API contract**: `TogglrProvider` accepts `apiKey: string`, `environment: string`, `fallbacks?: Record<string, boolean>`; `useFlag(key: string): boolean`
- **SDK flag fetching**: single `fetch` on mount against existing `GET /api/flags`; result cached in React context for provider lifetime
- **SDK error handling**: throws on any non-2xx response or network failure; consumer wraps in error boundary
- **SSR safety**: no `window`/`document` usage; initial render returns fallback values; flags populate after client hydration
- **Publishing**: `@togglr/sdk` published to GitHub Packages via `publishConfig`; triggered by version tag in GitHub Actions

---

## Phase 1: Monorepo Foundation

**User stories**: 1, 2, 3, 4, 5, 20

### What to build

Restructure the repository so the existing Next.js app lives under `apps/web` and Turborepo + pnpm workspaces orchestrate the root. After this phase, every existing script (`dev`, `build`, `lint`, `db:*`) must work both from inside `apps/web` and from the root via Turborepo. No application logic changes.

### Acceptance criteria

- [ ] `pnpm-workspace.yaml` declares `apps/*` and `packages/*`
- [ ] Root `package.json` is private, contains `turbo` as a dev dependency, and has `dev`, `build`, and `lint` scripts that delegate to Turborepo
- [ ] `turbo.json` defines a pipeline with correct task dependencies (`build` depends on upstream `build`)
- [ ] All existing Next.js app files live under `apps/web/` with an updated package name of `@togglr/web`
- [ ] `pnpm install` from the root installs all dependencies successfully
- [ ] `pnpm dev` from the root starts the web app with no errors
- [ ] `pnpm build` from the root produces a successful Next.js build
- [ ] All `db:*` scripts still work from within `apps/web`
- [ ] `.env.local` and `.env.local.example` live under `apps/web/`
- [ ] No application behaviour in `apps/web` is changed

---

## Phase 2: SDK Package Shell

**User stories**: 6, 7, 17

### What to build

Scaffold `packages/sdk` as a buildable, publishable TypeScript package under the `@togglr/sdk` name. Wire up `tsup` to produce ESM + CJS output and type definitions. Configure the `./react` subpath export in `package.json`. The implementation is empty stubs — the goal is a package that builds cleanly, has correct export paths, and is importable from a consuming project.

### Acceptance criteria

- [ ] `packages/sdk/package.json` name is `@togglr/sdk`, marked private until publishing is configured
- [ ] `exports` field exposes `"."` and `"./react"` subpaths pointing to the correct build artifacts
- [ ] `tsup` build produces ESM and CJS bundles plus `.d.ts` files for both subpaths
- [ ] `pnpm build` from the root builds the SDK package without errors
- [ ] Importing `@togglr/sdk/react` in a TypeScript project resolves types correctly
- [ ] SDK `tsconfig.json` extends from a root base config
- [ ] Turborepo pipeline includes the SDK `build` task

---

## Phase 3: SDK React Bindings

**User stories**: 8, 9, 10, 11, 12, 13, 14, 15, 16

### What to build

Implement the full `@togglr/sdk/react` surface: `TogglrProvider` and `useFlag`. The provider fetches all flags for the given environment from the Togglr REST API on mount using the provided `apiKey`, stores the result in React context, and throws a descriptive error on any API failure. `useFlag` reads from that context and returns the boolean value for a key, falling back to the `fallbacks` map then `false` for unknown keys. Everything must be SSR-safe: no `window`/`document` references, initial render uses fallback values, no hydration mismatches.

### Acceptance criteria

- [ ] `<TogglrProvider apiKey environment>` fetches all flags on client mount and stores them in context
- [ ] `<TogglrProvider fallbacks={...}>` is optional; missing keys default to `false`
- [ ] On initial render (SSR / before fetch completes), `useFlag` returns the fallback value for the key, or `false`
- [ ] After the fetch resolves, `useFlag` returns the live flag value from the API
- [ ] Flags are fetched exactly once per provider mount; no polling
- [ ] On network failure or non-2xx API response, the provider throws an error with a descriptive message
- [ ] No reference to `window`, `document`, or any browser-only global anywhere in the SDK source
- [ ] Rendering the provider in a Node.js environment (no DOM) does not throw
- [ ] `useFlag` called outside a `TogglrProvider` throws a clear error
- [ ] All exports are fully typed; consumers get autocomplete on `TogglrProvider` props

---

## Phase 4: SDK Tests

**User stories**: Testing decisions from PRD

### What to build

Add a test suite for `packages/sdk` covering external behaviour only — no testing of internal state or private implementation details. Tests mock `fetch` to avoid real network calls. Three categories: `useFlag` unit tests, `TogglrProvider` integration tests, and an SSR smoke test.

### Acceptance criteria

- [ ] Test runner is configured and runnable via `pnpm test` inside `packages/sdk` and from the root via Turborepo
- [ ] `useFlag` returns the correct boolean for a flag that exists in context
- [ ] `useFlag` returns `false` for a flag key not present in the fetched set and not in fallbacks
- [ ] `useFlag` returns the fallback value for a key present in `fallbacks` but not in the fetched set
- [ ] `TogglrProvider` calls `fetch` exactly once on mount with the correct `apiKey` and `environment`
- [ ] `TogglrProvider` populates context so subsequent `useFlag` calls return the fetched values
- [ ] `TogglrProvider` throws when `fetch` rejects (network error)
- [ ] `TogglrProvider` throws when the API returns a non-2xx status
- [ ] SSR smoke test: rendering the provider tree in a Node environment (no DOM globals) does not throw
- [ ] All tests pass in CI

---

## Phase 5: Publishing Pipeline

**User stories**: 18, 19

### What to build

Configure `@togglr/sdk` for publication to GitHub Packages and add a GitHub Actions workflow that publishes the package automatically when a version tag matching `sdk@*` is pushed. Remove the `private` flag from the SDK's `package.json` and set `publishConfig` to point at the GitHub Packages registry.

### Acceptance criteria

- [ ] `packages/sdk/package.json` has `publishConfig.registry` set to `https://npm.pkg.github.com`
- [ ] `packages/sdk/package.json` is no longer marked `private`
- [ ] A GitHub Actions workflow triggers on tags matching `sdk@*`
- [ ] The workflow installs dependencies with pnpm, builds the SDK, and runs `pnpm --filter @togglr/sdk publish`
- [ ] The workflow uses a `NODE_AUTH_TOKEN` secret scoped to GitHub Packages
- [ ] A published version of `@togglr/sdk` is installable via `npm install @togglr/sdk --registry=https://npm.pkg.github.com`
