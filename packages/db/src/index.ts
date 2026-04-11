export * from './schema';
export { createDbClient } from './client';
export type { DbClient } from './client';

// Re-export Drizzle types commonly needed by consumers
export type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
