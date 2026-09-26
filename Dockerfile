FROM node:22-alpine AS base
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
RUN npm install -g pnpm@10
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_APP_URL is a BUILD arg (Next.js inlines NEXT_PUBLIC_* at compile
# time), so it must be supplied by the caller — there is deliberately NO
# production default here. Omitting it yields the localhost default below,
# which makes a forgotten arg a visibly-broken deploy rather than one silently
# wired to somebody else's domain.
#
#   docker build --build-arg NEXT_PUBLIC_APP_URL=https://fonto.example.com .
#   docker compose build   # set NEXT_PUBLIC_APP_URL in .env — compose forwards it
ARG NEXT_PUBLIC_APP_URL=http://localhost:3500
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_OIDC_PROVIDER_ID=authentik
ENV NEXT_PUBLIC_OIDC_PROVIDER_ID=$NEXT_PUBLIC_OIDC_PROVIDER_ID
ENV NEXT_TELEMETRY_DISABLED=1
# `next build` on this app exceeds Node's ~2 GB default heap and dies with exit
# 134 ("Ineffective mark-compacts near heap limit"). 4096 is the floor that has
# worked; raise it via `--build-arg NODE_HEAP_MB=6144` on hosts with the RAM
# (CI uses 6144). Lowering it below ~4096 will OOM the build.
ARG NODE_HEAP_MB=4096
ENV NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_MB}"
ENV AUTH_DATABASE_URL="postgresql://stub:stub@localhost:5432/stub"
ENV AUTH_SECRET="build-time-stub"
ENV DATABASE_URL="postgresql://stub:stub@localhost:5432/stub"
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3500
ENV PORT=3500
CMD ["node", "server.js"]
