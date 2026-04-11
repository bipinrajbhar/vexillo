import { config } from 'dotenv';
config({ path: '.env.local' });

import { createDbClient, environments } from '@vexillo/db';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.local.example to .env.local and fill it in.');
}

const db = createDbClient(process.env.DATABASE_URL, { max: 1 });

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

seed()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
