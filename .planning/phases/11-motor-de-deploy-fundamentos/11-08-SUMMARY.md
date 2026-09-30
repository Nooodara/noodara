---
phase: 11-motor-de-deploy-fundamentos
plan: 08
subsystem: testing
tags: [docker, registry, fixtures, qa-07, captures, buildkit]
requires: ["11-03", "11-04"]
provides:
  - "tests/integration/deploy-engine/fixtures.test.ts: QA-07 proof of the official fixtures and of registry auth on the real fixture"
  - "packages/ssh/src/fixtures/deploy-errors/ubuntu-*/docker-*.txt (12) + DOCKER.md, for classifyDockerError (11-11)"
affects: [11-11, 12]
tech-stack:
  added: []
  patterns: ["registry password only on channel stdin; ps -eo args sampled while login blocks on stdin", "image identity across push+pull compared by RootFS diff IDs, not .Id"]
key-files:
  created:
    - tests/integration/deploy-engine/fixtures.test.ts
    - packages/ssh/src/fixtures/deploy-errors/DOCKER.md
    - packages/ssh/src/fixtures/deploy-errors/ubuntu-{22.04,24.04}/docker-*.txt (12)
  modified: []
decisions:
  - "Pull identity is asserted via RootFS.Layers: with the containerd image store .Id is the index/manifest digest and changes after push+pull of a single-platform image"
  - "Authorised pull is proven by `Status: Downloaded newer image for <ref>` plus a registry digest; `Pull complete` is not guaranteed because layers stay in the content store (shared with static-app)"
  - "Docker CLI exits 1 for every captured failure except the port clash (125); classifyDockerError must key on stderr, and the build's own exit (42) exists only in stderr"
metrics:
  duration: "~2 sessions (interrupted); resume ~15 min"
  completed: 2026-09-30
  tasks: 2
  files: 14
---

# Phase 11 Plan 08: Official fixtures and registry auth on the real fixture Summary

QA-07 is proven on 22.04 and 24.04. The three official fixtures are cloned over SSH with the deploy key, built by the nested dockerd with a real BuildKit context of at most 1.10 kB, and the two working ones answer HTTP in under 250 ms. `failing-build` fails the same way on every run. A real pull through the htpasswd registry is denied without login and with a wrong password, then succeeds after `docker login --password-stdin`. Six classes of real docker failure are captured per version.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1. Official fixtures built and run | 902e2f3 | 3 tests per Ubuntu + suite-level stray check |
| 2. Registry auth + docker failure captures | c586509 | 4 tests per Ubuntu; 12 captures + DOCKER.md |

## Measurements

Docker server 29.8.1, buildx v0.37.1 on both versions (git 2.34.1 / 2.43.0). Values come from the final normal-mode run (capture run in parentheses). The context is parsed from the BuildKit `transferring context` line of the `load build context` step.

| Fixture | Ubuntu | Context bytes | Build ms | Time-to-healthy ms |
|---|---|---|---|---|
| node-api | 22.04 | 1100 | 414 (514) | 176 (186) |
| node-api | 24.04 | 1100 | 387 (384) | 186 (170) |
| static-app | 22.04 | 231 | 199 (246) | 154 (141) |
| static-app | 24.04 | 231 | 233 (187) | 145 (150) |
| failing-build | 22.04 | 0 (no COPY/ADD, no context step) | 184, 180 (209, 169); CLI exit 1, `exit code: 42` | n/a |
| failing-build | 24.04 | 0 | 190, 177 (171, 199); CLI exit 1, `exit code: 42` | n/a |

Builds are warm: base images are preloaded, so build ms is BuildKit plus the layer work only.

Registry (both versions): unauthorised pull exit 1, wrong login exit 1, right login exit 0, authorised pull exit 0 in 24-32 ms, `pulledLayers` 0, `sameImageId` false, `sameLayers` true, missing image exit 1.

Test runs (single file, `tests/integration/deploy-engine/fixtures.test.ts`, 7 tests per version):

| Run | 22.04 | 24.04 |
|---|---|---|
| Capture (`NOODARA_CAPTURE_FIXTURES=1`) | 7/7 pass, 95.96 s | 7/7 pass, 90.45 s |
| Normal | 7/7 pass, 95.75 s | 7/7 pass, 34.46 s |

The 24.04 wall time varies with how many stack images Docker Desktop has cached.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Wrong assertions on the authorised pull**
- **Found during:** Task 2 (resume run, 22.04)
- **Issue:** The interrupted executor's draft asserted `Pull complete` and `pulledId === imageId`. Neither holds. Layers stay in the content store after `docker rmi` because static-app shares them, and `.Id` changes after push+pull under the containerd store. The pull itself succeeded through auth.
- **Fix:** Assert the registry digest and `Status: Downloaded newer image for <ref>`, and assert equal `RootFS.Layers` before and after.
- **Files modified:** tests/integration/deploy-engine/fixtures.test.ts
- **Commit:** c586509

**2. [Rule 3 - Blocking] DOCKER.md missing**
- Not written by the interrupted executor. Written on resume from the live marker regexes.

## Interruption and resume

- The previous executor committed Task 1 (902e2f3) and left Task 2 uncommitted: a +198/-1 test diff and 12 captures. DOCKER.md did not exist. The session ended mid-run. Docker Desktop had crashed once and the orchestrator restarted it.
- I kept the draft. Its structure matched the plan: stdin-only passwords, ps sampling, scrubbing, and capture/normal modes. I fixed the two wrong assertions and re-captured all 12 files on both versions, so every committed capture comes from this session's real runs.
- The crash left behind a network and a volume labelled `noodara.test=true`: `noodara-deploy-engine-8ffe7b5e-...`, created at 04:36 UTC by the interrupted session, with 0 containers. I removed both by explicit name. After that, no container, network, volume or image with the label remains.

## TDD Gate Compliance

These are contract tests against fixtures that already existed (11-04, a44f330) and a real registry. No production code is written in this plan, so there is no `feat` commit. Task 1 was **not** verified RED-then-GREEN in git history: 902e2f3 is a single `test` commit made after the fixtures existed. Task 2 is the same. The only "red" seen was the real failure of the draft assertions described above.

## Threat model

- T-11-22: password is only written to the channel's stdin. `ps -eo pid,args` is sampled while `docker login --password-stdin` is alive, and neither the right nor the wrong password appears.
- T-11-23: every capture and live stdout is checked for the password, the base64 `user:password` and the wrong password. The registry username is scrubbed.
- T-11-24: the context is at most 1100 bytes, measured from real BuildKit output.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND tests/integration/deploy-engine/fixtures.test.ts, DOCKER.md, 12 capture files (each first line `# exit=`)
- FOUND commits 902e2f3, c586509
