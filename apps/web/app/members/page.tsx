import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { asc } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { authUser } from '@/lib/schema';
import MembersClient from './members-client';

export default async function MembersPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session || session.user.role !== 'admin') {
    redirect('/');
  }

  const members = await db
    .select({
      id: authUser.id,
      name: authUser.name,
      email: authUser.email,
      role: authUser.role,
      createdAt: authUser.createdAt,
    })
    .from(authUser)
    .orderBy(asc(authUser.createdAt));

  return (
    <MembersClient
      initialMembers={members.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))}
      currentUserId={session.user.id}
    />
  );
}
