---
phase: 11-motor-de-deploy-fundamentos
plan: 12
subsystem: discovery
tags: [discovery, buildkit, docker, allowlist, tdd]
requires: ["11-05", "11-09", "11-10"]
provides:
  - "Discovery check id docker_buildkit and allowlisted template docker.buildkit (`docker build --help`, ADR 0008 G3)"
  - "DiscoveryFacts.dockerBuildkitAvailable, merged with the null-means-not-observed rule"
  - "servers.docker_buildkit_available written by connect-and-discover"
affects: [12]
tech-stack:
  added: []
  patterns: ["new discovery step reuses dockerNotInstalled skip flag", "only observed parser kinds set the fact"]
key-files:
  created: []
  modified:
    - packages/domain/src/discovery/types.ts
    - packages/domain/src/discovery/merge-facts.ts
    - packages/ssh/src/commands/docker.ts
    - packages/ssh/src/commands/allowlist.ts
    - packages/ssh/src/run-discovery.ts
    - apps/control-plane/src/services/connect-and-discover.ts
    - apps/web/src/lib/discovery-steps.ts
    - apps/web/src/lib/discovery-progress.ts
    - apps/web/src/components/DiscoveryStep.tsx
    - tests/e2e/discovery.spec.ts
    - tests/integration/ssh/discovery.test.ts
    - tests/integration/services/connect-and-discover.test.ts
decisions:
  - "Fact is true only for active, false for plugin_missing and buildkit_disabled; daemon_unreachable and unparseable leave it null"
  - "buildkit_disabled has its own message (remove DOCKER_BUILDKIT=0) and never names docker-buildx-plugin"
  - "A BuildKit fail is a usable-despite-failure warning in the UI and never a ServerErrorCode warning; server stays CONNECTED"
  - "No consequence copy added in DiscoveryStep for docker_buildkit: the check detail already carries the remediation"
metrics:
  completed: 2026-09-30
  tasks: 2
  files: 15
---

# Phase 11 Plan 12: BuildKit discovery check Summary

Discovery now runs `docker build --help` (ADR 0008 G3) as the 12th allowlisted command, reports `docker_buildkit` under the Docker step, and persists `dockerBuildkitAvailable` to `servers.docker_buildkit_available` with the D-07 null-never-overwrites rule.

## Commits

| Commit | Subject |
|---|---|
| 9074163 | test(11-12): add failing BuildKit discovery check tests |
| 6526db2 | feat(11-12): add docker_buildkit discovery check |
| cfc6c40 | test(11-12): add failing BuildKit fact persistence and grouping tests |
| 9c3f755 | feat(11-12): persist BuildKit fact and group it under Docker |

## Behaviour

| Parser result | Status | Detail | Fact |
|---|---|---|---|
| active | pass | `BuildKit is available.` | true |
| plugin_missing | fail | `BuildKit is not available: install docker-buildx-plugin (sudo apt-get install docker-buildx-plugin) to deploy Dockerfile services.` | false |
| buildkit_disabled | fail | `BuildKit is disabled by DOCKER_BUILDKIT=0 in the environment. Remove that setting to deploy Dockerfile services.` | false |
| daemon_unreachable | fail | `Could not check BuildKit: the Docker daemon is unreachable.` | null |
| unparseable | fail | `BuildKit status could not be determined: <reason>` | null |
| docker not installed | skipped (not executed) | `Skipped: Docker is not installed on this server.` | null |

No ServerErrorCode warning is ever added, so a server without BuildKit stays CONNECTED (verified in integration). Rejecting Dockerfile services is left to Phase 12.

## Verification

- `pnpm exec vitest run packages/domain/src/discovery packages/ssh`: 386 passed
- `pnpm test`: 214 files, 3946 tests passed
- `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`: green
- `tests/integration/services/connect-and-discover.test.ts`: 34 passed
- `tests/integration/ssh/discovery.test.ts`: 16 passed (22.04 and 24.04; the docker-CLI image without buildx fails the check with the apt-get message; the plain image skips it)
- `pnpm exec playwright test tests/e2e/discovery.spec.ts`: 13 passed
- `grep -c dockerBuildkitAvailable apps/control-plane/src/services/server-view.ts` = 0 (not exposed in the API)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] E2E mid-run test encoded the 11-check sequence**
- **Found during:** Task 2
- **Issue:** `@discovery a page that joins mid-run...` dispatched only docker_version and docker_compose_version and expected Docker resolved and sudo running; with docker_buildkit next in order, Docker stayed running.
- **Fix:** the spec also dispatches docker_buildkit; the Docker-not-installed fixture marks docker_buildkit skipped, matching real behaviour.
- **Files modified:** tests/e2e/discovery.spec.ts
- **Commit:** 9c3f755

**2. [Rule 1 - Bug] Integration access-matrix test assumed every non-access check passes**
- **Found during:** Task 2 (RED)
- **Issue:** the docker-CLI fixture image has no docker-buildx-plugin, so docker_buildkit fails there.
- **Fix:** excluded docker_buildkit from that loop and added a dedicated test asserting the actionable fail on that image.
- **Commit:** cfc6c40

**3. Comment-only update in DiscoveryStep.tsx** stating why docker_buildkit has no consequence line (the previous comment claimed every warning id had one).

### Notes

- Task 1's GREEN commit (6526db2) left `apps/control-plane` failing typecheck until Task 2's GREEN (9c3f755), as the plan split the work; the integration RED for Task 2 failed at the global build step for the same reason.
- Pre-existing files touched are not Prettier-clean at HEAD; they were not reformatted to avoid churn. ESLint via `pnpm lint` is green. No files were created by this plan.
- `git stash list` was run once by mistake while chaining commands (read-only listing, no stash created, applied or dropped).

## Known Stubs

None.

## Self-Check: PASSED
