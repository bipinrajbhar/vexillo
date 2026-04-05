import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { environments, apiKeys } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { generateApiKey, hashKey, maskKey } from '@/lib/api-key';
import { auth } from '@/lib/auth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  const [env] = await db.select({ id: environments.id }).from(environments).where(eq(environments.id, id));
  if (!env) {
    return NextResponse.json({ error: 'Environment not found' }, { status: 404 });
  }

  const rawKey = generateApiKey();
  const keyHash = await hashKey(rawKey);
  const keyHint = maskKey(rawKey);

  await db.delete(apiKeys).where(eq(apiKeys.environmentId, id));
  await db.insert(apiKeys).values({ environmentId: id, keyHash, keyHint });

  return NextResponse.json({ apiKey: rawKey });
}
