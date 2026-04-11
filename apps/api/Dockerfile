FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
COPY packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile

# Copy source
COPY packages/db/src ./packages/db/src
COPY apps/api/src ./src

# Run
EXPOSE 3000
ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
