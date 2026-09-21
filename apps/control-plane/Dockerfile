# Production image for the Noodara control plane (D-01, ADR 0003, phase 4 D-23).
#
# One image, four entrypoints -- Docker Compose (Plan 06-07) runs this same image as `api`
# (`node dist/server.js`, the default CMD below), `worker` (`command: ["node", "dist/worker.js"]`),
# a one-shot `migrate` job (`command: ["node", "dist/db/migrate.js"]`) and, interactively, as the
# `noodara` operator CLI (`docker compose exec api node dist/cli/index.js ...`). No tsx, no source
# tree ships in the runner stage -- only compiled `dist/` output plus its node_modules tree.
#
# Build context is the REPO ROOT (not this directory): `docker build --file
# apps/control-plane/Dockerfile --tag <tag> .` from the repo root.
#
# Base: node:22-slim (debian-slim) on every stage -- matches package.json's `engines.node:
# ">=22.12.0"`; chosen over alpine for native-addon build headroom (argon2, ssh2's optional
# cpu-features) since this is the first production image this repo has ever shipped
# (06-RESEARCH.md "Alternatives Considered").

# ---- pruner: resolve the workspace subset @noodara/control-plane actually needs ----
FROM node:22-slim AS pruner
RUN corepack enable
WORKDIR /app
COPY . .
# `pnpm install` first (never an unpinned `n-p-x turbo` call) so the turbo binary invoked below
# comes from pnpm-lock.yaml's own locked tree, never an unpinned version resolved from the
# registry at build time (T-06-20). `--ignore-scripts`: this stage's node_modules is discarded
# after the prune step, so there is no reason to run argon2's native build here.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec turbo prune @noodara/control-plane --docker

# ---- installer: install dependencies only, cache-friendly across source-only changes ----
FROM node:22-slim AS installer
RUN corepack enable
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
# No separate `COPY .../pnpm-workspace.yaml` line: the Task 1 spike (turbo 2.10.12) confirmed
# `out/json/` already contains pnpm-workspace.yaml (with `onlyBuiltDependencies: [argon2]` and
# the react overrides intact), so the COPY above already carries it.
# Scripts enabled here (unlike the pruner stage): argon2's native binding must actually build
# against this image's own architecture (pnpm-workspace.yaml's `onlyBuiltDependencies: [argon2]`).
RUN pnpm install --frozen-lockfile

# ---- builder: full pruned source + turbo's task graph (^build across domain -> ssh -> app) ----
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
# Stamps apps/control-plane/package.json's `version` field so CONTROL_PLANE_VERSION
# (src/config-version.ts's `createRequire('../package.json')` read) reports the released tag
# through GET /health and GET /api/config instead of the placeholder 0.0.0 (T-06-21). Left empty,
# local/dev builds keep whatever version the repo already has.
ARG NOODARA_IMAGE_VERSION=""
RUN if [ -n "$NOODARA_IMAGE_VERSION" ]; then \
      cd apps/control-plane && pnpm pkg set version="$NOODARA_IMAGE_VERSION"; \
    fi
RUN pnpm exec turbo run build --filter=@noodara/control-plane

# ---- runner: non-root, compiled output only ----
FROM node:22-slim AS runner
WORKDIR /app
RUN groupadd --system noodara && useradd --system --gid noodara --home-dir /app noodara
# The WHOLE pruned workspace is copied (not just apps/control-plane/dist) deliberately: pnpm's
# isolated node_modules is a symlink tree rooted at /app/node_modules/.pnpm, so copying only
# apps/control-plane/dist would leave every workspace/dependency symlink dangling and the
# runtime `require`/import resolution broken. A future size optimisation must not undo this.
COPY --from=builder --chown=noodara:noodara /app /app
WORKDIR /app/apps/control-plane
ENV NODE_ENV=production
USER noodara
EXPOSE 3000
# No HEALTHCHECK here on purpose: the healthcheck lives in the production Compose file (Plan
# 06-07) so api/worker/migrate can share this one image with different health semantics.
CMD ["node", "dist/server.js"]
