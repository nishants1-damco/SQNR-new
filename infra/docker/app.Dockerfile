# The API and worker images (plan §15): one Dockerfile, `--build-arg APP=api`
# or `APP=worker`. Built from the repository root:
#   docker build -f infra/docker/app.Dockerfile --build-arg APP=api -t spatial-api .
#
# The runtime image holds only the app's production dependencies (pnpm
# deploy) and runs as the unprivileged `node` user. The API image also runs
# database migrations: node node_modules/@spatial/db/dist/migrate.js
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG APP
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@spatial/${APP}...
RUN pnpm --filter=@spatial/${APP} deploy --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# API: 3000; worker: health endpoint on 3100.
EXPOSE 3000 3100
CMD ["node", "dist/main.js"]
