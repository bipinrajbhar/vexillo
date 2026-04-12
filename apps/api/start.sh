#!/bin/sh
set -e

echo "Running database migrations..."
cd /app/packages/db
./node_modules/.bin/drizzle-kit migrate

echo "Starting API server..."
cd /app
exec bun run apps/api/src/index.ts
