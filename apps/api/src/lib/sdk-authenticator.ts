import { LRUCache } from 'lru-cache';
import { eq } from 'drizzle-orm';
import { apiKeys, environments, organizations } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey as defaultHashKey } from './api-key';

export type AuthRejectReason =
  | 'missing_token'
  | 'invalid_token'
  | 'org_suspended'
  | 'origin_forbidden';

export type AuthResult =
  | {
      ok: true;
      environmentId: string;
      orgId: string;
      // The exact value to echo as Access-Control-Allow-Origin: '*' or the
      // request origin string. Origin enforcement is folded into authenticate
      // so the route never sees raw allowedOrigins.
      allowedOriginHeader: string;
    }
  | {
      ok: false;
      status: 401 | 403;
      reason: AuthRejectReason;
    };

export interface SdkAuthenticator {
  authenticate(args: {
    authorizationHeader: string | undefined;
    originHeader: string | undefined;
  }): Promise<AuthResult>;

  /**
   * O(1) cache invalidation for an environment. Call on api-key rotation or
   * allowed-origins update. Bumps the env's generation; any cached slot or
   * in-flight refresh tagged with the previous generation is rejected on the
   * next read. The generations map retains the entry so future reads see the
   * bumped value — `forgetEnvironment` is the cleanup variant for env deletion.
   */
  evictByEnvironment(environmentId: string): void;

  /**
   * Reclaim everything tied to a deleted environment: bump the generation
   * (so any outstanding cached slots stop matching), drop slots that point
   * at this env, and remove the generations-map entry so the table doesn't
   * grow monotonically with each env created in the process's lifetime.
   * Intended only for env deletion — frequent ops should use the O(1)
   * `evictByEnvironment` instead.
   */
  forgetEnvironment(environmentId: string): void;
}

// ── Internal types ────────────────────────────────────────────────────────────

type AuthEntry = {
  environmentId: string;
  orgId: string;
  allowedOrigins: string[];
  orgStatus: string;
};

/**
 * One cache slot. `generation` is the env's generation at the time the slot
 * was written; on read we compare against the current generation to decide
 * whether to serve, refresh, or fall through. `dead = true` is set when a
 * background refresh fails — the next read forces a synchronous re-validate
 * instead of serving the stale entry indefinitely.
 */
type Slot = {
  envId: string;
  generation: number;
  entry: AuthEntry;
  storedAt: number;
  dead: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return token.length > 0 ? token : null;
}

function resolveAllowedOriginHeader(
  requestOrigin: string | undefined,
  allowedOrigins: string[],
): string | null {
  if (!requestOrigin) return '*';
  if (allowedOrigins.includes('*')) return '*';
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return null;
}

async function loadAuthRow(
  db: DbClient,
  hash: string,
): Promise<AuthEntry | null> {
  const [row] = await db
    .select({
      environmentId: apiKeys.environmentId,
      orgId: environments.orgId,
      allowedOrigins: environments.allowedOrigins,
      orgStatus: organizations.status,
    })
    .from(apiKeys)
    .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
    .innerJoin(organizations, eq(organizations.id, environments.orgId))
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  return row ?? null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1_000;

export function createSdkAuthenticator(deps: {
  db: DbClient;
  hashKey?: (token: string) => Promise<string>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): SdkAuthenticator {
  const { db } = deps;
  const hashKey = deps.hashKey ?? defaultHashKey;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = deps.now ?? (() => Date.now());

  // Token-keyed slot cache. The LRU bounds memory; staleness is owned by the
  // module via `now() - storedAt > ttlMs` so tests can advance an injected
  // clock instead of waiting for real time.
  const slots = new LRUCache<string, Slot>({ max: maxEntries });

  // Per-env generation counter. `genFor` returns 0 by default, and a slot
  // written before any eviction is also tagged with 0 — so a never-evicted env
  // matches its own slots cleanly. `evictByEnvironment` bumps;
  // `forgetEnvironment` clears.
  const generations = new Map<string, number>();
  const genFor = (envId: string): number => generations.get(envId) ?? 0;

  function isStale(slot: Slot): boolean {
    return now() - slot.storedAt > ttlMs;
  }

  function refreshInBackground(token: string, envId: string): void {
    const genAtStart = genFor(envId);
    void hashKey(token)
      .then((hash) => loadAuthRow(db, hash))
      .then((row) => {
        if (!row) return;
        // Mid-flight rotation/eviction: drop the result silently.
        if (genFor(row.environmentId) !== genAtStart) return;
        slots.set(token, {
          envId: row.environmentId,
          generation: genAtStart,
          entry: row,
          storedAt: now(),
          dead: false,
        });
      })
      .catch(() => {
        // DB blip: mark the slot dead so the next request re-validates
        // instead of silently serving the stale entry until TTL expires.
        const cur = slots.get(token);
        if (cur) cur.dead = true;
      });
  }

  async function resolveAuthEntry(token: string): Promise<AuthEntry | null> {
    const slot = slots.get(token);
    if (slot && !slot.dead && slot.generation === genFor(slot.envId)) {
      if (isStale(slot)) refreshInBackground(token, slot.envId);
      return slot.entry;
    }
    // Cold miss, generation mismatch, or dead slot — synchronous re-validate.
    const hash = await hashKey(token);
    const row = await loadAuthRow(db, hash);
    if (!row) return null;
    slots.set(token, {
      envId: row.environmentId,
      generation: genFor(row.environmentId),
      entry: row,
      storedAt: now(),
      dead: false,
    });
    return row;
  }

  return {
    async authenticate({ authorizationHeader, originHeader }) {
      const token = parseBearerToken(authorizationHeader);
      if (!token) return { ok: false, status: 401, reason: 'missing_token' };

      const entry = await resolveAuthEntry(token);
      if (!entry) return { ok: false, status: 401, reason: 'invalid_token' };

      if (entry.orgStatus === 'suspended') {
        return { ok: false, status: 403, reason: 'org_suspended' };
      }

      const allowedOriginHeader = resolveAllowedOriginHeader(
        originHeader,
        entry.allowedOrigins,
      );
      if (allowedOriginHeader === null) {
        return { ok: false, status: 403, reason: 'origin_forbidden' };
      }

      return {
        ok: true,
        environmentId: entry.environmentId,
        orgId: entry.orgId,
        allowedOriginHeader,
      };
    },

    evictByEnvironment(environmentId) {
      generations.set(environmentId, genFor(environmentId) + 1);
    },

    forgetEnvironment(environmentId) {
      // Bump first so any in-flight refresh tagged with the previous
      // generation is rejected by its post-load check.
      generations.set(environmentId, genFor(environmentId) + 1);
      // Drop slots for this env so they don't sit around taking LRU space.
      for (const [token, slot] of slots.entries()) {
        if (slot.envId === environmentId) slots.delete(token);
      }
      // Remove the map entry so the per-env generation table doesn't grow
      // monotonically across the process lifetime.
      generations.delete(environmentId);
    },
  };
}
