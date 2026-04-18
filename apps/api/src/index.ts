import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { Scalar } from '@scalar/hono-api-reference';
import { createDbClient } from '@vexillo/db';
import { createSdkRouter, SDK_OPENAPI_CONFIG } from './routes/sdk';
import { createDashboardRouter } from './routes/dashboard';
import { createSuperAdminRouter } from './routes/superadmin';
import { createOrgOAuthRouter } from './routes/org-oauth';
import { createAuth } from './lib/auth';
import { createDashboardService } from './services/dashboard-service';
import { createRedisClients } from './lib/redis';
import { createStreamRegistry } from './lib/stream-registry';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const db = createDbClient(DATABASE_URL, { max: 10 });
const auth = createAuth(db);

// Optional Redis: enables cross-container SSE fan-out. Omit REDIS_URL to run
// single-container (stream still works; toggles reach only local connections).
const REDIS_URL = process.env.REDIS_URL;
const redisClients = REDIS_URL ? createRedisClients(REDIS_URL) : undefined;

// Always create the registry — it works in-memory without Redis. The Redis
// subscriber is only needed for cross-container fan-out.
const streamRegistry = createStreamRegistry(redisClients?.subscriber);

// With Redis: publish to the channel so all containers' subscribers pick it up.
// Without Redis: broadcast directly into the local registry.
const notifyFlagChange = redisClients
  ? (envId: string, payload: string) =>
      redisClients.publisher.publish(`flags:env:${envId}`, payload)
  : (envId: string, payload: string) =>
      streamRegistry.broadcast(envId, payload);

const dashboardService = createDashboardService(db, notifyFlagChange);

const app = new Hono();

// Security headers — applied to all responses.
// crossOriginResourcePolicy/crossOriginOpenerPolicy/crossOriginEmbedderPolicy are
// disabled here because the SDK route explicitly sets CORS * for cross-origin SDK
// clients; those routes manage their own cross-origin posture.
app.use(
  secureHeaders({
    xFrameOptions: 'DENY',
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    xContentTypeOptions: true,
    xXssProtection: true,
    xDnsPrefetchControl: true,
    xDownloadOptions: true,
    xPermittedCrossDomainPolicies: true,
    originAgentCluster: true,
    // Disabled: SDK routes serve cross-origin clients and manage their own headers.
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    // No CSP at the middleware level — the API serves JSON, not HTML.
    // CSP for the SPA is enforced via CloudFront response headers policy.
  }),
);

// Health check — ALB target group uses "/" (CF default), also expose "/health"
// and "/api/health" (the path CloudFront forwards after stripping nothing from /api/*)
app.get('/', (c) => c.json({ status: 'ok' }));
app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Per-org Okta OAuth — must be before the BetterAuth catch-all
app.route('/api/auth/org-oauth', createOrgOAuthRouter(db, auth));

// Auth routes — BetterAuth handles /api/auth/* (session)
app.all('/api/auth/*', (c) => auth.handler(c.req.raw));

// SDK routes — public, CORS *, CDN-cacheable
const sdkRouter = createSdkRouter(db, streamRegistry);
app.route('/api/sdk', sdkRouter);

// OpenAPI spec + interactive docs (unauthenticated; internal use only)
app.get('/openapi.json', (c) => c.json(sdkRouter.getOpenAPIDocument(SDK_OPENAPI_CONFIG)));
app.get('/docs', Scalar({ url: '/openapi.json' }));

// Dashboard routes — session auth required
app.route(
  '/api/dashboard',
  createDashboardRouter(dashboardService, (headers) => auth.api.getSession({ headers })),
);

// Super-admin routes — isSuperAdmin required
app.route(
  '/api/superadmin',
  createSuperAdminRouter(db, (headers) => auth.api.getSession({ headers })),
);

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
  // SSE connections are kept alive by a 25s keepalive comment; Bun's 10s default
  // idle timeout would close them before the first keepalive fires.
  idleTimeout: 120,
};
