import { LRUCache } from 'lru-cache';
import type { DbClient } from '@vexillo/db';
import { queryOrgBySlug, queryMemberRole } from '@vexillo/db';
import { NotFoundError, ForbiddenError } from '../services/dashboard-service';
import type { OrgRow } from '../services/dashboard-service';

export interface ResolvedOrgContext {
  org: OrgRow;
  role: string; // always present — resolver throws before returning if role is absent
}

export interface OrgContextResolver {
  resolve(slug: string, userId: string): Promise<ResolvedOrgContext>;
  invalidate(orgId: string, userId: string): void;
}

export function createOrgContextResolver(opts: {
  db: DbClient;
  ttlMs?: number;
  max?: number;
}): OrgContextResolver {
  const { db, ttlMs = 30_000, max = 200 } = opts;
  // Keyed by `slug:userId` so the auth-middleware lookup is one hash op. The
  // cached value carries the full org row, so `invalidate(orgId, userId)`
  // walks the cache to find matching entries — bounded by `max` (default 200)
  // and called only on membership mutations, so the linear scan is cheap.
  const cache = new LRUCache<string, ResolvedOrgContext>({ max, ttl: ttlMs });

  return {
    async resolve(slug, userId) {
      const key = `${slug}:${userId}`;
      const hit = cache.get(key);
      if (hit) return hit;

      const org = await queryOrgBySlug(db, slug);
      if (!org) throw new NotFoundError('Organization not found');
      if (org.status === 'suspended') throw new ForbiddenError('Organization suspended');

      const role = await queryMemberRole(db, org.id, userId);
      if (!role) throw new ForbiddenError('Not a member of this organization');

      const ctx: ResolvedOrgContext = { org, role };
      cache.set(key, ctx);
      return ctx;
    },

    invalidate(orgId, userId) {
      const userSuffix = `:${userId}`;
      for (const [key, value] of cache.entries()) {
        if (value.org.id === orgId && key.endsWith(userSuffix)) {
          cache.delete(key);
        }
      }
    },
  };
}
