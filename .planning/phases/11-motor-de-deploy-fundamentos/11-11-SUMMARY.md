---
phase: 11-motor-de-deploy-fundamentos
plan: 11
subsystem: ssh
tags: [git, docker, error-classification, captures, security, tdd]
requires: ["11-01", "11-06", "11-08"]
provides:
  - "GIT_ERROR_CLASSIFICATION_RULES, classifyGitError, GitFailureInput, RemoteFailure"
  - "DOCKER_ERROR_CLASSIFICATION_RULES, classifyDockerError, DockerFailureInput"
  - "Shared helpers safeField/safeStderr/safeExitCode and DeploymentClassificationRule type (git-error-classifier.ts)"
affects: [11-15, 12]
tech-stack:
  added: []
  patterns: ["frozen ordered rule table with named terminal fallback (copied from classifySshError)", "fixed-template messages + parsed numbers, then Redactor"]
key-files:
  created:
    - packages/ssh/src/git-error-classifier.ts
    - packages/ssh/src/git-error-classifier.test.ts
    - packages/ssh/src/docker-error-classifier.ts
    - packages/ssh/src/docker-error-classifier.test.ts
  modified: []
decisions:
  - "Git and Docker rules key on stderr text only; exit codes are never a classification signal (git 128 for every case, docker 1/125)"
  - "The feature-probe rule is the first named entry of the git table; supported, unparseable or empty-feature probes fall to CLONE_FAILED"
  - "Docker image-not-found only matches daemon wording (manifest unknown / failed to resolve reference ...: not found) so a build log line `sh: x: not found` stays BUILD_FAILED"
  - "BUILDKIT_UNAVAILABLE also matches the measured legacy-builder stderr `Install the buildx component to build images with BuildKit` (ADR 0008 G3 capture)"
  - "Classifiers are not exported from @noodara/ssh's index (public surface unchanged); 11-15 decides the export"
metrics:
  completed: 2026-09-30
  tasks: 2
  files: 4
---

# Phase 11 Plan 11: git and docker error classifiers Summary

`classifyGitError` and `classifyDockerError` are frozen, ordered, never-throwing rule tables (same triple try/catch as `classifySshError`) that map every real 11-06/11-08 failure capture of Ubuntu 22.04 and 24.04 to the closed `DeploymentErrorCode` vocabulary with actionable English messages built from fixed templates and parsed numbers, then redacted.

## Commits

| Commit | Subject |
|---|---|
| 15431dc | test(11-11): add failing git error classifier tests |
| 766b7e1 | feat(11-11): add git error classifier |
| d967617 | test(11-11): add failing docker error classifier tests |
| 00fe901 | feat(11-11): add docker error classifier |

## Rule tables

Git (in order): `unsupported-repository-feature`, `disk-full`, `repository-auth-failed`, `repository-host-unreachable`, `repository-not-found`, `branch-not-found`, `unclassified-fallback` (CLONE_FAILED).

Docker (in order): `docker-unavailable`, `buildkit-unavailable`, `disk-full`, `registry-auth-failed`, `image-not-found`, `dockerfile-not-found`, `port-in-use`, `build-step-failed`, `build-unclassified` (BUILD_FAILED), `image-unclassified` (pull/login -> IMAGE_PULL_FAILED), `unclassified-fallback` (START_FAILED).

## Verification

- `pnpm exec vitest run packages/ssh`: 13 files, 253 tests passed (git classifier 28, docker classifier 39).
- Coverage of the two new files (not gated for packages/ssh): git 92.98% statements / 95.83% branches; docker 95.16% / 88.23%. Uncovered lines are the defensive per-rule catch, the unreachable post-loop return and the outer catch.
- eslint and `tsc --noEmit` on packages/ssh: clean. `pnpm boundaries`: no issues. Integration suite not run (out of scope).

## Deviations from Plan

1. **[Captures over plan] Auth marker** follows the capture: `/Permission denied \(publickey[,)]/` (the fixture sshd lists `publickey,password,keyboard-interactive`); a GitHub-style `(publickey)` test is included.
2. **[Captures over plan] Extra BuildKit marker**: besides the two plan strings, the real discovery capture `docker_buildkit.plugin_missing` stderr (`Install the buildx component to build images with BuildKit`) is classified BUILDKIT_UNAVAILABLE.
3. **[Rule 2 - Correctness] Scoped image-not-found**: the DOCKER.md marker `/manifest unknown|not found/` is too broad for build logs; the rule uses daemon wording only, covered by a regression test.
4. **[Rule 2] DOCKER_UNAVAILABLE also matches** `permission denied while trying to connect to the Docker daemon socket` (deploy user outside the docker group).
5. The plan's `ctx` type is named `ClassifyDeploymentContext`; shared helpers and the rule type live in `git-error-classifier.ts` and are reused by the docker classifier.
6. The GREEN git commit also removed a redundant type assertion in the RED test file (lint), no assertion changed.

## Threat model

T-11-29 mitigated: messages contain no remote text; tests assert no capture line, hostname or registered secret appears. T-11-30 mitigated: hostile getters, non-object inputs, 8 MiB / binary stderr and a throwing redactor all return a closed code.

## Known Stubs

None.

## Self-Check: PASSED

All four created files exist and commits 15431dc, 766b7e1, d967617, 00fe901 are in git log.
