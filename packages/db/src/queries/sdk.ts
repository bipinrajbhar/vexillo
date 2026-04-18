import { eq, and, asc, sql } from 'drizzle-orm';
import { apiKeys, environments, organizations, flags, flagStates } from '../schema';
import type { DbClient } from '../client';

export async function resolveApiKey(
  db: DbClient,
  keyHash: string,
): Promise<{ environmentId: string; allowedOrigins: string[]; orgStatus: string } | null> {
  const [apiKey] = await db
    .select({ environmentId: apiKeys.environmentId })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (!apiKey) return null;

  const [env] = await db
    .select({
      id: environments.id,
      allowedOrigins: environments.allowedOrigins,
      orgStatus: organizations.status,
    })
    .from(environments)
    .innerJoin(organizations, eq(organizations.id, environments.orgId))
    .where(eq(environments.id, apiKey.environmentId))
    .limit(1);

  if (!env) return null;

  return { environmentId: env.id, allowedOrigins: env.allowedOrigins, orgStatus: env.orgStatus };
}

export async function queryEnvironmentFlagStates(
  db: DbClient,
  orgId: string,
  environmentId: string,
): Promise<{ key: string; enabled: boolean }[]> {
  return db
    .select({
      key: flags.key,
      enabled: sql<boolean>`COALESCE(${flagStates.enabled}, false)`,
    })
    .from(flags)
    .leftJoin(
      flagStates,
      and(eq(flagStates.flagId, flags.id), eq(flagStates.environmentId, environmentId)),
    )
    .where(eq(flags.orgId, orgId))
    .orderBy(asc(flags.key));
}
