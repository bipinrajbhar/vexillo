/**
 * Seed the first organisation so that initial sign-in is possible.
 *
 * All sign-in flows require an org to exist (Okta JIT provisioning).
 * This script creates that org directly in the DB, breaking the
 * bootstrapping deadlock:
 *
 *   seed-org → org exists → sign in via Okta → JIT provisions user
 *            → SUPER_ADMIN_EMAILS promotes to super admin → /admin panel
 *
 * Safe to re-run — exits without changes if the slug already exists.
 *
 * Required env vars:
 *   DATABASE_URL      — Postgres connection string
 *   OKTA_SECRET_KEY   — 64-char hex key used to encrypt the client secret
 *
 * Required args (positional):
 *   1. name              — display name, e.g. "Acme Corp"
 *   2. slug              — URL slug, e.g. "acme"
 *   3. okta-issuer       — e.g. "https://acme.okta.com/oauth2/default"
 *   4. okta-client-id    — Okta app client ID
 *   5. okta-client-secret — Okta app client secret (stored encrypted)
 *
 * Usage:
 *   DATABASE_URL=... OKTA_SECRET_KEY=... bun run scripts/seed-org.ts \
 *     "Acme Corp" acme https://acme.okta.com/oauth2/default <clientId> <clientSecret>
 */

import { eq } from 'drizzle-orm';
import { createDbClient, organizations } from '@vexillo/db';
import { encryptSecret } from '../src/lib/okta-crypto';

const [name, slug, oktaIssuer, oktaClientId, oktaClientSecret] = process.argv.slice(2);

if (!name || !slug || !oktaIssuer || !oktaClientId || !oktaClientSecret) {
  console.error(
    'Usage: seed-org.ts <name> <slug> <okta-issuer> <okta-client-id> <okta-client-secret>',
  );
  process.exit(1);
}

const db = createDbClient(process.env.DATABASE_URL!);

const [existing] = await db
  .select({ id: organizations.id })
  .from(organizations)
  .where(eq(organizations.slug, slug))
  .limit(1);

if (existing) {
  console.log(`Org with slug "${slug}" already exists (id: ${existing.id}). Nothing to do.`);
  process.exit(0);
}

const encryptedSecret = await encryptSecret(oktaClientSecret);

const [org] = await db
  .insert(organizations)
  .values({ name, slug, oktaIssuer, oktaClientId, oktaClientSecret: encryptedSecret })
  .returning({ id: organizations.id });

console.log(`Created org "${name}" (slug: ${slug}, id: ${org.id})`);
console.log(`\nNext steps:`);
console.log(`  1. Add your email to /vexillo/SUPER_ADMIN_EMAILS in SSM (comma-separated)`);
console.log(`  2. Sign in at /org/${slug}/sign-in via Okta`);
console.log(`  3. You will be auto-promoted to super admin on first sign-in`);
process.exit(0);
