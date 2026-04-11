import { Hono } from 'hono';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { invites, organizationMembers } from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey } from '../lib/api-key';
import type { GetSession } from './dashboard';

export function createInvitesRouter(db: DbClient, getSession: GetSession) {
  const router = new Hono();

  // POST /api/invites/accept — accept an invite (requires authenticated session)
  // Body: { token: string }
  // The invitee must already be signed in; the web page handles redirecting to
  // sign-in first and then calling this endpoint.
  router.post('/accept', async (c) => {
    const session = await getSession(c.req.raw.headers);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json();
    const rawToken: string = body.token;
    if (!rawToken) return c.json({ error: 'Token is required' }, 400);

    const tokenHash = await hashKey(rawToken);
    const now = new Date();

    const [invite] = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.tokenHash, tokenHash),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
        ),
      )
      .limit(1);

    if (!invite) return c.json({ error: 'Invite not found or expired' }, 404);

    // Add user to org (ignore if already a member)
    await db
      .insert(organizationMembers)
      .values({
        orgId: invite.orgId,
        userId: session.user.id,
        role: invite.role,
      })
      .onConflictDoNothing();

    // Mark invite accepted
    await db
      .update(invites)
      .set({ acceptedAt: now })
      .where(eq(invites.id, invite.id));

    return c.json({ orgId: invite.orgId, role: invite.role });
  });

  return router;
}
