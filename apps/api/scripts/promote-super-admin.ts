/**
 * Usage: bun run scripts/promote-super-admin.ts <email>
 *
 * Sets is_super_admin = true for the user with the given email.
 * Requires DATABASE_URL environment variable.
 */

import { createDbClient } from '@vexillo/db';
import { authUser } from '@vexillo/db';
import { eq } from 'drizzle-orm';

const email = process.argv[2];
if (!email) {
  console.error('Usage: bun run scripts/promote-super-admin.ts <email>');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = createDbClient(DATABASE_URL, { max: 1 });

const result = await db
  .update(authUser)
  .set({ isSuperAdmin: true })
  .where(eq(authUser.email, email))
  .returning({ id: authUser.id, email: authUser.email });

if (result.length === 0) {
  console.error(`No user found with email: ${email}`);
  process.exit(1);
}

console.log(`Promoted ${result[0].email} (${result[0].id}) to super admin.`);
process.exit(0);
