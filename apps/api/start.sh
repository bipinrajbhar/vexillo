#!/bin/sh
set -e

# Merge stderr into stdout so every log line reaches CloudWatch
exec 2>&1

echo "=== container start: PORT=$PORT NODE_ENV=$NODE_ENV ==="

echo "Running database migrations..."
cd /app/packages/db
# CI=true disables ora's interactive spinner so drizzle-kit writes plain
# text to stdout/stderr (not /dev/tty) — making errors visible in CloudWatch.
set +e
CI=true NO_COLOR=1 ./node_modules/.bin/drizzle-kit migrate > /tmp/migrate.log 2>&1
MIGRATE_EXIT=$?
set -e
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
