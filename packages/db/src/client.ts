import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export type DbClient = ReturnType<typeof createDbClient>;

/**
 * Creates a Drizzle client backed by a persistent TCP Postgres connection.
 *
 * Pass `DATABASE_URL` (a standard postgres:// connection string).
 * In serverless/edge environments use `max: 1` to avoid connection pool leaks.
 */
export function createDbClient(databaseUrl: string, options?: { max?: number }) {
  const queryClient = postgres(databaseUrl, { max: options?.max ?? 10 });
  return drizzle(queryClient, { schema });
}
