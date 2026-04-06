import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { flags, environments, flagStates } from "@/lib/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;

  const [rows, envRows] = await Promise.all([
    db
      .select({
        id: flags.id,
        name: flags.name,
        key: flags.key,
        description: flags.description,
        createdAt: flags.createdAt,
        envSlug: environments.slug,
        enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
      })
      .from(flags)
      .crossJoin(environments)
      .leftJoin(
        flagStates,
        and(
          eq(flagStates.flagId, flags.id),
          eq(flagStates.environmentId, environments.id),
        ),
      )
      .where(eq(flags.key, key))
      .orderBy(asc(environments.name)),

    db
      .select({
        id: environments.id,
        name: environments.name,
        slug: environments.slug,
      })
      .from(environments)
      .orderBy(asc(environments.name)),
  ]);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  }

  const first = rows[0];
  const states: Record<string, boolean> = {};
  for (const row of rows) {
    states[row.envSlug] = row.enabled;
  }

  return NextResponse.json({
    flag: {
      id: first.id,
      name: first.name,
      key: first.key,
      description: first.description,
      createdAt: first.createdAt,
      states,
    },
    environments: envRows,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await params;
  const body = await req.json();
  const name: string | undefined = body.name?.trim();
  const description: string | undefined = body.description?.trim();

  if (name !== undefined && !name) {
    return NextResponse.json(
      { error: "Name cannot be empty" },
      { status: 400 },
    );
  }

  const updates: Partial<typeof flags.$inferInsert> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const result = await db
    .update(flags)
    .set(updates)
    .where(eq(flags.key, key))
    .returning();

  if (result.length === 0) {
    return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  }

  return NextResponse.json({ flag: result[0] });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await params;

  const result = await db
    .delete(flags)
    .where(eq(flags.key, key))
    .returning({ id: flags.id });

  if (result.length === 0) {
    return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}
