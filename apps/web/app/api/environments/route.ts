import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { db } from '@/lib/db';
import { environments, apiKeys, flags, flagStates } from '@/lib/schema';
import { eq, asc } from 'drizzle-orm';
import { generateApiKey, hashKey, maskKey } from '@/lib/api-key';
import { auth } from '@/lib/auth';

export async function GET() {
  try {
    const envRows = await db
      .select({
        id: environments.id,
        name: environments.name,
        slug: environments.slug,
        allowedOrigins: environments.allowedOrigins,
        createdAt: environments.createdAt,
        keyHint: apiKeys.keyHint,
      })
      .from(environments)
      .leftJoin(apiKeys, eq(apiKeys.environmentId, environments.id))
      .orderBy(asc(environments.name));

    return NextResponse.json({ environments: envRows });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json();
  const name: string = body.name?.trim() ?? '';

  if (!name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
  }

  const rawKey = generateApiKey();
  const keyHash = await hashKey(rawKey);
  const keyHint = maskKey(rawKey);

  let env: typeof environments.$inferSelect | undefined;

  try {
    [env] = await db.insert(environments).values({ name, slug }).returning();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'Environment name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: msg || 'Failed to create environment' }, { status: 500 });
  }

  try {
    await db.insert(apiKeys).values({ environmentId: env.id, keyHash, keyHint });

    const existingFlags = await db.select({ id: flags.id }).from(flags);
    if (existingFlags.length > 0) {
      await db
        .insert(flagStates)
        .values(existingFlags.map((f) => ({ flagId: f.id, environmentId: env.id, enabled: false })))
        .onConflictDoNothing();
    }
  } catch (err: unknown) {
    await db.delete(environments).where(eq(environments.id, env.id));
    const msg = err instanceof Error ? err.message : '';
    return NextResponse.json({ error: msg || 'Failed to create environment' }, { status: 500 });
  }

  return NextResponse.json({ environment: env, apiKey: rawKey }, { status: 201 });
}
