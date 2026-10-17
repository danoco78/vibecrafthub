FROM docker.io/library/node:24-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/scanner/package.json packages/scanner/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "api..."

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @vch/shared build \
    && pnpm --filter @vch/scanner build \
    && pnpm --filter api build \
    && pnpm --filter api deploy --prod --legacy /out

FROM docker.io/library/node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
