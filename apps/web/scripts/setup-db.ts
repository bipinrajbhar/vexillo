import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { environments } from '../lib/schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.local.example to .env.local and fill it in.');
}

const db = drizzle(neon(process.env.DATABASE_URL));

async function seed() {
  console.log('Seeding default environments…');

  await db
    .insert(environments)
    .values([
      { name: 'Production', slug: 'production' },
      { name: 'Staging', slug: 'staging' },
      { name: 'Development', slug: 'development' },
    ])
    .onConflictDoNothing();

  console.log('Done.');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
