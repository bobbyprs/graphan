# syntax=docker/dockerfile:1.7
# Build context: repository root  (docker build -f apps/server/Dockerfile .)

FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# ── Dependencies (cached on lockfile) ──
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci -w apps/server --include-workspace-root --no-audit --no-fund

# ── Build ──
FROM deps AS build
COPY apps/server apps/server
RUN npm run build -w apps/server \
 && npm prune --omit=dev -w apps/server --include-workspace-root --no-audit --no-fund \
 && mkdir -p apps/server/node_modules   # npm may hoist everything to the root; keep the COPY below valid

# ── Runtime ──
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    SQLITE_BASE_DIR=/data/sqlite
RUN mkdir -p /data/sqlite && chown -R node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/dist-seed ./apps/server/dist-seed
COPY --from=build --chown=node:node /app/apps/server/prisma ./apps/server/prisma
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
WORKDIR /app/apps/server
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run separately (compose "migrate" service / k8s Job); see docs/DEPLOYMENT.md
CMD ["node", "dist/index.js"]
