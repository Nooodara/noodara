---
phase: 11-motor-de-deploy-fundamentos
plan: 03
subsystem: testing
tags: [testcontainers, docker, ssh, git, registry, ci, fixtures]
requires: []
provides:
  - "tests/integration/images/sshd-dockerd-ubuntu-{22.04,24.04}: sshd + nested dockerd (install.sh package set) + bare Git host"
  - "tests/integration/helpers/deploy-engine.ts: startDeployEngineStack, DEPLOY_ENGINE_UBUNTU_VERSIONS, DEPLOY_HOST_ALIAS, GIT_HOST_ALIAS, REGISTRY_ALIAS, MIRROR_ALIAS, resolveBaseImages, preloadedRefFor"
  - "tests/integration/helpers/registry.ts: startAuthRegistry, startBaseImageMirror, generateRegistryCredentials, REGISTRY_IMAGE"
  - "tests/integration/helpers/deploy-keys.ts: generateDeployKeyPair"
affects: [11-04, 11-06, 11-07, 11-08, 11-14, 11-15]
tech-stack:
  added: []
  patterns: ["cleanup stack run in reverse on stop() or on partial start failure", "secrets to exec via a 0600 temp file redirected to stdin, removed in finally"]
key-files:
  created:
    - tests/integration/images/sshd-dockerd-common/entrypoint.sh
    - tests/integration/images/sshd-dockerd-common/setup-git-host.sh
    - tests/integration/images/sshd-dockerd-ubuntu-22.04/Dockerfile
    - tests/integration/images/sshd-dockerd-ubuntu-24.04/Dockerfile
    - tests/integration/helpers/deploy-engine.ts
    - tests/integration/helpers/deploy-keys.ts
    - tests/integration/helpers/registry.ts
    - tests/integration/deploy-engine/harness.test.ts
    - tests/integration/deploy-engine/tsconfig.json
  modified:
    - tests/integration/images/sshd-common/setup-users.sh
    - package.json
    - .github/workflows/ci.yml
    - .github/workflows/nightly.yml
decisions:
  - "G7: pull-through mirror (registry:2 proxying mirror.gcr.io) as the nested dockerd's registry-mirrors, alongside the unchanged D-10 htpasswd registry; fallback to registry-1.docker.io if mirror.gcr.io does not answer /v2/"
  - "Base images until 11-04: node:22-alpine and nginx:alpine pinned by index digest (2026-09-29); resolveBaseImages() switches to fixtures/*/Dockerfile FROM lines once they exist"
  - "Nested dockerd storage on a labelled named volume (as installer-dind), removed on stop()"
  - "Network created through the runtime client with label noodara.test=true (Testcontainers Network cannot take custom labels)"
metrics:
  duration: "~15 min"
  completed: 2026-09-29
  tasks: 3
  files: 13
---

# Phase 11 Plan 03: Deploy-engine test harness Summary

One `startDeployEngineStack({ ubuntu })` call gives a privileged Ubuntu host with sshd and install.sh's exact Docker packages (buildx included), a bare Git repo over SSH gated by a per-run deploy key under `git.noodara-test.internal` (passes the 11-02 D-06 validator), the D-10 htpasswd registry preloaded with digest-pinned bases, and the G7 mirror. Everything is labelled `noodara.test=true` and removed on `stop()`.

## Tasks

| Task | Commits | Notes |
|------|---------|-------|
| 1. sshd+dockerd images | 5d4a86c | both images build; Dockerfiles differ only on FROM |
| 2. Helpers + harness | RED 15fbf0e, GREEN 2a4194e | 6 tests per Ubuntu version |
| 3. CI matrix (D-11) | 7ae0bb0 | PR 24.04, main/nightly all; network leak check |

## Verification

- `NOODARA_TEST_UBUNTU=24.04 ... harness.test.ts`: 6/6 passed (98s first run, 34s re-run)
- `NOODARA_TEST_UBUNTU=22.04 ... harness.test.ts`: 6/6 passed (92s)
- RED confirmed: suite failed on the missing helper import before GREEN
- `pnpm typecheck` green (new tsconfig included); `pnpm exec vitest run tests/unit`: 46 files, 1075 tests passed; `check-workflow-pins` clean
- No container, network or volume labelled `noodara.test=true` left after every run
- `packages/ssh/src/testing/generate-keys.ts` unchanged

## G7 findings

- Choice: pull-through mirror (plan default), selected by the orchestrator on 2026-09-29 during an autonomous run; pending explicit user confirmation at the ADR 0008 review.
- What worked: mirror.gcr.io was reachable (every run used it, no fallback). It returned the same index digest as Docker Hub for `node:22-alpine` (`sha256:0a7108bf...`). Both digest-pinned bases were pulled by the nested dockerd through the mirror; the mirror's `/v2/_catalog` listed `library/node` and `library/nginx`. Tag + push to the htpasswd registry and a later `docker login --password-stdin` + pull all worked. No digest drift was observed for the pinned refs.
- Stack start times (`startDeployEngineStack` only, arm64 Docker Desktop, image layers cached, mirror always cold since it is a fresh container each run):
  - 22.04: 29.5s, 24.5s
  - 24.04: 88.5s (first run of the pair, outlier, cause not isolated), 25.0s
  - Cold image build (`docker build --no-cache`): 22.04 36s, 24.04 33s. A fully cold start is roughly build + ~25-30s.
- stop(): ~2-2.5s.

## Deviations from Plan

1. **[Rule 3 - Blocking] `sshd-common/setup-users.sh` ran `groupadd docker` unconditionally.** docker-ce already creates that group, so the build failed (exit 9). It now skips creation if the group exists. The plain sshd images behave the same as before. Commit 5d4a86c.
2. **setup-users.sh needs `/keys/*.pub`.** The new Dockerfile creates throwaway keys, runs the script, then deletes `/keys` and empties every authorized_keys, all in one RUN. No key material ends up in any layer.
3. **Harness uses `beforeAll`/`afterAll` instead of `afterEach`.** The stack is started once per Ubuntu version because each start takes 25s or more. `afterAll` stops it and then asserts that no containers or networks are left over.
4. **Extra `exec` option `timeoutMs` and extra stack field `mirrorUpstream`.** Both are additive and do not change the interface contract. `mirrorUpstream` records which upstream the G7 mirror actually used.
5. **htpasswd uses `-Bin` (password on stdin) instead of `-Bbn`.** With `-Bbn` the password would appear in argv.
6. **CI timeout +5 min (45 to 50), not the cost of one 24.04 run +50%.** Main runs both versions, so it is sized for two runs.
7. **Formatted my new TS files with `packages/config/prettier.config.js`.** Existing helpers are not Prettier-clean, so no other file was touched.

## Known Stubs

- `DEFAULT_BASE_IMAGES` in deploy-engine.ts are used until 11-04 adds `fixtures/*/Dockerfile`. After that, `resolveBaseImages()` reads their digest-pinned FROM lines.

## Self-Check: PASSED

- All 9 created files exist; commits 5d4a86c, 15fbf0e, 2a4194e and 7ae0bb0 are in `git log`.
