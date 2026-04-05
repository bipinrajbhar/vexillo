import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { authUser } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await req.json();
  const role: string = body.role;

  if (role !== 'admin' && role !== 'viewer') {
    return NextResponse.json({ error: 'Role must be admin or viewer' }, { status: 400 });
  }

  const result = await db
    .update(authUser)
    .set({ role })
    .where(eq(authUser.id, id))
    .returning({ id: authUser.id, role: authUser.role });

  if (result.length === 0) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }

  return NextResponse.json({ member: result[0] });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  const result = await db
    .delete(authUser)
    .where(eq(authUser.id, id))
    .returning({ id: authUser.id });

  if (result.length === 0) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}
