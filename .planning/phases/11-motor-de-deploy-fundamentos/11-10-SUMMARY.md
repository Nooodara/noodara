---
phase: 11-motor-de-deploy-fundamentos
plan: 10
subsystem: domain
tags: [docker, parsers, ndjson, buildkit, captures, tdd]
requires: ["11-01", "11-07"]
provides:
  - "parseDockerPsOutput, toContainerObservation, ObservedContainer (deployment)"
  - "parseContainerState, DOCKER_CONTAINER_STATES, DockerContainerState (deployment)"
  - "parseBuildKitStatus, BuildKitStatus (discovery)"
affects: [11-12, 11-15, 12]
tech-stack:
  added: []
  patterns: ["per-line NDJSON parsing with isolated bad lines", "never-throw typed union parsers over real captures"]
key-files:
  created:
    - packages/domain/src/deployment/docker-ps.ts
    - packages/domain/src/deployment/container-state.ts
    - packages/domain/src/discovery/buildkit.ts
    - packages/domain/src/deployment/docker-ps.test.ts
    - packages/domain/src/deployment/container-state.test.ts
    - packages/domain/src/discovery/buildkit.test.ts
  modified:
    - packages/domain/src/deployment/index.ts
    - packages/domain/src/discovery/index.ts
decisions:
  - "BuildKit active is decided only by the first stdout line of `docker build --help` (`Usage:  docker buildx build`, two spaces); no version is derivable, so active.version is always null"
  - "The DOCKER_BUILDKIT=0 capture gets its own kind `buildkit_disabled` (stderr marker) instead of plugin_missing"
metrics:
  completed: 2026-09-30
  tasks: 2
  files: 8
---

# Phase 11 Plan 10: docker ps, container state and BuildKit parsers Summary

Three pure, never-throwing parsers proven against the real 11-07 captures of Ubuntu 22.04 and 24.04: the `docker ps` NDJSON parser (with `toContainerObservation` feeding `deriveServiceStatus`), the `docker inspect .State` parser, and the BuildKit detector based on `docker build --help`.

## Commits

| Commit | Subject |
|---|---|
| 85b039f | test(11-10): add failing docker ps and container state parser tests |
| 390d63e | feat(11-10): add docker ps and container state parsers |
| ac88ea9 | fix(11-10): satisfy lint rules in docker ps parser |
| 01850af | test(11-10): add failing BuildKit status parser tests |
| 98f0401 | feat(11-10): add BuildKit status parser |
| 90d51ec | style(11-10): format BuildKit parser test |

## Verification

- `pnpm exec vitest run packages/domain`: 30 files, 1081 tests passed.
- Coverage on the three new files: 100% statements (88/88), 100% branches (71/71).
- `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`: clean. Integration suite not run (out of scope).

## Deviations from Plan

1. **[Rule 1 - Captures over plan] `buildkit_disabled` kind added.** The G3 `legacy_env` capture (usage line `docker build`, stderr "BuildKit is currently disabled") would otherwise be reported as `plugin_missing`, a wrong remediation. The union is extended with `{ kind: 'buildkit_disabled' }`; the 11-12 discovery check must handle it. `plugin_missing` is returned for the legacy usage line without that stderr marker.
2. **[Captures] `active.version` is always `null`**: `docker build --help` carries no version.
3. **[Captures] G4 shapes honored**: `Platform` object ignored, `Ports` kept as the raw string (decoded `->`), `Command`/`Size`/`Networks` not consumed.
4. **[Rule 1 - Bug] Lint fixes**: first GREEN commit (390d63e) had lint errors (dot-notation, template number); fixed in ac88ea9. That GREEN commit also contains prettier reformatting of the two test files from the RED commit (formatting only, no assertion changes). The BuildKit test formatting landed in a separate style commit (90d51ec).
5. `parseDockerPsOutput` checks the exit code first: non-zero exit with 127 -> unparseable, daemon message -> daemon_unreachable, other non-zero -> unparseable.

## Known Stubs

None.

## Self-Check: PASSED

All six created files exist and all six commits are in git log.
