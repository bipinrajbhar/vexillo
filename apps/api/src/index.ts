import { Hono } from 'hono';
import { createDbClient } from '@vexillo/db';
import { createSdkRouter } from './routes/sdk';
import { createDashboardRouter } from './routes/dashboard';
import { createAuth } from './lib/auth';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const db = createDbClient(DATABASE_URL, { max: 10 });
const auth = createAuth(db);

const app = new Hono();

// Health check — used by App Runner and CloudFront origin health checks
app.get('/health', (c) => c.json({ status: 'ok' }));

// Auth routes — BetterAuth handles /api/auth/* (Okta OAuth, session)
app.all('/api/auth/*', (c) => auth.handler(c.req.raw));

// SDK routes — public, CORS *, CDN-cacheable
app.route('/api/sdk', createSdkRouter(db));

// Dashboard routes — session auth required
app.route(
  '/api/dashboard',
  createDashboardRouter(db, (headers) => auth.api.getSession({ headers })),
);

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};
