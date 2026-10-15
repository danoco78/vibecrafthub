FROM docker.io/library/node:24-alpine AS portal
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/portal/package.json apps/portal/
RUN pnpm install --frozen-lockfile --filter "portal..."

COPY apps/portal ./apps/portal
RUN pnpm --filter portal build

FROM docker.io/library/caddy:2-alpine
COPY apps/gateway/Caddyfile /etc/caddy/Caddyfile
COPY --from=portal /repo/apps/portal/dist /srv/portal
EXPOSE 80 443
