import { eq, and, asc } from 'drizzle-orm';
import { organizationMembers, authUser } from '../schema';
import type { DbClient } from '../client';

export async function queryUserIsSuperAdmin(db: DbClient, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isSuperAdmin: authUser.isSuperAdmin })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);
  return row?.isSuperAdmin ?? false;
}

export type MemberRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
};

export async function queryOrgMembers(db: DbClient, orgId: string): Promise<MemberRow[]> {
  return db
    .select({
      id: authUser.id,
      name: authUser.name,
      email: authUser.email,
      role: organizationMembers.role,
      createdAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(authUser, eq(authUser.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(asc(organizationMembers.createdAt));
}

export async function countOrgAdmins(db: DbClient, orgId: string): Promise<number> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, 'admin')));
  return rows.length;
}

export async function queryMemberRole(
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

export async function updateMemberRole(
  db: DbClient,
  orgId: string,
  userId: string,
  role: string,
): Promise<boolean> {
  const result = await db
    .update(organizationMembers)
    .set({ role })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .returning({ userId: organizationMembers.userId });
  return result.length > 0;
}

export async function removeMember(db: DbClient, orgId: string, userId: string): Promise<void> {
  await db
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
}
