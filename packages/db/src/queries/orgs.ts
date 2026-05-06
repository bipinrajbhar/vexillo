import { eq, and, count, desc, isNull } from 'drizzle-orm';
import { organizations, organizationMembers } from '../schema';
import type { DbClient } from '../client';

export type OrgRow = typeof organizations.$inferSelect;

export type OrgListRow = Pick<OrgRow, 'id' | 'name' | 'slug' | 'status' | 'createdAt'>;

export async function queryOrgBySlug(
  db: DbClient,
  slug: string,
): Promise<OrgRow | null> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return org ?? null;
}

export async function queryUserOrgs(
  db: DbClient,
  userId: string,
): Promise<{ id: string; name: string; slug: string }[]> {
  return db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizations.status, 'active')));
}

export async function queryUserOrgRole(
  db: DbClient,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

// ── Super-admin org operations ───────────────────────────────────────────────

export async function queryAllOrgs(db: DbClient): Promise<OrgListRow[]> {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      status: organizations.status,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .orderBy(desc(organizations.createdAt));
}

export async function insertOrg(
  db: DbClient,
  input: {
    name: string;
    slug: string;
    oktaClientId: string;
    oktaClientSecret: string;
    oktaIssuer: string;
  },
): Promise<OrgRow> {
  const [org] = await db.insert(organizations).values(input).returning();
  return org;
}

/** Single-row org fetch joined with its active member count. Returns null
 *  when the org does not exist. */
export async function queryOrgWithMemberCount(
  db: DbClient,
  slug: string,
): Promise<{ org: OrgRow; memberCount: number } | null> {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  if (!org) return null;

  const [countRow] = await db
    .select({ memberCount: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, org.id));

  return { org, memberCount: countRow?.memberCount ?? 0 };
}

export async function updateOrgFields(
  db: DbClient,
  slug: string,
  patch: Partial<Pick<OrgRow, 'name' | 'oktaClientId' | 'oktaClientSecret' | 'oktaIssuer'>>,
): Promise<OrgRow | null> {
  const [org] = await db
    .update(organizations)
    .set(patch)
    .where(eq(organizations.slug, slug))
    .returning();
  return org ?? null;
}

export async function setOrgStatus(
  db: DbClient,
  slug: string,
  status: 'active' | 'suspended',
): Promise<{ id: string; status: string } | null> {
  const [row] = await db
    .update(organizations)
    .set({ status })
    .where(eq(organizations.slug, slug))
    .returning({ id: organizations.id, status: organizations.status });
  return row ?? null;
}

export async function deleteOrgById(db: DbClient, orgId: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

/** Returns the membership row when `userId` is an active (non-removed) member
 *  of `orgId`, else null. Used by self-protection checks. */
export async function queryOrgActiveMembership(
  db: DbClient,
  orgId: string,
  userId: string,
): Promise<{ orgId: string } | null> {
  const [row] = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        isNull(organizationMembers.removedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
