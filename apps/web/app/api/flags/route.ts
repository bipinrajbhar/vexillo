import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { flags, environments, flagStates, apiKeys } from "@/lib/schema";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { hashKey } from "@/lib/api-key";
import { auth } from "@/lib/auth";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: PREFLIGHT_HEADERS });
}

function buildCorsHeaders(
  allowedOrigins: string[],
  origin: string | null,
): Headers | null {
  if (!origin) return new Headers();
  if (allowedOrigins.includes("*")) {
    return new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
  }
  if (allowedOrigins.includes(origin)) {
    return new Headers({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      Vary: "Origin",
    });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");

  // SDK path: Authorization: Bearer sdk-xxx
  if (authHeader) {
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: PREFLIGHT_HEADERS },
      );

    const hash = await hashKey(token);
    const [apiKey] = await db
      .select({ environmentId: apiKeys.environmentId })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);

    if (!apiKey)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: PREFLIGHT_HEADERS },
      );

    const [env] = await db
      .select({ allowedOrigins: environments.allowedOrigins })
      .from(environments)
      .where(eq(environments.id, apiKey.environmentId))
      .limit(1);

    const origin = req.headers.get("origin");
    const corsHeaders = buildCorsHeaders(env?.allowedOrigins ?? [], origin);
    if (!corsHeaders) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rows = await db
      .select({
        key: flags.key,
        enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
      })
      .from(flags)
      .leftJoin(
        flagStates,
        and(
          eq(flagStates.flagId, flags.id),
          eq(flagStates.environmentId, apiKey.environmentId),
        ),
      )
      .orderBy(asc(flags.key));

    corsHeaders.set("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return NextResponse.json(
      { flags: rows.map((r) => ({ key: r.key, enabled: r.enabled })) },
      { headers: corsHeaders },
    );
  }

  // Dashboard path: requires session
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
      .orderBy(desc(flags.createdAt), asc(environments.name)),

    db
      .select({
        id: environments.id,
        name: environments.name,
        slug: environments.slug,
      })
      .from(environments)
      .orderBy(asc(environments.name)),
  ]);

  const flagMap = new Map<
    string,
    {
      id: string;
      name: string;
      key: string;
      description: string;
      createdAt: Date;
      states: Record<string, boolean>;
    }
  >();

  for (const row of rows) {
    if (!flagMap.has(row.key)) {
      flagMap.set(row.key, {
        id: row.id,
        name: row.name,
        key: row.key,
        description: row.description,
        createdAt: row.createdAt,
        states: {},
      });
    }
    flagMap.get(row.key)!.states[row.envSlug] = row.enabled;
  }

  return NextResponse.json({
    flags: Array.from(flagMap.values()),
    environments: envRows,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const name: string = body.name?.trim() ?? "";
  const description: string = body.description?.trim() ?? "";
  const key: string = body.key?.trim() || slugify(name);

  if (!name)
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!key) return NextResponse.json({ error: "Invalid key" }, { status: 400 });

  try {
    const [flag] = await db
      .insert(flags)
      .values({ name, key, description })
      .returning();

    const envs = await db.select({ id: environments.id }).from(environments);
    if (envs.length > 0) {
      await db
        .insert(flagStates)
        .values(
          envs.map((env) => ({
            flagId: flag.id,
            environmentId: env.id,
            enabled: false,
          })),
        )
        .onConflictDoNothing();
    }

    return NextResponse.json({ flag }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return NextResponse.json(
        { error: "Flag key already exists" },
        { status: 409 },
      );
    }
    throw err;
  }
}
