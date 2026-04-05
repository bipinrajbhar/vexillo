import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { environments } from '@/lib/schema';
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

  if (!Array.isArray(body.allowedOrigins) || !body.allowedOrigins.every((o: unknown) => typeof o === 'string')) {
    return NextResponse.json({ error: 'allowedOrigins must be an array of strings' }, { status: 400 });
  }

  const result = await db
    .update(environments)
    .set({ allowedOrigins: body.allowedOrigins })
    .where(eq(environments.id, id))
    .returning({ id: environments.id, allowedOrigins: environments.allowedOrigins });

  if (result.length === 0) {
    return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
  }

  return NextResponse.json({ environment: result[0] });
}
