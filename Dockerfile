# ─── Stage 1: install dependencies (pnpm) ──────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/demo/package.json ./apps/demo/
COPY packages/db/package.json ./packages/db/
COPY packages/react-sdk/package.json ./packages/react-sdk/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: build the Vite SPA ───────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @vexillo/web build

# ─── Stage 3: runtime (Bun) ────────────────────────────────────────────────
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# Install pnpm — start.sh invokes the workspace's drizzle-kit binary which
# pnpm places under packages/db/node_modules/.bin/.
RUN apk add --no-cache nodejs npm \
  && npm install -g pnpm@10.24.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/db ./packages/db
COPY --from=build /app/packages/react-sdk ./packages/react-sdk

COPY apps/api/start.sh ./start.sh
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

CMD ["./start.sh"]
