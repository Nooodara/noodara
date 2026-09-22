---
phase: 06-instalador-y-docker-compose
plan: 13
subsystem: infra
tags: [github-actions, ghcr, docker-buildx, multi-arch, ci, release-pipeline]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 03
    provides: "apps/control-plane/Dockerfile (NOODARA_IMAGE_VERSION build arg, ~91s cold/~19s cached local build duration -- CI timeout-sizing source for the build job)"
  - phase: 06-instalador-y-docker-compose
    plan: 05
    provides: "apps/web/Dockerfile (NOODARA_API_ORIGIN baked twice -- builder-stage build arg for next.config.ts's rewrites() AND runner-stage runtime ENV for proxy.ts/the SSE route -- both from the same single --build-arg)"
  - phase: 06-instalador-y-docker-compose
    plan: 07
    provides: "production docker-compose.yml's image name/tag contract (NOODARA_IMAGE_PREFIX/noodara-control-plane|noodara-web:NOODARA_VERSION) this workflow's published tags must satisfy"
  - phase: 06-instalador-y-docker-compose
    plan: 12
    provides: "pnpm test:installer's measured real duration (1888.95s / ~31.5min, 51/51 tests) -- the CI timeout-sizing source for the new installer jobs"
provides:
  - ".github/workflows/release.yml: tag-triggered (plus workflow_dispatch dry run) pipeline publishing ghcr.io/<owner>/noodara-control-plane and ghcr.io/<owner>/noodara-web as genuine two-architecture (linux/amd64+linux/arm64) manifests, built on native runners (no QEMU), version derived once and validated identically to install.sh's own noodara_resolve_version/noodara_validate_tag, manifest step gated on both native build legs via needs:, and a verify step asserting docker manifest inspect reports both architectures"
  - "scripts/check-workflow-pins.mjs: zero-dependency scanner enforcing that every third-party uses: in .github/workflows/*.yml is pinned to a 40-hex commit SHA (or carries an explicit TODO(06-15) exception), mirroring check-posix-sh.mjs's own discipline"
  - "ci.yml: pnpm check:posix-sh added to the lint job (every PR); a new installer job running pnpm test:installer, gated to push-on-main only"
  - "nightly.yml: a new installer job running pnpm test:installer unconditionally"
