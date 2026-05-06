import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { Scalar } from '@scalar/hono-api-reference';
import { createDbClient } from '@vexillo/db';
import { createSdkRouter, SDK_OPENAPI_CONFIG } from './routes/sdk';
import { createSdkAuthenticator } from './lib/sdk-authenticator';
import { createDashboardRouter } from './routes/dashboard';
import { createSuperAdminRouter } from './routes/superadmin';
import { createOrgOAuthRouter } from './routes/org-oauth';
import { createOrgOAuth } from './lib/org-oauth';
import { createInternalRouter } from './routes/internal';
import { createAuth } from './lib/auth';
import { createDashboardService } from './services/dashboard-service';
import { createFlagOps } from './services/flag-ops';
import { createSuperAdminService } from './services/superadmin-service';
import { createRedisClients } from './lib/redis';
import { createRegionFanout, parseSecondaryUrls } from './lib/region-fanout';
import { createFlagSnapshots } from './lib/flag-snapshots';
import {
  createInMemoryInterContainerBus,
  createPostgresSnapshotLoader,
  createRedisInterContainerBus,
} from './lib/flag-snapshots/adapters';
import { createOrgContextResolver } from './lib/org-context-resolver';

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

// Cross-region fan-out: when SECONDARY_REGION_URLS is set, flag changes are
// POSTed to each secondary region's /internal/flag-change endpoint. Fire-and-
// forget — a failure logs a warning but does not block the primary's response.
// If INTERNAL_SECRET is not configured a random value is used at startup so the
// endpoint is locked even without an explicit secret.
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? crypto.randomUUID();
const fanoutToRegions = createRegionFanout(
  parseSecondaryUrls(process.env.SECONDARY_REGION_URLS),
  INTERNAL_SECRET,
);

// FlagSnapshots owns the snapshot cache, the SSE listener registry, the
// inter-container fan-out (Redis when present, in-memory otherwise), the cold-
// miss DB load + SWR refresh, country-rule evaluation, and the region fanout.
// The reader/writer split structurally enforces the no-region-loop rule:
// /internal/flag-change is handed only the writer, and writer.ingestRemote
// never fans out to peer regions.
const { reader: flagSnapshotReader, writer: flagSnapshotWriter } = createFlagSnapshots({
  loader: createPostgresSnapshotLoader({ db }),
  interContainer: redisClients
    ? createRedisInterContainerBus({
        publisher: redisClients.publisher,
        subscriber: redisClients.subscriber,
      })
    : createInMemoryInterContainerBus(),
  fanoutToRegions,
});

const orgContextResolver = createOrgContextResolver({ db });

// SDK request pipeline: SdkAuthenticator owns the auth+origin gate (3-table
// join + LRU + SWR), the FlagSnapshots reader owns the snapshot fetch+evaluate
// path. The route composes them and never sees `allowedOrigins` or raw flag rows.
const sdkAuthenticator = createSdkAuthenticator({ db });

// FlagOps owns post-mutation effect coordination for the dashboard write
// path: audit-log insert (atomic with caller tx when one is supplied), the
// re-query-and-publish dance for SDK snapshot updates, the four orgId-keyed
// list caches, the SDK auth-cache eviction (required, not a silent no-op),
// and OrgContextResolver invalidation. DashboardService writes to the DB;
// FlagOps fans out the consequences.
const flagOps = createFlagOps({
  db,
  flagSnapshots: { writer: flagSnapshotWriter },
  sdkAuth: sdkAuthenticator,
  orgContext: orgContextResolver,
});
const dashboardService = createDashboardService(db, flagOps);

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
const orgOAuthService = createOrgOAuth({
  db,
  auth,
  baseUrl: process.env.BETTER_AUTH_URL ?? '',
  superAdminEmails: process.env.SUPER_ADMIN_EMAILS ?? '',
});
app.route('/api/auth/org-oauth', createOrgOAuthRouter(orgOAuthService));

// Auth routes — BetterAuth handles /api/auth/* (session)
app.all('/api/auth/*', (c) => auth.handler(c.req.raw));

// SDK routes — public, CORS *, CDN-cacheable
const sdkRouter = createSdkRouter({
  authenticator: sdkAuthenticator,
  snapshotReader: flagSnapshotReader,
});
app.route('/api/sdk', sdkRouter);

// OpenAPI spec + interactive docs (unauthenticated; internal use only)
// Must be under /api/* so CloudFront forwards them to the ALB instead of S3.
app.get('/api/openapi.json', (c) => {
  c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
  return c.json(sdkRouter.getOpenAPIDocument(SDK_OPENAPI_CONFIG));
});
app.get('/api/docs', Scalar({ url: '/api/openapi.json' }));

// Dashboard routes — session auth required
app.route(
  '/api/dashboard',
  createDashboardRouter(dashboardService, (headers) => auth.api.getSession({ headers }), orgContextResolver),
);

// Super-admin routes — isSuperAdmin required
const superAdminService = createSuperAdminService(db, orgOAuthService);
app.route(
  '/api/superadmin',
  createSuperAdminRouter(superAdminService, (headers) => auth.api.getSession({ headers })),
);

// Internal cross-region propagation — not exposed via CloudFront; reachable
// only via the ALB directly from the primary region's ECS tasks.
app.route('/internal', createInternalRouter(flagSnapshotWriter, INTERNAL_SECRET));

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
  // SSE connections are kept alive by a 25s keepalive comment; Bun's 10s default
  // idle timeout would close them before the first keepalive fires.
  idleTimeout: 120,
};
