# syntax=docker/dockerfile:1.7
# Build context: repository root  (docker build -f apps/web/Dockerfile .)

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci -w apps/web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# Rendered by the image's envsubst step at startup (only defined env vars are replaced, so $uri etc. are untouched)
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
# Origins allowed to iframe /embed/* (space-separated). Empty = same origin only.
ENV EMBED_FRAME_ANCESTORS=""
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/nginx-health || exit 1
