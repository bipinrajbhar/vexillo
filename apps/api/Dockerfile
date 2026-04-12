FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies (includes drizzle-kit for migrations)
COPY package.json bun.lock* ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile

# Copy source + migration files
COPY packages/db/src ./packages/db/src
COPY packages/db/drizzle ./packages/db/drizzle
COPY packages/db/drizzle.config.ts ./packages/db/drizzle.config.ts
# Keep API source at its workspace path so bun resolves apps/api/node_modules
COPY apps/api/src ./apps/api/src

# Startup: run pending migrations, then start the API server.
# drizzle-kit migrate is idempotent — safe to run on every deploy.
COPY apps/api/start.sh ./start.sh
RUN chmod +x start.sh

EXPOSE 8080
ENV NODE_ENV=production
CMD ["./start.sh"]
