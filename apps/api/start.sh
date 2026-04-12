#!/bin/sh
set -e

# Merge stderr into stdout so every log line reaches CloudWatch
exec 2>&1

echo "=== container start: PORT=$PORT NODE_ENV=$NODE_ENV ==="

echo "Running database migrations..."
cd /app/packages/db
# Disable set -e temporarily so we can capture exit code and log output
set +e
./node_modules/.bin/drizzle-kit migrate > /tmp/migrate.log 2>&1
MIGRATE_EXIT=$?
set -e
# Print full output — bypasses spinner ANSI that hides errors in CloudWatch
cat /tmp/migrate.log
echo "drizzle-kit exited: $MIGRATE_EXIT"
if [ "$MIGRATE_EXIT" -ne 0 ]; then
  echo "ERROR: migrations failed — see output above"
  exit 1
fi
echo "Migrations done."

echo "Starting API server..."
cd /app
exec bun run apps/api/src/index.ts
