import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { flags, environments, flagStates, authUser } from '../schema';
import type { DbClient } from '../client';

export type FlagWithStates = {
  id: string;
  name: string;
  key: string;
  description: string;
  createdAt: Date;
  createdByName: string | null;
  states: Record<string, boolean>;
};

export type EnvRef = { id: string; name: string; slug: string };

export type FlagRolloutRow = { id: string; name: string; slug: string; enabled: boolean };

export async function queryOrgFlagsWithStates(
  db: DbClient,
  orgId: string,
): Promise<{ flags: FlagWithStates[]; environments: EnvRef[] }> {
  const [rows, envRows] = await Promise.all([
    db
      .select({
        id: flags.id,
        name: flags.name,
        key: flags.key,
        description: flags.description,
        createdAt: flags.createdAt,
        createdByName: authUser.name,
        envSlug: environments.slug,
        enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
      })
      .from(flags)
      .crossJoin(environments)
      .leftJoin(
        flagStates,
        and(eq(flagStates.flagId, flags.id), eq(flagStates.environmentId, environments.id)),
      )
      .leftJoin(authUser, eq(authUser.id, flags.createdByUserId))
      .where(and(eq(flags.orgId, orgId), eq(environments.orgId, orgId)))
      .orderBy(desc(flags.createdAt), asc(environments.name)),
    db
      .select({ id: environments.id, name: environments.name, slug: environments.slug })
      .from(environments)
      .where(eq(environments.orgId, orgId))
      .orderBy(asc(environments.name)),
  ]);

  const flagMap = new Map<string, FlagWithStates>();
  for (const row of rows) {
    if (!flagMap.has(row.key)) {
      flagMap.set(row.key, {
        id: row.id,
        name: row.name,
        key: row.key,
        description: row.description,
        createdAt: row.createdAt,
        createdByName: row.createdByName ?? null,
        states: {},
      });
    }
    flagMap.get(row.key)!.states[row.envSlug] = row.enabled;
  }

  return { flags: Array.from(flagMap.values()), environments: envRows };
}

export async function queryFlagByKey(
  db: DbClient,
  orgId: string,
  key: string,
): Promise<{ flag: FlagWithStates; rollout: FlagRolloutRow[] } | null> {
  const rows = await db
    .select({
      id: flags.id,
      name: flags.name,
      key: flags.key,
      description: flags.description,
      createdAt: flags.createdAt,
      createdByName: authUser.name,
      envSlug: environments.slug,
      envName: environments.name,
      environmentId: environments.id,
      enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
    })
    .from(flags)
    .crossJoin(environments)
    .leftJoin(
      flagStates,
      and(eq(flagStates.flagId, flags.id), eq(flagStates.environmentId, environments.id)),
    )
    .leftJoin(authUser, eq(authUser.id, flags.createdByUserId))
    .where(and(eq(flags.key, key), eq(flags.orgId, orgId)))
    .orderBy(asc(environments.name));

  if (rows.length === 0) return null;

  const first = rows[0];
  const states: Record<string, boolean> = {};
  const rollout: FlagRolloutRow[] = [];
  for (const row of rows) {
    states[row.envSlug] = row.enabled;
    rollout.push({ id: row.environmentId, name: row.envName, slug: row.envSlug, enabled: row.enabled });
  }

  return {
    flag: {
      id: first.id,
      name: first.name,
      key: first.key,
      description: first.description,
      createdAt: first.createdAt,
      createdByName: first.createdByName ?? null,
      states,
    },
    rollout,
  };
}

export async function insertFlag(
  db: DbClient,
  orgId: string,
  input: { name: string; key: string; description: string; createdByUserId?: string },
): Promise<typeof flags.$inferSelect> {
  const [flag] = await db
    .insert(flags)
    .values({ orgId, name: input.name, key: input.key, description: input.description, createdByUserId: input.createdByUserId })
    .returning();
  return flag;
}

export async function backfillFlagStatesForFlag(
  db: DbClient,
  flagId: string,
  environmentIds: string[],
): Promise<void> {
  if (environmentIds.length === 0) return;
  await db
    .insert(flagStates)
    .values(environmentIds.map((envId) => ({ flagId, environmentId: envId, enabled: false })))
    .onConflictDoNothing();
}

export async function updateFlag(
  db: DbClient,
  orgId: string,
  key: string,
  patch: { name?: string; description?: string },
): Promise<typeof flags.$inferSelect | null> {
  const result = await db
    .update(flags)
    .set(patch)
    .where(and(eq(flags.key, key), eq(flags.orgId, orgId)))
    .returning();
  return result[0] ?? null;
}

export async function deleteFlag(db: DbClient, orgId: string, key: string): Promise<boolean> {
  const result = await db
    .delete(flags)
    .where(and(eq(flags.key, key), eq(flags.orgId, orgId)))
    .returning({ id: flags.id });
  return result.length > 0;
}

export async function toggleFlag(
  db: DbClient,
  orgId: string,
  key: string,
  environmentId: string,
): Promise<{ enabled: boolean } | null> {
  const [flag] = await db
    .select({ id: flags.id })
    .from(flags)
    .where(and(eq(flags.key, key), eq(flags.orgId, orgId)));

  if (!flag) return null;

  const [state] = await db
    .insert(flagStates)
    .values({ flagId: flag.id, environmentId, enabled: true })
    .onConflictDoUpdate({
      target: [flagStates.flagId, flagStates.environmentId],
      set: { enabled: sql`NOT ${flagStates.enabled}` },
    })
    .returning({ enabled: flagStates.enabled });

  return { enabled: state.enabled };
}

export async function setFlagCountryRules(
  db: DbClient,
  orgId: string,
  key: string,
  environmentId: string,
  allowedCountries: string[],
): Promise<{ before: string[]; after: string[] } | null> {
  const [flag] = await db
    .select({ id: flags.id })
    .from(flags)
    .where(and(eq(flags.key, key), eq(flags.orgId, orgId)));

  if (!flag) return null;

  const [current] = await db
    .select({ allowedCountries: flagStates.allowedCountries })
    .from(flagStates)
    .where(and(eq(flagStates.flagId, flag.id), eq(flagStates.environmentId, environmentId)))
    .limit(1);

  const before = current?.allowedCountries ?? [];

  const [updated] = await db
    .insert(flagStates)
    .values({ flagId: flag.id, environmentId, enabled: false, allowedCountries })
    .onConflictDoUpdate({
      target: [flagStates.flagId, flagStates.environmentId],
      set: { allowedCountries },
    })
    .returning({ allowedCountries: flagStates.allowedCountries });

  return { before, after: updated.allowedCountries };
}
