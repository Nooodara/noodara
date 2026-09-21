# Production image for the Noodara web app (D-01, ADR 0006).
#
# NOODARA_API_ORIGIN is a BUILD-TIME constant baked into this image: Next.js evaluates
# `rewrites()` (apps/web/next.config.ts) only once, at `next build` -- the standalone server never
# re-reads next.config.ts at runtime (06-RESEARCH.md Pattern 8, Context7-verified against
# /vercel/next.js). Its value must be the production Compose-internal address of the `api` service
# (the fixed literal `http://api:3000` the release workflow, Plan 06-13, always uses) -- a wrong
# value here does not fail the build, it produces confusing runtime 502s on every /api/* request
# (06-RESEARCH.md Pitfall 3), which is why tests/integration/installer/web-image.test.ts proves a
# real proxied request end to end rather than trusting a successful build alone.
#
# Build context is the REPO ROOT (not this directory): `docker build --file apps/web/Dockerfile
# --build-arg NOODARA_API_ORIGIN=http://api:3000 --tag <tag> .` from the repo root.
#
# Base: node:22-slim on every stage -- matches apps/control-plane/Dockerfile's own choice. This
# app has no native addons of its own, but keeping one base image across every image this repo
# publishes avoids a second base-image security-update surface for no benefit.

# ---- pruner: resolve the workspace subset @noodara/web actually needs ----
FROM node:22-slim AS pruner
RUN corepack enable
WORKDIR /app
COPY . .
# `pnpm install` first (never an unpinned `npx turbo` call), matching apps/control-plane/Dockerfile
# (T-06-20). `--ignore-scripts`: this stage's node_modules is discarded after the prune step.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec turbo prune @noodara/web --docker

# ---- installer: install dependencies only, cache-friendly across source-only changes ----
FROM node:22-slim AS installer
RUN corepack enable
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# ---- builder: full pruned source + turbo's task graph, NOODARA_API_ORIGIN baked into rewrites() ----
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
# No default: an empty value makes apps/web/next.config.ts's readApiOrigin() throw and the build
# fail loudly (T-06-25) -- the release workflow (Plan 06-13) is the only place this is ever set.
ARG NOODARA_API_ORIGIN
ENV NOODARA_API_ORIGIN=$NOODARA_API_ORIGIN
RUN pnpm exec turbo run build --filter=@noodara/web

# ---- runner: non-root, standalone server output only ----
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# NOODARA_API_ORIGIN must ALSO be a runtime environment variable, not only a builder-stage build
# arg: unlike next.config.ts's rewrites() (evaluated once at `next build`), apps/web/src/proxy.ts
# (the Next.js 16 "proxy" middleware convention) and apps/web/src/app/api/events/route.ts both call
# `process.env.NOODARA_API_ORIGIN` at REQUEST time, inside the running standalone server process --
# discovered by reading both files before writing this Dockerfile, and confirmed for real by
# tests/integration/installer/web-image.test.ts's own RED run (an unauthenticated `/` request
# 500'd before this ARG/ENV pair was added here, because proxy.ts's own fail-fast check has no
# runtime value to read). The value re-declared here is the identical constant the builder stage
# already baked into rewrites() -- the same `--build-arg NOODARA_API_ORIGIN=...` flag supplies both
# stages, so this is not a second, independently-settable source of truth.
ARG NOODARA_API_ORIGIN
ENV NOODARA_API_ORIGIN=$NOODARA_API_ORIGIN
RUN groupadd --system nodejs && useradd --system --gid nodejs --home-dir /app nodejs
RUN mkdir .next && chown nodejs:nodejs .next
# apps/web/public/ does not currently exist in this repo (confirmed by directory listing,
# 06-RESEARCH.md Pattern 10) -- the standard `COPY .../public ./public` line from Next's own
# example Dockerfile is deliberately omitted here. Do not "fix" this by adding it back.
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
USER nodejs
EXPOSE 3000
# No HEALTHCHECK here on purpose: it lives in the production Compose file (Plan 06-07), matching
# apps/control-plane/Dockerfile's own precedent.
CMD ["node", "apps/web/server.js"]
