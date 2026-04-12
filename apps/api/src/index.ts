import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { createDbClient } from '@vexillo/db';
import { createSdkRouter } from './routes/sdk';
import { createDashboardRouter } from './routes/dashboard';
import { createSuperAdminRouter } from './routes/superadmin';
import { createInvitesRouter } from './routes/invites';
import { createOrgOAuthRouter } from './routes/org-oauth';
import { createAuth } from './lib/auth';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const db = createDbClient(DATABASE_URL, { max: 10 });
const auth = createAuth(db);

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
app.get('/', (c) => c.json({ status: 'ok' }));
app.get('/health', (c) => c.json({ status: 'ok' }));

// Per-org Okta OAuth — must be before the BetterAuth catch-all
app.route('/api/auth/org-oauth', createOrgOAuthRouter(db, auth));

// Auth routes — BetterAuth handles /api/auth/* (session)
app.all('/api/auth/*', (c) => auth.handler(c.req.raw));

// SDK routes — public, CORS *, CDN-cacheable
app.route('/api/sdk', createSdkRouter(db));

// Dashboard routes — session auth required
app.route(
  '/api/dashboard',
  createDashboardRouter(db, (headers) => auth.api.getSession({ headers })),
);

// Super-admin routes — isSuperAdmin required
app.route(
  '/api/superadmin',
  createSuperAdminRouter(db, (headers) => auth.api.getSession({ headers })),
);

// Invite accept route — public-ish (requires authenticated session, not org membership)
app.route(
  '/api/invites',
  createInvitesRouter(db, (headers) => auth.api.getSession({ headers })),
);

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};
