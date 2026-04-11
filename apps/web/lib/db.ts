import { createDbClient } from '@vexillo/db';

// Single shared client for the Next.js app.
// Uses max:1 to avoid connection pool exhaustion in serverless/edge deployments.
export const db = createDbClient(process.env.DATABASE_URL!, { max: 1 });
