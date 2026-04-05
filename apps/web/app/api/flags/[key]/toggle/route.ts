import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { flags, flagStates } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { key } = await params;
  const { environmentId } = await req.json();

  if (!environmentId) {
    return NextResponse.json({ error: 'environmentId is required' }, { status: 400 });
  }

  const [flag] = await db.select({ id: flags.id }).from(flags).where(eq(flags.key, key));
  if (!flag) {
    return NextResponse.json({ error: 'Flag not found' }, { status: 404 });
  }

  const [state] = await db
    .insert(flagStates)
    .values({ flagId: flag.id, environmentId, enabled: true })
    .onConflictDoUpdate({
      target: [flagStates.flagId, flagStates.environmentId],
      set: { enabled: sql`NOT ${flagStates.enabled}` },
    })
    .returning({ enabled: flagStates.enabled });

  return NextResponse.json({ enabled: state.enabled });
}
