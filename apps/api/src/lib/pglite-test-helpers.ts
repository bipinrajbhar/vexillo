import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@vexillo/db';
import type { DbClient } from '@vexillo/db';
import { hashKey } from './api-key';

const MIGRATIONS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'drizzle',
);

// Drizzle's `migrate()` uses a journal that pglite's local driver doesn't
// always agree with under Bun. Applying the SQL directly keeps the helper
// dependency-free at the test level: we only need the schema, not a migration
// state machine.
async function applyMigrations(pglite: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed.length === 0) continue;
      await pglite.exec(trimmed);
    }
  }
}

export async function createTestDb(): Promise<DbClient> {
  const pglite = new PGlite();
  await applyMigrations(pglite);
  return drizzle(pglite, { schema }) as unknown as DbClient;
}

export type SdkSeed = {
  orgId: string;
  environmentId: string;
  apiKey: string;
  flagId?: string;
};

export type SdkSeedOptions = {
  orgStatus?: 'active' | 'suspended';
  allowedOrigins?: string[];
  flag?: {
    key: string;
    enabled: boolean;
    allowedCountries?: string[];
  };
};

/**
 * Seeds a single org / env / api-key chain plus an optional flag + flag-state.
 * Returns the raw API key string (caller hands this to the authenticator as the
 * Bearer token) and the IDs of the rows that were inserted.
 */
export async function seedSdk(
  db: DbClient,
  opts: SdkSeedOptions = {},
): Promise<SdkSeed> {
  const apiKeyValue = `sdk-${crypto.randomUUID().replace(/-/g, '')}`;
  const keyHash = await hashKey(apiKeyValue);

  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: 'Test Org',
      slug: `test-${crypto.randomUUID().slice(0, 8)}`,
      oktaClientId: 'okta-client',
      oktaClientSecret: 'okta-secret',
      oktaIssuer: 'https://example.okta.com',
      status: opts.orgStatus ?? 'active',
    })
    .returning({ id: schema.organizations.id });

  const [env] = await db
    .insert(schema.environments)
    .values({
      orgId: org.id,
      name: 'Production',
      slug: 'prod',
      allowedOrigins: opts.allowedOrigins ?? [],
    })
    .returning({ id: schema.environments.id });

  await db.insert(schema.apiKeys).values({
    environmentId: env.id,
    keyHash,
    keyHint: apiKeyValue.slice(0, 12),
  });

  let flagId: string | undefined;
  if (opts.flag) {
    const [flag] = await db
      .insert(schema.flags)
      .values({
        orgId: org.id,
        name: opts.flag.key,
        key: opts.flag.key,
      })
      .returning({ id: schema.flags.id });
    flagId = flag.id;
    await db.insert(schema.flagStates).values({
      flagId: flag.id,
      environmentId: env.id,
      enabled: opts.flag.enabled,
      allowedCountries: opts.flag.allowedCountries ?? [],
    });
  }

  return { orgId: org.id, environmentId: env.id, apiKey: apiKeyValue, flagId };
}
