import { eq, and } from 'drizzle-orm';
import { organizations, organizationMembers } from '../schema';
import type { DbClient } from '../client';

export async function queryOrgBySlug(
  db: DbClient,
  slug: string,
): Promise<typeof organizations.$inferSelect | null> {
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
