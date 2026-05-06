import { eq } from 'drizzle-orm';
import { apiKeys, environments, organizations } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey as defaultHashKey } from './api-key';
import { createAuthCache, type AuthCache, type AuthEntry } from './auth-cache';

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

  evictByEnvironment(environmentId: string): void;
}

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

export function createSdkAuthenticator(deps: {
  db: DbClient;
  authCache?: AuthCache;
  hashKey?: (token: string) => Promise<string>;
}): SdkAuthenticator {
  const { db } = deps;
  const cache = deps.authCache ?? createAuthCache();
  const hashKey = deps.hashKey ?? defaultHashKey;

  // Token-keyed cache so warm hits skip the SHA-256. Stale entries are served
  // synchronously and a background refresh updates the slot — TTL expiry
  // never causes a latency spike on the hot path.
  async function resolveAuthEntry(token: string): Promise<AuthEntry | null> {
    const cached = cache.get(token);
    if (cached) {
      if (cache.isStale(token)) {
        hashKey(token)
          .then((hash) => loadAuthRow(db, hash))
          .then((row) => {
            if (row) cache.set(token, row);
          })
          .catch(() => {});
      }
      return cached;
    }
    const hash = await hashKey(token);
    const row = await loadAuthRow(db, hash);
    if (!row) return null;
    cache.set(token, row);
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
      cache.deleteByEnvironmentId(environmentId);
    },
  };
}