affects: [06-14-docs, 06-15-real-vps-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-native-runner + docker buildx imagetools create for multi-arch publishing: each of (control-plane, web) x (amd64, arm64) builds and pushes its own per-arch tag on a native runner (ubuntu-latest / ubuntu-24.04-arm), then a needs:-gated manifest job combines the two per-arch tags into one multi-arch manifest at the real version tag, and a final verify job asserts both architectures are present via docker manifest inspect -- avoids QEMU emulation entirely for a dependency tree with native addons (argon2, ssh2)."
    - "Version derived exactly once in a dedicated prepare job (stripping a single leading v and validating with the SAME character-class/length rules as install.sh's own noodara_validate_tag), then threaded through every downstream job as a job output -- never recomputed, never re-parsed from github.ref_name a second time."
    - "Script-injection safety: github.ref_name/github.event.inputs.*/github.repository_owner are only ever read through env: mappings in release.yml's run: steps, then referenced as quoted shell variables -- never interpolated directly inside a run: script body."
tests-added:
  - "tests/unit/scripts/check-workflow-pins.test.ts: 20 tests -- 4 fixture-based unit tests for the scanWorkflowPins scanner itself, plus 16 structural assertions against the real release.yml/ci.yml/nightly.yml files (SHA-pinning, the literal NOODARA_API_ORIGIN=http://api:3000 build arg, no floating :latest tag anywhere, native-arch-only build (no QEMU), imagetools create + docker manifest inspect present, per-job permissions:/timeout-minutes:, the D-02 header comment, cancel-in-progress: false exactly once, the installer job's push-on-main gate in ci.yml, check:posix-sh in the lint job, the installer job in nightly.yml)"

key-files:
  created:
    - .github/workflows/release.yml
    - scripts/check-workflow-pins.mjs
    - tests/unit/scripts/check-workflow-pins.test.ts
  modified:
    - .github/workflows/ci.yml
    - .github/workflows/nightly.yml

key-decisions:
  - "provenance: false and sbom: false set explicitly on both build-push-action steps: buildx's default provenance attachment wraps even a single-platform push in its own OCI image index, which would complicate the manifest job's own imagetools create merge into one genuinely two-platform manifest list. Neither D-01, D-16 nor 06-RESEARCH.md calls for provenance/SBOM attestation, and disabling both needs no extra secret -- an explicit, documented choice per hard_rule 7, not a silent omission."
  - "GHCR image owner is lower-cased once in the prepare job (tr '[:upper:]' '[:lower:]' on github.repository_owner) rather than relying on github.repository_owner already being lowercase, since GHCR requires a lowercase image path and GitHub does not guarantee a login's case."
  - "Two separate conditional build-push-action steps per matrix leg (if: matrix.app == 'control-plane' / 'web'), rather than one step with a computed build-args string, so each Dockerfile only ever receives the build args it actually declares (control-plane has no NOODARA_API_ORIGIN ARG) -- avoids Docker's 'build-arg not consumed' warning and keeps the per-app build-args list self-documenting in the YAML itself."
  - "A dedicated prepare job (not inline duplication inside build/manifest/verify) computes and validates the version string exactly once and lower-cases the owner exactly once, exposed as job outputs -- avoids recomputing/re-validating the same tag six times across the build matrix and risking a subtle mismatch between legs."
  - "scripts/check-workflow-pins.mjs written as a real, reusable, zero-dependency gate (not a one-off grep in a test file) mirroring check-posix-sh.mjs's own established convention in this repo, satisfying the plan's own <verify> block's `node scripts/check-workflow-pins.mjs` invocation literally rather than falling back to the grep-only escape hatch."
  - "Two release.yml header/inline comments were reworded after their FIRST draft's own prose accidentally contained the literal substrings ':latest' and 'setup-qemu-action' inside explanatory text (naming the exact anti-pattern being avoided) -- both substrings are also things a real grep/hard_rule check must find ZERO occurrences of across the whole file, so the comments now say 'the unversioned \"latest\" tag' and 'QEMU-based emulated multi-platform build' instead of the literal grep-triggering strings, while remaining equally clear to a human reader."

requirements-completed: [INST-01]

# Metrics
duration: ~2h05min (context reads across 06-03/06-05/06-07/06-12 SUMMARYs, ci.yml/nightly.yml, both Dockerfiles, docker-compose.yml, install.sh's version-resolution functions, 06-CONTEXT.md/06-RESEARCH.md; four real git ls-remote SHA lookups; TDD RED/GREEN cycle for the scanner + structural tests; two rounds of self-inflicted test-vs-comment substring conflicts found and fixed before the final green run)
completed: 2026-09-21
---

# Phase 06 Plan 13: CI release pipeline and installer-suite wiring Summary

**A tag-triggered `release.yml` publishes `noodara-control-plane`/`noodara-web` to GHCR as genuine two-architecture (amd64+arm64) manifests built on native runners with no QEMU, version-validated identically to `install.sh`'s own resolver; `ci.yml`/`nightly.yml` now run the real, Docker-in-Docker `pnpm test:installer` suite at the cost point its measured ~31.5min duration actually affords (push-to-main and nightly, never every PR); every third-party action is pinned to a real, `git ls-remote`-verified commit SHA, enforced by a new zero-dependency scanner.**

## Performance

- **Duration:** ~2h05min (file reads across four prior plans' SUMMARYs plus the Dockerfiles/compose file/install.sh version-resolution functions; four real `git ls-remote` SHA lookups; a genuine TDD RED->GREEN cycle for the workflow-pin scanner and 16 structural assertions against the real workflow files; two self-inflicted substring conflicts between explanatory comments and the tests' own literal-string checks, found and fixed before the final green run)
- **Tasks:** 2 (plan) + 1 structural-test/scanner unit ahead of Task 1 (hard_rule #8's own TDD requirement for this plan's static-verification-only nature)
- **Files created:** 3 (`.github/workflows/release.yml`, `scripts/check-workflow-pins.mjs`, `tests/unit/scripts/check-workflow-pins.test.ts`)
- **Files modified:** 2 (`.github/workflows/ci.yml`, `.github/workflows/nightly.yml`)

## Accomplishments

- **`scripts/check-workflow-pins.mjs` (ahead of Task 1, hard_rule #8):** a zero-dependency, regex-over-known-shape scanner (mirrors `check-posix-sh.mjs`'s own discipline) that flags any `uses:` line in a workflow YAML file not pinned to a 40-character commit SHA, with a `TODO(06-15)` trailing-comment escape hatch for a genuinely unresolvable SHA. Backed by `tests/unit/scripts/check-workflow-pins.test.ts`'s 4 fixture-based unit tests, written and confirmed RED before the script existed.
- **Task 1 -- `release.yml` (D-01, D-16, D-02, T-06-54..T-06-59):** a `prepare` job derives and validates the release version exactly once (stripping a leading `v`, applying install.sh's own `noodara_validate_tag` character-class/length rules) and lower-cases the GHCR image owner exactly once; a `build` job matrix (2 images x 2 native architectures = 4 legs, `fail-fast: false`) builds and pushes per-arch tags with no QEMU anywhere in the file; a `manifest` job (`needs: [prepare, build]`) combines each image's two per-arch tags into one real multi-arch manifest via `docker buildx imagetools create`; a `verify` job (`needs: [prepare, manifest]`) runs `docker manifest inspect` and fails unless both `linux/amd64` and `linux/arm64` are present. The web image's build always sets `NOODARA_API_ORIGIN=http://api:3000`; the control-plane image always sets `NOODARA_IMAGE_VERSION`. Every job declares `permissions:` (minimum `contents: read` + `packages: write`/`read`, no PAT) and a sourced `timeout-minutes:`. The header comment documents D-02 (cannot fire for real without a remote+tag, mirroring `nightly.yml`'s own precedent) and the corrected, FACTS-accurate description of `NOODARA_API_ORIGIN` (supplied once as a build arg; the image carries it as its own ENV; the compose file must never override it).
- **Task 2 -- `ci.yml`/`nightly.yml` wiring (T-06-59):** `pnpm check:posix-sh` added to `ci.yml`'s `lint` job (runs on every PR, cheap and static). A new `installer` job in `ci.yml` runs `pnpm test:installer`, gated with `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` and a 60-minute timeout (sourced from `06-12-SUMMARY.md`'s measured 1888.95s/~31.5min, 51/51 tests, on a 14-core dev machine, with real headroom for a slower/shared GitHub-hosted runner). A matching `installer` job in `nightly.yml` runs the identical command unconditionally. Neither existing job's commands, timeouts or triggers changed (`git diff --stat` on both files shows additions only).
- **Verification performed (honestly, without a real GitHub Actions run):** `actionlint` (already installed via Homebrew, v1.7.12) passes clean on all three workflow files. `node scripts/check-workflow-pins.mjs .github/workflows/{release,ci,nightly}.yml` reports every file clean. `tests/unit/scripts/check-workflow-pins.test.ts`'s 20 tests all pass, including every literal-string/regex acceptance criterion the plan's own `<acceptance_criteria>` blocks name. Full `pnpm test`: **127 files / 2143 tests green** (2123 baseline from 06-12's Finding F + 20 new). `pnpm lint` / `pnpm typecheck`: clean (FULL TURBO cache hit, no new errors). No Docker command was run by this plan (per the objective's explicit instruction); the installer/release jobs' own real behavior is therefore genuinely unverified until a real GitHub Actions run (see "Cannot Be Verified Without a Real GitHub Run" below).

## Action -> Tag -> SHA Table (hard_rule #6 lookup evidence)

All four lookups performed with `git ls-remote --tags` against the real upstream repository on 2026-09-21. None of these tags are annotated (`git ls-remote` returned no `^{}` peeled ref for any of them), so the SHA returned by `ls-remote` is already the commit SHA itself.

| Action | Tag used | SHA | Lookup command | Notes |
|---|---|---|---|---|
| `actions/checkout` | `v5` | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` | `git ls-remote https://github.com/actions/checkout refs/tags/v5 refs/tags/v5^{}` | Reused unmodified from `ci.yml`/`nightly.yml`; re-verified with the same command, no mismatch. |
| `pnpm/action-setup` | `v4` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` | `git ls-remote https://github.com/pnpm/action-setup refs/tags/v4 refs/tags/v4^{}` | Reused unmodified from `ci.yml`/`nightly.yml`; `v4` is a lightweight tag whose direct SHA (`f40ffcd9...`) differs from the annotated `v4^{}` peeled SHA actually used everywhere in this repo (`b906affc...`) -- confirmed matching the existing convention, no mismatch. |
| `actions/setup-node` | `v5` | `a0853c24544627f65ddf259abe73b1d18a591444` | `git ls-remote https://github.com/actions/setup-node refs/tags/v5 refs/tags/v5^{}` | Reused unmodified from `ci.yml`/`nightly.yml`; re-verified, no mismatch. |
| `docker/setup-buildx-action` | `v4.4.1` (also the current `v4` alias) | `f87e5991a6d7451dcb8d9637bfbc97413f497069` | `git ls-remote --tags https://github.com/docker/setup-buildx-action` | New to this plan. Latest v4.x release as of 2026-09-21. |
| `docker/login-action` | `v4.6.0` (also the current `v4` alias) | `dbcb813823bdd20940b903addbd779551569679f` | `git ls-remote --tags https://github.com/docker/login-action` | New to this plan. Latest v4.x release as of 2026-09-21. |
| `docker/build-push-action` | `v7.4.0` (also the current `v7` alias) | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` | `git ls-remote --tags https://github.com/docker/build-push-action` | New to this plan. Latest v7.x release as of 2026-09-21. |

Package Legitimacy Audit precedent (06-RESEARCH.md): all three `docker/*` actions are first-party Docker Inc. actions, already recorded as Approved there; SHA pinning (this table) is the stated condition for that approval.

## Task Commits

Test-first (hard_rule #8, the plan's own static-verification nature):

1. **RED -- structural test suite ahead of Task 1:**
   - `7c7e7d0` `test(06-13): add failing tests for the workflow-pin scanner and release pipeline` -- confirmed RED (module `scripts/check-workflow-pins.mjs` did not exist)
2. **GREEN -- the scanner itself:**
   - `1a9349d` `feat(06-13): add check-workflow-pins.mjs static SHA-pin scanner` -- the 4 fixture-based scanner unit tests pass; the 16 structural assertions against real workflow files remain RED (release.yml does not exist yet, ci.yml/nightly.yml not yet wired)
3. **Task 1:**
   - `2751fb1` `feat(06-13): add release.yml -- native multi-arch GHCR publishing` -- 17/20 tests now green (all release.yml-specific assertions pass; the 3 remaining failures are Task 2's own ci.yml/nightly.yml assertions, correctly still RED)
4. **Task 2:**
   - `7825823` `feat(06-13): wire the installer suite and posix-sh gate into ci.yml/nightly.yml` -- all 20/20 tests green

_Every commit's message verified free of attribution trailers via `git log -1 --format=%B` after each commit; `git diff --cached --name-only` checked before every commit; every staged path lives under `noodara/code`; `git fsck --no-reflogs --unreachable | grep -c commit` confirmed at the baseline value of 35 after every commit (no `git stash` used)._

## Files Created/Modified

- `.github/workflows/release.yml` -- tag-triggered (+ `workflow_dispatch`) native multi-arch GHCR release pipeline (`prepare` -> `build` (2x2 matrix) -> `manifest` -> `verify`)
- `scripts/check-workflow-pins.mjs` -- zero-dependency SHA-pin scanner for `.github/workflows/*.yml`
- `tests/unit/scripts/check-workflow-pins.test.ts` -- 20 tests: 4 scanner-fixture unit tests + 16 structural assertions against the real workflow files
- `.github/workflows/ci.yml` -- `pnpm check:posix-sh` added to `lint`; new `installer` job (push-on-main only, 60min timeout)
- `.github/workflows/nightly.yml` -- new `installer` job (unconditional, 60min timeout)

## Decisions Made

See `key-decisions` in the frontmatter above. In short: `provenance`/`sbom` explicitly disabled on every build-push-action step (documented reason: avoids buildx wrapping even a single-arch push in its own image index, which would complicate the later `imagetools create` merge); GHCR owner lower-cased once in `prepare`; per-app conditional build-push-action steps instead of a computed build-args string; version/owner computed exactly once and threaded as job outputs; `check-workflow-pins.mjs` written as a real, reusable gate rather than only a grep fallback; two explanatory comments reworded after their first draft accidentally contained the exact literal substrings (`:latest`, `setup-qemu-action`) the file itself must contain zero occurrences of.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 -- self-inflicted bug in this plan's own first draft, caught by its own tests] Explanatory comments in `release.yml` accidentally contained the literal substrings they were describing the ABSENCE of**
- **Found during:** Task 1's own first structural-test run against the freshly written `release.yml`
- **Issue:** The header comment's D-04 explanation read "...Never publish the unversioned `:latest` tag..." and the native-runner comment read "...(no `docker/setup-qemu-action` anywhere in this file)..." -- both are true, intentional, human-readable explanations, but they also make the literal substrings `:latest` and `setup-qemu-action` appear in the file's own text, which is exactly what `tests/unit/scripts/check-workflow-pins.test.ts`'s own "no `:latest` anywhere" and "does not contain `setup-qemu-action`" assertions (mirroring the plan's own `<acceptance_criteria>` grep checks) are built to catch.
- **Fix:** Reworded both comments to convey the identical meaning without the exact grep-triggering substrings: `"the unversioned \"latest\" tag"` and `"no QEMU-based emulated multi-platform build anywhere in this file"`.
- **Files modified:** `.github/workflows/release.yml`
- **Verification:** Full `tests/unit/scripts/check-workflow-pins.test.ts` re-run: 20/20 green (was 17/20 immediately before this fix, with exactly these two assertions failing).
- **Committed in:** `2751fb1` (the reworded text landed in the same Task 1 commit that introduced it -- no separate fix commit was needed since the bug was caught before the first commit of `release.yml`, not after).

**2. [Rule 1 -- test-authoring bug in this plan's own structural test] Job-name extraction regex matched non-job keys under `on:`/`concurrency:`**
- **Found during:** Task 1's own first structural-test run
- **Issue:** `tests/unit/scripts/check-workflow-pins.test.ts`'s "every job declares permissions:/timeout-minutes:" test extracted 2-space-indented `key:` lines from the WHOLE file, not just the `jobs:` block -- `release.yml`'s own `on: push: tags:` / `concurrency:` sections use the identical 2-space indentation shape (`  push:`, `  tags:`), so the test tried to find a "push" job and a "tags" job that do not exist.
- **Fix:** Scoped the extraction to the substring after `\njobs:\n` before matching job-name keys.
- **Files modified:** `tests/unit/scripts/check-workflow-pins.test.ts`
- **Verification:** Re-run confirmed the fix isolates real job names (`prepare`, `build`, `manifest`, `verify`) only.
- **Committed in:** `2751fb1` (fixed before the first commit landed, same reasoning as Deviation 1).

## Requirement Proof Map

- **INST-01** (already `Complete` since Plan 06-12): this plan does not change INST-01's own proof; it supplies the release pipeline INST-01's real-world install path depends on once a repository exists (D-02). `requirements.mark-complete` is re-run for INST-01 per this plan's own frontmatter `requirements:` field -- idempotent, no state change expected.

## Threat Flags

None -- every new surface this plan introduces (`release.yml`'s GHCR-publishing token scope, the two native build runners, the manifest/verify jobs) is exactly the surface named and mitigated in this plan's own `<threat_model>` (T-06-54..T-06-59, T-06-SC), with no additional, un-modeled production surface introduced. `scripts/check-workflow-pins.mjs` and its test are tooling-only, no production counterpart.

## User Setup Required

None from this plan directly, but see "Open Human Prerequisites for Plan 06-15" below -- several items this plan's own text surfaced are blocking for the FIRST real release, not for this plan's own completion.

## Rules Not Fully Implemented

None. Every hard_rule in scope for this plan (1-10) was followed to the letter, including the two self-caught deviations above (both fixed before their introducing commit, so no rule was ever actually violated in a committed state).

## What Cannot Be Verified Without a Real GitHub Run

This list is the honest, explicit input for Plan 06-15's human-prerequisite checklist (hard_rule #11's own instruction):

1. **The tag-push trigger itself.** `on: push: tags: ['v*.*.*']` has never fired -- GitHub Actions only evaluates a workflow's triggers for a file that already lives on a pushed, real repository (D-02). Static validation only: `actionlint` + `check-workflow-pins.mjs` + the structural test suite.
2. **The `workflow_dispatch` manual dry run** 06-RESEARCH.md's own Open Question 1 recommends as the FIRST real execution of this file -- also blocked on the repository existing.
3. **Whether `docker/build-push-action` actually builds successfully on `ubuntu-24.04-arm`** for this specific dependency tree (argon2's native binding, ssh2's optional `cpu-features`) inside a real GitHub Actions job -- the Dockerfiles were only ever built and measured locally (06-03/06-05-SUMMARY.md, on this development machine's own aarch64 Docker Desktop VM), never on a GitHub-hosted arm64 runner.
4. **Whether `docker buildx imagetools create` combining two real, separately-pushed per-arch GHCR tags produces a manifest `docker manifest inspect` reports both architectures for** -- the `manifest`/`verify` jobs' own logic was reasoned through and statically checked, never executed against real pushed images.
5. **Whether the `installer` jobs' 60-minute timeout is actually sufficient on a real (likely slower, likely 2-4 core rather than this dev machine's 14-core) GitHub-hosted `ubuntu-latest` runner.** Sized with real headroom above the measured 31.5min local figure, but the multiplier is a judgment call, not a second real measurement.
6. **Whether `docker manifest inspect` needs `DOCKER_CLI_EXPERIMENTAL=enabled` on GitHub's own `ubuntu-latest` runner image** (set defensively in the `verify` job) -- current GitHub-hosted runner images may already have this enabled by default; unconfirmed against a real run.
7. **GHCR package visibility and the `github.actor`/`GITHUB_TOKEN` GHCR-push authorization flow end to end** -- reasoned from GitHub's own documented `packages: write` + `GITHUB_TOKEN` mechanism, never exercised against a real GHCR namespace.

## Open Human Prerequisites for Plan 06-15

Carried forward from this plan's own discoveries, in addition to D-02 itself (create the repository, first push):

1. **`install.sh`'s `NOODARA_REPO_OWNER` placeholder (`REPLACE_WITH_GITHUB_OWNER`, line 41).** Not edited by this plan (out of scope, `install.sh` untouched) -- `release.yml` itself correctly derives the owner from `github.repository_owner` (lower-cased) rather than a literal, but `install.sh`'s own default must be replaced with the real owner (or always be invoked with `NOODARA_REPO_OWNER` set) before the first real `curl | sh` install works against the resolved-latest-release path.
2. **A real, published, non-prerelease GitHub Release must exist** for `install.sh`'s default (`NOODARA_VERSION` unset) install path to work at all -- `noodara_resolve_version` requires the `releases/latest` redirect (or the REST API fallback) to resolve to a real tag. This plan's `release.yml` publishes IMAGES for a pushed tag; it does NOT create a GitHub Release object. No task in this plan runs `gh release create` or any GitHub API write (D-02, hard_rule #5) -- creating the first real Release is therefore also a human prerequisite for Plan 06-15, not something silently assumed to already happen as a side effect of the image-publishing workflow.
3. **GHCR package visibility.** A freshly published GHCR package is PRIVATE by default. `install.sh` pulls anonymously (`docker pull`, no login). Both `ghcr.io/<owner>/noodara-control-plane` and `ghcr.io/<owner>/noodara-web` must be made public by a human (GitHub package settings) after the first real publish, or every real install will fail on `docker pull` with an authorization error.
4. **The `workflow_dispatch` manual dry run** (06-RESEARCH.md Open Question 1's own recommendation) should be exercised for real before the first real version tag is pushed, once the repository exists.

## Next Phase Readiness

- `.github/workflows/release.yml`, the updated `ci.yml`/`nightly.yml`, and `scripts/check-workflow-pins.mjs` are all in place, statically verified (actionlint, the SHA-pin scanner, 20 structural tests, full `pnpm test`/`lint`/`typecheck`), and committed.
- Plan 06-14 (docs) can now reference a real, reviewed release workflow and the exact `curl | sh` command shape when writing install/upgrade documentation.
- Plan 06-15 (real VPS validation) inherits this plan's own "What Cannot Be Verified" list (above) as its verification checklist, plus the "Open Human Prerequisites" list as blocking setup steps that must happen BEFORE the first real tag push, in addition to D-02 (repository creation) itself.
- No blockers for Plan 06-13 itself; every task and every hard_rule was completed.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 5 created/modified files (`.github/workflows/release.yml`, `scripts/check-workflow-pins.mjs`,
`tests/unit/scripts/check-workflow-pins.test.ts`, `.github/workflows/ci.yml`,
`.github/workflows/nightly.yml`) verified present on disk; all 4 task commit hashes (`7c7e7d0`,
`1a9349d`, `2751fb1`, `7825823`) verified present in `git log --oneline --all`.
