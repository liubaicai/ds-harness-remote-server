FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DSH_SERVER_HOST=0.0.0.0 \
    DSH_SERVER_PORT=8080 \
    DSH_SERVER_DATA_FILE=/data/state.json
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Production dependencies only: the runtime never needs the TypeScript toolchain.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
    && pnpm store prune \
    && chown -R node:node /app

COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node

# Fail the build early if the compiled entry graph cannot be resolved.
RUN node --input-type=module -e "await import('./dist/server.js')"

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.DSH_SERVER_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
