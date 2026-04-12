import { eq, and, asc } from 'drizzle-orm';
import { environments, apiKeys, flags, flagStates } from '../schema';
import type { DbClient } from '../client';

export type EnvironmentWithKey = {
  id: string;
  name: string;
  slug: string;
  allowedOrigins: string[];
  createdAt: Date;
  keyHint: string | null;
};

export async function queryOrgEnvironments(
  db: DbClient,
  orgId: string,
): Promise<EnvironmentWithKey[]> {
  return db
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
    .where(eq(environments.orgId, orgId))
    .orderBy(asc(environments.name));
}

export async function queryOrgEnvironmentIds(
  db: DbClient,
  orgId: string,
): Promise<{ id: string }[]> {
  return db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.orgId, orgId));
}

/** Creates the environment, its API key, and backfills flag states — all in one transaction. */
export async function insertEnvironmentWithKey(
  db: DbClient,
  orgId: string,
  input: { name: string; slug: string; keyHash: string; keyHint: string },
): Promise<typeof environments.$inferSelect> {
  return db.transaction(async (tx) => {
    const [env] = await tx
      .insert(environments)
      .values({ orgId, name: input.name, slug: input.slug })
      .returning();

    await tx.insert(apiKeys).values({
      environmentId: env.id,
      keyHash: input.keyHash,
      keyHint: input.keyHint,
    });

    const existingFlags = await tx
      .select({ id: flags.id })
      .from(flags)
      .where(eq(flags.orgId, orgId));

    if (existingFlags.length > 0) {
      await tx
        .insert(flagStates)
        .values(existingFlags.map((f) => ({ flagId: f.id, environmentId: env.id, enabled: false })))
        .onConflictDoNothing();
    }

    return env;
  });
}

export async function updateEnvironmentOrigins(
  db: DbClient,
  orgId: string,
  id: string,
  allowedOrigins: string[],
): Promise<{ id: string; allowedOrigins: string[] } | null> {
  const result = await db
    .update(environments)
    .set({ allowedOrigins })
    .where(and(eq(environments.id, id), eq(environments.orgId, orgId)))
    .returning({ id: environments.id, allowedOrigins: environments.allowedOrigins });
  return result[0] ?? null;
}

export async function deleteEnvironment(
  db: DbClient,
  orgId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .delete(environments)
    .where(and(eq(environments.id, id), eq(environments.orgId, orgId)))
    .returning({ id: environments.id });
  return result.length > 0;
}

export async function rotateEnvironmentKey(
  db: DbClient,
  orgId: string,
  envId: string,
  input: { keyHash: string; keyHint: string },
): Promise<boolean> {
  const [env] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.id, envId), eq(environments.orgId, orgId)));

  if (!env) return false;

  await db.delete(apiKeys).where(eq(apiKeys.environmentId, envId));
  await db.insert(apiKeys).values({ environmentId: envId, ...input });
  return true;
}
