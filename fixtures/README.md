# Official fixtures (D-13)

Tiny, dependency-free fixtures used by the deploy-engine test harness (11-03) and Phase 12's
integration/E2E deploy flows. Every base image is pinned by `sha256` index digest so a build
never silently picks up a new upstream image; no fixture takes a build arg or an environment
variable — v0.2 has no `--build-arg`/`--env` support, so config is baked into the image.

## node-api

Zero-dependency `node:http` server on port 3000 (`GET /` -> `{"service":"node-api","ok":true}`,
`GET /health` -> `200 ok`). Runs as the non-root `node` user.

## static-app

Single static page served by `nginx:alpine`.

## failing-build

Fails deterministically at the first (and only) `RUN`, with a fixed `exit 42` and the
recognizable marker `NOODARA_FIXTURE_BUILD_FAILURE`, so `classifyDockerError` has a stable
scenario to test against.

## Pinned base images

Resolved with `docker buildx imagetools inspect <ref> --format '{{json .Manifest.Digest}}'` on
2026-09-29 (matches the digest 11-03's harness already preloads into the registry mirror):

| Image | Tag | Digest |
|---|---|---|
| `node:22-alpine` | used by `node-api` and `failing-build` | `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402` |
| `nginx:1.31-alpine` | used by `static-app` | `sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2` |

## Bumping a digest

1. `docker buildx imagetools inspect <image>:<tag> --format '{{json .Manifest.Digest}}'`.
2. Update the `FROM` line(s) in the affected fixture's Dockerfile(s) (`node-api` and
   `failing-build` share the `node:22-alpine` base and must move together).
3. Update this table with the new digest and today's date.
4. Re-run `pnpm exec vitest run tests/unit/fixtures/official-fixtures.test.ts` and rebuild each
   fixture locally to confirm it still builds.
