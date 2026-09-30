---
phase: 11-motor-de-deploy-fundamentos
plan: 04
subsystem: testing
tags: [fixtures, docker, qa-07, d-13]
requires: []
provides:
  - "fixtures/node-api: zero-dependency node:http server, digest-pinned node:22-alpine"
  - "fixtures/static-app: single static page, digest-pinned nginx:1.31-alpine"
  - "fixtures/failing-build: deterministic RUN failure (exit 42, NOODARA_FIXTURE_BUILD_FAILURE), digest-pinned node:22-alpine"
  - "tests/unit/fixtures/official-fixtures.test.ts: static guard for context size, digest pinning, .dockerignore and no-secrets"
affects: [11-08, 12]
tech-stack:
  added: []
  patterns: ["fixtures baked with no build args or env vars per v0.2's config surface (D13)"]
key-files:
  created:
    - fixtures/README.md
    - fixtures/node-api/Dockerfile
    - fixtures/node-api/.dockerignore
    - fixtures/node-api/package.json
    - fixtures/node-api/server.js
    - fixtures/static-app/Dockerfile
    - fixtures/static-app/.dockerignore
    - fixtures/static-app/index.html
    - fixtures/failing-build/Dockerfile
    - fixtures/failing-build/.dockerignore
    - tests/unit/fixtures/official-fixtures.test.ts
decisions:
  - "nginx base pinned as nginx:1.31-alpine@sha256:df221db8... (resolved 2026-09-29) instead of the untagged nginx:alpine, so the tag stays human-readable while the digest stays authoritative"
  - "node:22-alpine digest (sha256:0a7108bf...402) matches the one 11-03's harness already preloads into the registry mirror -- no digest drift since 2026-09-29"
metrics:
  duration: "~20 min"
  completed: 2026-09-29
  tasks: 2
  files: 11
---

# Phase 11 Plan 04: Official fixtures Summary

Three tiny, dependency-free fixtures for QA-07/D-13: `node-api` (zero-dependency `node:http` server, non-root user, port 3000), `static-app` (single static page on `nginx:alpine`), and `failing-build` (deterministic `RUN` failure with a fixed exit code and a recognizable marker for `classifyDockerError`). A static Vitest guard asserts every D-13 constraint (digest pinning, `.dockerignore` coverage, context size, no build args/secret-shaped env, no `:latest`) without needing Docker.

## Tasks

| Task | Commits | Notes |
|------|---------|-------|
| 1. Static guard (RED) | 587ee12 | 19 assertions across 6 test blocks; failed on missing `fixtures/` as expected |
| 2. Fixtures (GREEN) | a44f330 | all three build; functional smoke test passed for node-api |

## Verification

- `pnpm exec vitest run tests/unit/fixtures/official-fixtures.test.ts`: 19/19 passed
- `pnpm test` (full unit suite): 209 files, 3816 tests passed
- `pnpm typecheck`, `pnpm lint`: green (no change to typed/linted surfaces — fixtures are plain JS/Dockerfiles outside those targets, matching the existing pattern for `fixtures/`/`tests/unit/`)
- `docker build fixtures/node-api`: succeeds; ran the resulting container and confirmed `GET /` -> `{"service":"node-api","ok":true}`, `GET /health` -> `200 ok`, `GET /nope` -> `404`
- `docker build fixtures/static-app`: succeeds
- `docker build fixtures/failing-build`: fails with exit code 42 and stderr containing `NOODARA_FIXTURE_BUILD_FAILURE`
- Measured build-context sizes (well under the 1 MiB budget): node-api 16K, static-app 12K, failing-build 8K
- `grep -c "@sha256:" fixtures/*/Dockerfile` reports 1 per file
- No container, image or network labelled `noodara.test=true` left after verification

## Digest resolution (recorded in fixtures/README.md)

| Image | Tag | Digest |
|---|---|---|
| `node:22-alpine` | used by node-api and failing-build | `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402` |
| `nginx:1.31-alpine` | used by static-app | `sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2` |

## Deviations from Plan

None — plan executed as written. The node:22-alpine digest already matched the one 11-03's `resolveBaseImages()` default recorded, confirming no drift between the two plans' resolution dates.

## Known Stubs

None.

## Self-Check: PASSED

- All 11 created files exist on disk.
- Commits 587ee12 and a44f330 are present in `git log`.
