---
phase: 11-motor-de-deploy-fundamentos
plan: 16
subsystem: deploy-engine
tags: [integration, git, docker, ssh-adapter, security]
requires: ["11-03", "11-04", "11-14", "11-15"]
provides:
  - "engine-primitives.test.ts: end-to-end composition proof of the Phase 11 primitives on Ubuntu 22.04 and 24.04"
affects: [12]
tech-stack:
  added: []
key-files:
  created:
    - tests/integration/deploy-engine/engine-primitives.test.ts
decisions:
  - "@noodara/git and @noodara/docker imported by relative source path: root package.json was outside the task scope, so the planned workspace devDependencies were not added"
  - "Test ids are UUIDv7 built from crypto.randomBytes (no new dependency)"
  - "ps sampling also reads /proc/<pid>/cmdline and environ, so argv and env are both covered"
metrics:
  completed: 2026-10-01
  tasks: 2
---

# 11-16 Summary: engine primitives compose end to end

## Done

- 3b01b1e: one suite per Ubuntu version, one stack each, everything through `createSsh2Adapter`
  -> `cloneRepository` / `@noodara/docker` wrappers.
  - Happy path: node-api cloned with the per-run deploy key (SHA = `git rev-parse main` in the bare
    repo), built as `noodara/<serviceId>:<deploymentId>`, run as `noodara-<serviceId>` on
    `noodara-net-<serviceId>`, port 13100 -> 3000, `/health` = `ok`. `docker ps` ->
    `toContainerObservation` -> `deriveServiceStatus` = RUNNING. The deployment walks
    QUEUED -> PREPARING -> BUILDING -> DEPLOYING -> SUCCESS via `transitionDeployment`.
  - DEP-08: LFS pointer and `.gitmodules` repos -> UNSUPPORTED_REPOSITORY_FEATURE ("Git LFS" /
    "Git submodules"); workspace removed.
  - D-09: failing-build as a second deployment of the same service -> BUILD_FAILED ("exit code 42",
    no raw stderr); the first container keeps its Id and StartedAt, its image stays, no new image,
    service still RUNNING.
  - D-10: registry pull with the htpasswd credential works; a random wrong password ->
    REGISTRY_AUTH_FAILED.
  - SEC: deploy key lines, login key lines, registry password and base64(user:pass) absent from
    ps + /proc cmdline/environ samples (taken during clone and login, overlap asserted), `.git/config`,
    `docker inspect`, `docker history --no-trunc`, every StreamChunk, tail and failure message.
  - D-14 teardown via wrappers: no noodara.managed / noodara.test container, network or image in
    the nested dockerd, `/opt/noodara-deploy` empty; on the host no noodara.test container or network.
- No primitive needed a fix.

## Timings (ms, one run)

| step | 22.04 | 24.04 |
|---|---|---|
| clone | 160 | 186 |
| build | 1579 | 1526 |
| network / create / start | 23 / 35 / 79 | 25 / 50 / 73 |
| inspect until running | 14 | 11 |
| docker ps | 17 | 15 |
| healthy | 28 | 33 |
| LFS / submodule reject | 160 / 166 | 191 / 196 |
| failing build | 170 | 183 |
| registry pull / reject | 69 / 20 | 73 / 19 |
| teardown | 224 | 227 |

## Verification

- `NOODARA_TEST_UBUNTU=all ... engine-primitives.test.ts`: 14/14 green; `pnpm test`, `typecheck`,
  `lint`, `boundaries` green (agent-flow gate).
- Not run: the whole `tests/integration/deploy-engine` directory (orchestrator limited the run to
  this file).

## Open

- Add `@noodara/git` / `@noodara/docker` as root `workspace:*` devDependencies and switch the
  imports to bare specifiers (needs package.json + pnpm-lock.yaml in scope).
