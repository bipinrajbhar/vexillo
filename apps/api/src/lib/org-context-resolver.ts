import type { DbClient, OrgRow } from '@vexillo/db';
import { queryOrgBySlug, queryMemberRole } from '@vexillo/db';
import { NotFoundError, ForbiddenError } from './domain-errors';

export interface ResolvedOrgContext {
  org: OrgRow;
  role: string;
}

export interface OrgContextResolver {
  resolve(slug: string, userId: string): Promise<ResolvedOrgContext>;
  /**
   * No-op. Retained so FlagOps (#176) and existing call sites keep compiling
   * against `Pick<OrgContextResolver, 'invalidate'>`. The resolver is stateless;
   * the DB is the single source of truth.
   */
  invalidate(orgId: string, userId: string): void;
}

export function createOrgContextResolver(opts: { db: DbClient }): OrgContextResolver {
  const { db } = opts;
  return {
    async resolve(slug, userId) {
      const org = await queryOrgBySlug(db, slug);
      if (!org) throw new NotFoundError('Organization not found');
      if (org.status === 'suspended') throw new ForbiddenError('Organization suspended');

      const role = await queryMemberRole(db, org.id, userId);
      if (!role) throw new ForbiddenError('Not a member of this organization');

      return { org, role };
    },
    invalidate() {
      /* stateless: nothing to do */
    },
  };
}
