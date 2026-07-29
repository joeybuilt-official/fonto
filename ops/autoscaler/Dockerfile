# SPDX-License-Identifier: MIT
# Phase 9b — fonto-worker autoscaler image.
#
# Reuses the project root package.json to share bullmq + ioredis +
# tsx pins with the worker (single source of truth for queue protocol
# versions). The autoscaler container is tiny — just docker-cli +
# node:24-alpine + the source + the project deps it actually uses.
#
# Runtime requirements (operator wires via compose):
#   - /var/run/docker.sock mounted (or a docker-socket-proxy hostname
#     via DOCKER_HOST)
#   - compose file mounted at /etc/fonto-compose/docker-compose.yml
#     (override via AUTOSCALER_COMPOSE_FILE)
#
# Build:
#   docker build -f ops/autoscaler/Dockerfile -t fonto-autoscaler:dev .
#
# Run (dry-run, for verification before the operator wires the socket):
#   docker run --rm -e AUTOSCALER_DRY_RUN=1 \
#              -e REDIS_URL=redis://valkey:6379 \
#              fonto-autoscaler:dev

FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# docker-cli is the only runtime dep beyond node + the bundled tsx.
# The compose plugin ships with the cli on alpine.
RUN apk add --no-cache docker-cli docker-cli-compose
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 autoscaler
COPY --from=deps --chown=autoscaler:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=autoscaler:nodejs /app/packages ./packages
COPY --chown=autoscaler:nodejs ops/autoscaler ./ops/autoscaler
COPY --chown=autoscaler:nodejs package.json tsconfig.json ./
# Run as root so docker.sock access (which usually requires the docker
# group on the host) Just Works without us needing the host's GID. If
# you want to drop privileges, give the autoscaler user the host's
# docker GID at run time via `--group-add`.
USER root
CMD ["node_modules/.bin/tsx", "ops/autoscaler/index.ts"]
