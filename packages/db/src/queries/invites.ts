import { eq, and, isNull, gt, asc } from 'drizzle-orm';
import { invites } from '../schema';
import type { DbClient } from '../client';

export type InviteRow = {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
};

export async function queryPendingInvites(db: DbClient, orgId: string): Promise<InviteRow[]> {
  return db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .where(
      and(eq(invites.orgId, orgId), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())),
    )
    .orderBy(asc(invites.createdAt));
}

export async function deletePendingInviteByEmail(
  db: DbClient,
  orgId: string,
  email: string,
): Promise<void> {
  await db
    .delete(invites)
    .where(
      and(
        eq(invites.orgId, orgId),
        eq(invites.email, email),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    );
}

export async function insertInvite(
  db: DbClient,
  orgId: string,
  input: {
    invitedByUserId: string;
    email: string;
    tokenHash: string;
    role: string;
    expiresAt: Date;
  },
): Promise<InviteRow> {
  const [invite] = await db
    .insert(invites)
    .values({ orgId, ...input })
    .returning({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    });
  return invite;
}

export async function revokeInvite(
  db: DbClient,
  orgId: string,
  inviteId: string,
): Promise<boolean> {
  const result = await db
    .delete(invites)
    .where(and(eq(invites.id, inviteId), eq(invites.orgId, orgId)))
    .returning({ id: invites.id });
  return result.length > 0;
}
