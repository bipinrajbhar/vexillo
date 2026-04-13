/**
 * One-time migration: encrypt plaintext oktaClientSecret values stored before
 * AES-256-GCM encryption was introduced.
 *
 * Safe to re-run — values that decrypt successfully are skipped.
 *
 * Usage:
 *   DATABASE_URL=... OKTA_SECRET_KEY=... bun run scripts/encrypt-okta-secrets.ts
 */

import { eq } from 'drizzle-orm';
import { createDbClient, organizations } from '@vexillo/db';
import { encryptSecret, decryptSecret } from '../src/lib/okta-crypto';

const db = createDbClient(process.env.DATABASE_URL!);

const orgs = await db
  .select({ id: organizations.id, slug: organizations.slug, secret: organizations.oktaClientSecret })
  .from(organizations);

let migrated = 0;
let skipped = 0;

for (const org of orgs) {
  // Try to decrypt — if it succeeds, the value is already encrypted; skip it.
  try {
    await decryptSecret(org.secret);
    skipped++;
    continue;
  } catch {
    // Decryption failed → plaintext; proceed to encrypt.
  }

  const encrypted = await encryptSecret(org.secret);
  await db.update(organizations).set({ oktaClientSecret: encrypted }).where(eq(organizations.id, org.id));
  console.log(`Encrypted secret for org: ${org.slug}`);
  migrated++;
}

console.log(`\nDone. Migrated: ${migrated}, skipped (already encrypted): ${skipped}`);
process.exit(0);
