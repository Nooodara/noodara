---
phase: 05-ui-web
plan: 20
subsystem: testing
tags: [playwright, e2e, testcontainers, ci, github-actions, sse, tdd]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-10's Playwright harness (tests/e2e/fixtures/stack.ts, playwright.config.ts, E2E_ADMIN_EMAIL/PASSWORD); 05-18's real-sshd @ssh-live discovery precedent and DiscoverySection's own live/settled behaviour; 05-19's real-sshd host-key precedent; every screen plan (05-11..05-17) whose testids this spec drives through; tests/integration/helpers/ssh.ts's startSshd/readTestKey/assertNoStrayTestContainers; tests/integration/ssh/stress-connections.test.ts's existing NOODARA_STRESS=1 100-cycle suite"
provides:
  - "tests/e2e/critical-path.spec.ts: the QA-04 flow end to end (login -> Servers -> add server -> connect -> live discovery -> detail -> activity -> re-run discovery) against a real Ubuntu 24.04 sshd Testcontainer, with a MutationObserver capturing live discovery-step severity snapshots and an instrumented EventSource capturing real server.discovery_progress SSE frames as the live-progress proof"
  - "tests/e2e/fixtures/stack.ts: startCriticalPathSshd/stopCriticalPathSshd, registering the critical-path spec's own sshd fixture on the module's own handle so stopStack's guarded teardown sequence tears it down as a safety net"
  - ".github/workflows/ci.yml: a new e2e job running the whole real Playwright suite (including critical-path.spec.ts) on every PR and on main, replacing the two placeholder comments"
  - ".github/workflows/nightly.yml: e2e-repeat (20 independent pnpm test:e2e process invocations via scripts/e2e-repeat.mjs), stress-connections (the existing NOODARA_STRESS=1 100-cycle suite) and canary (pnpm security:scan-leaks) jobs, schedule + workflow_dispatch, least-privilege contents:read, explicit timeouts, the stray-container check in every job"
  - "scripts/e2e-repeat.mjs: runs pnpm test:e2e as N (default 20) independent process invocations, each with its own fresh Testcontainers pair, failing fast on the first failing iteration"
affects: ["05-21 (repo-wide UI-safety gate and full-suite verification runs on top of this plan's now-complete tests/e2e/** and workflow files)", "any future phase touching tests/e2e/fixtures/stack.ts, servers-list.spec.ts or the SSE broadcaster (see the two deferred-items.md entries this plan adds)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "critical-path.spec.ts never calls page.route -- every assertion is against the real backend, the real worker, and a real Ubuntu 24.04 sshd Testcontainer (readTestKey's own ed25519 key), following discovery.spec.ts's @ssh-live and host-key.spec.ts's @hostkey precedent at the scale of the whole roadmap SS6.6 flow rather than one surface"
    - "live-progress evidence is captured two ways in the same run (a MutationObserver over every discovery-step's own data-severity attribute, and a subclassed EventSource recording every real server.discovery_progress frame's arrival time and check id) -- the DOM-snapshot proof is preferred when it catches a genuine mixed resolved/pending state, with an honest, logged fallback to the SSE frame-sequence proof when a run settles too fast for React to ever commit an intermediate render, exactly as 05-20-PLAN.md's own action text anticipated"
    - "assertLiveProgress polls on the SSE frame count itself (expect.poll, never waitForTimeout) rather than on the server's settled status, specifically to avoid reading the instrumentation before the background connect/discover job has even been dispatched"
    - "the nightly's 20x repetition runs pnpm test:e2e as 20 independent OS processes (scripts/e2e-repeat.mjs), never Playwright's own --repeat-each=20 against one shared globalSetup-started stack -- avoids monotonic real-API-seeded-server accumulation across repetitions in a single shared Postgres database"
    - "Playwright report/screenshot artifacts in ci.yml upload only on failure with a short retention window, since a trace or screenshot can carry a typed (fake) credential or a session cookie"

key-files:
  created:
    - tests/e2e/critical-path.spec.ts
    - .github/workflows/nightly.yml
    - scripts/e2e-repeat.mjs
  modified:
    - tests/e2e/fixtures/stack.ts
    - .github/workflows/ci.yml
    - package.json
    - .planning/phases/05-ui-web/deferred-items.md

key-decisions:
  - "The sshd fixture for critical-path.spec.ts is started through new stack.ts wrappers (startCriticalPathSshd/stopCriticalPathSshd) rather than calling startSshd directly from the spec, so stopStack's own guarded teardown sequence tears it down as a safety net even if the spec's own finally block never runs"
  - "deployer (docker-group member with passwordless sudo, tests/integration/images/sshd-common/setup-users.sh) is the SSH user, authenticated with a real ed25519 private key read from the fixture's own /keys -- not the password-auth pwuser 05-18's @ssh-live test uses -- so every SERV-08 access check genuinely passes and the only non-pass discovery step is docker (warning, since the fixture image has no Docker daemon by default, exactly like every other spec's own default)"
  - "e2e-repeat in nightly.yml deliberately uses a bash-loop-equivalent Node script (scripts/e2e-repeat.mjs) instead of Playwright's own --repeat-each=20, per 05-20-PLAN.md's own explicitly anticipated 'if the global stack makes that unsound' branch -- --repeat-each reuses one Postgres Testcontainer across all 20 passes, so every spec's real-API-seeded servers would accumulate monotonically in that one shared database across a full nightly run"
  - "ci.yml's new e2e job does not add a top-level `permissions:` block to the whole workflow file (unlike the newly-created nightly.yml, which does) -- retrofitting least-privilege permissions onto six pre-existing jobs this plan never touches is an out-of-scope redesign of a file this plan only adds one job to; nightly.yml, being entirely new, is scoped with `permissions: contents: read` from the start"
  - "the servers-list.spec.ts flake investigation could not identify a fixable root cause inside this plan's own files (tests/e2e/fixtures/stack.ts, tests/e2e/critical-path.spec.ts, the two workflow files, package.json) -- two targeted repro attempts (seeding up to 1200 concurrent real servers; re-running the exact preceding spec-file sequence) failed to reproduce the originally-documented @servers row-actions-menu flake, and the real 20-repetition run instead reproduced a different, related SSE-delivery flake in a different servers-list.spec.ts test, entirely outside this plan's files -- documented in deferred-items.md per the scope-boundary rule rather than masked"

requirements-completed: []

# Metrics
duration: ~3h (including flake investigation and the real 20-repetition local run)
completed: 2026-09-19
---

# Phase 5 Plan 20: Critical-Path E2E, CI e2e Job and the Nightly QA-04 Workflows Summary

**One real-browser, real-sshd-container Playwright spec proves the whole roadmap SS6.6 flow (login → Servers → add server → connect → live discovery → detail → activity → re-run discovery) with two independent, browser-observed proofs of live per-check progress; a new CI `e2e` job runs it on every PR; a new nightly workflow repeats the whole suite 20× as 20 independent processes — the real local run reached 5/5 clean repetitions before a pre-existing, out-of-scope SSE-delivery flake (unrelated to this plan's own new spec) stopped it at iteration 6/20, documented rather than masked.**

## Performance

- **Duration:** ~3h (Task 1 TDD cycle + investigation + Task 2 workflows + the real, required 20-repetition local run)
- **Completed:** 2026-09-19
- **Tasks:** 2 of 3 complete (Task 1, Task 2); Task 3 is a blocking human checkpoint, presented below with real local evidence, not yet resolved
- **Files modified:** 7 (3 new, 4 modified)

## Accomplishments

- **`tests/e2e/critical-path.spec.ts`** drives the entire QA-04 flow through the real UI against a real Ubuntu 24.04 sshd Testcontainer (`deployer`, a real ed25519 key) — no `page.route` stub anywhere. Verified stable across 6 independent, fresh-stack local runs (see below): `@critical` passed every time, each run capturing genuine live discovery-step progress (a `MutationObserver`-based mixed resolved/pending DOM snapshot in every run observed, an instrumented `EventSource` independently confirming all 11 real `server.discovery_progress` frames arrived, in `DISCOVERY_CHECK_IDS` order, with more than one distinct arrival timestamp).
- **`tests/e2e/fixtures/stack.ts`** gained `startCriticalPathSshd`/`stopCriticalPathSshd`, registered on the module's own handle so `stopStack`'s guarded teardown tears the sshd fixture down as a safety net even if the spec's own `finally` never runs.
- **`.github/workflows/ci.yml`** gained an `e2e` job (checkout → pnpm/node setup → `pnpm install --frozen-lockfile` → `playwright install --with-deps chromium` → `pnpm build` → `pnpm test:e2e` → failure-only report upload → the stray-container check), replacing the two "no e2e job, ships in phase 5" comments (`grep -c "ships in phase 5"` is now 0).
- **`.github/workflows/nightly.yml`** (new) adds `e2e-repeat`, `stress-connections` and `canary` jobs — `schedule` (inert until the repo has a remote, documented in the file's own header comment) + `workflow_dispatch`, top-level `permissions: contents: read`, explicit `timeout-minutes` on every job, the stray-container check in every job.
- **`scripts/e2e-repeat.mjs`** (new) runs `pnpm test:e2e` as N (default 20) fully independent process invocations, each with its own fresh Postgres/Redis (and, for `critical-path.spec.ts`, sshd) Testcontainers, failing fast and naming the first failing iteration — the sound alternative to `--repeat-each=20` the plan's own text anticipated.
- Two real bugs were found and fixed while getting `critical-path.spec.ts` to a genuine, non-flaky GREEN (both confined to the new spec itself, documented in its own commit): asserting on the live instrumentation immediately after the URL changed raced the not-yet-dispatched connect job; the reset-between-runs helper reassigned `window.__progressEvents` to a new array instead of clearing it in place, disconnecting it from the closures still pushing onto the original one.
- `pnpm test` (1348 tests), `pnpm typecheck` (including `tests/e2e/tsconfig.json`), `pnpm lint`, `pnpm boundaries`, `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`, and a full `pnpm test:e2e` (69/69, `@critical` 1/1) are all green. Zero new npm packages installed (ADR-0000's provenance gate was never invoked).

## The real local 20-repetition run: 5/5 clean, stopped at iteration 6/20

Per this plan's own Task 3 instructions and the harness-hygiene guidance to actually run the repetition (not merely claim it), the real command was run to completion (or failure) locally:

```
NOODARA_API_ORIGIN=http://127.0.0.1:3100 node scripts/e2e-repeat.mjs 20
```
(equivalently `pnpm test:e2e:repeat`, the same script `.github/workflows/nightly.yml`'s `e2e-repeat` job runs)

**Result: iterations 1–5 passed cleanly (69/69 each); iteration 6 failed after 280s total wall-clock, and the script stopped there by design (fail-fast, never runs the remaining 14).**

| Iteration | Result | Duration |
|---|---|---|
| 1 | 69/69 passed | 43.7s |
| 2 | 69/69 passed | 42.2s |
| 3 | 69/69 passed | 42.9s |
| 4 | 69/69 passed | 41.2s |
| 5 | 69/69 passed | 44.4s |
| 6 | **68/69 — 1 failed** | ~1.0m (script total: 280s) |

**Total wall-clock for the 6 iterations actually run: 280s (~4.7 min).**

**The failure was not in `critical-path.spec.ts`.** This plan's own new spec (`@critical`) passed in all 6 iterations, including iteration 6 itself, each time with genuine live-progress evidence captured (see `[critical-path] first/second run: ...` log lines, present and passing in every one of the 6 runs). The failure was in a **pre-existing, unrelated test**: `tests/e2e/servers-list.spec.ts:191` — `@servers activating a row with the keyboard navigates to that server's detail URL` — timed out (`Error: element(s) not found`, 15s) waiting for a real-API-created row to appear via live SSE, with no reload fallback of its own. Full detail, including why it is out of this plan's own file scope and therefore documented rather than fixed here, is in `.planning/phases/05-ui-web/deferred-items.md`'s new "05-20: a second, related `servers-list.spec.ts` flake" entry.

`docker ps -aq --filter "label=noodara.test=true"` and `lsof -i :3000 -i :3100` were both empty immediately after the script exited (code 1) — the teardown sequence held even on a genuine failure.

**This does not satisfy QA-04's literal "nightly lo repite 20 veces" text as a completed, green 20/20 — and per this executor's own instructions, QA-04 stays Pending regardless: the requirement's own wording needs the nightly to have actually run green, and this repository has no remote for the real scheduled/`workflow_dispatch` GitHub Actions run to ever happen yet.** The evidence above is the most this plan can produce locally, presented honestly (not rounded up to "20/20") for the checkpoint below.

## Task Commits

1. **Task 1 RED: failing critical-path spec (missing stack.ts exports)** - `912225b` (test)
2. **Task 1 GREEN: sshd wrappers in stack.ts + the working critical-path spec** - `0612b08` (feat)
3. **Task 2: CI e2e job + nightly workflows + e2e-repeat script** - `edfe218` (feat)

**Plan metadata:** not yet committed — Task 3 (the checkpoint below) is unresolved.

## Files Created/Modified

- `tests/e2e/critical-path.spec.ts` — the whole QA-04 flow against a real sshd container
- `tests/e2e/fixtures/stack.ts` — `startCriticalPathSshd`/`stopCriticalPathSshd`
- `.github/workflows/ci.yml` — the new `e2e` job
- `.github/workflows/nightly.yml` — `e2e-repeat`/`stress-connections`/`canary`
- `scripts/e2e-repeat.mjs` — the N-independent-process E2E repeat runner
- `package.json` — `test:e2e:repeat` script
- `.planning/phases/05-ui-web/deferred-items.md` — two new entries: the inconclusive root-cause investigation of the original flake, and the new flake the real 20× run found
- `CLAUDE.md` — §3.2's command table gained `test:e2e:repeat` (this file is `.gitignore`d in this repository — the edit is on disk but not committed; noted so it is not silently lost)

## Decisions Made

See `key-decisions` in frontmatter — summarized: the sshd fixture routes through new `stack.ts` wrappers so `stopStack` can safety-net its teardown; `deployer` (key auth) is the flow's SSH identity so every access check genuinely passes and only Docker warns; nightly's 20× uses independent processes, never `--repeat-each`; `ci.yml` does not get a retrofitted top-level `permissions:` block (out of scope for a file this plan only adds one job to) while the brand-new `nightly.yml` does; the flake investigation's own findings are documented, not silently worked around.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `assertLiveProgress` raced the not-yet-dispatched connect/discover job**
- **Found during:** Task 1's own first real run against the sshd fixture
- **Issue:** Checking the live-progress instrumentation immediately after the sheet's `router.push` navigated to the detail page could run before the background connect job had even been enqueued, observing zero SSE frames not because delivery was broken but because the run hadn't started.
- **Fix:** `assertLiveProgress` now polls (`expect.poll`, never `waitForTimeout`) until all 11 `discovery_progress` frames for the run have genuinely arrived before evaluating the DOM-snapshot/SSE-sequence evidence, removing the ordering dependency entirely.
- **Files modified:** `tests/e2e/critical-path.spec.ts`
- **Verification:** 6 independent full local runs, `@critical` 6/6 green with live-progress evidence captured every time
- **Committed in:** `0612b08`

**2. [Rule 1 - Bug] `resetInstrumentation` disconnected `window.__progressEvents` from the listener that fills it**
- **Found during:** Task 1, debugging the second (re-run-discovery) run's own live-progress assertion
- **Issue:** Reassigning `window.__progressEvents = []` between runs created a brand-new array object; the `MutationObserver`/`InstrumentedEventSource` closures still pushed onto the *original* array from `installDiscoveryInstrumentation`'s own scope, so every subsequent read of `window.__progressEvents` silently saw nothing the listener had actually received.
- **Fix:** `resetInstrumentation` now clears both arrays in place (`.length = 0`) instead of reassigning the reference.
- **Files modified:** `tests/e2e/critical-path.spec.ts`
- **Verification:** the second-run assertion (`assertLiveProgress(page, 'second run (re-run discovery)')`) now genuinely captures its own 11 frames and mixed-severity snapshots in every one of the 6 local runs
- **Committed in:** `0612b08`

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs in this plan's own new test code, found and fixed while driving it to a genuine, non-flaky green — neither touched application code)
**Impact on plan:** Both were necessary for `critical-path.spec.ts` to prove what it claims to prove (genuine live progress, not a race-prone false negative or false positive). No scope creep.

## Known Stubs

None. `critical-path.spec.ts` reaches the real backend, the real worker, and a real sshd container at every step; no fixture/mock stands in for any part of the flow it drives.

## Issues Encountered

See the "The real local 20-repetition run" section above and `.planning/phases/05-ui-web/deferred-items.md`'s two new entries for full detail on:
1. The original `@servers a row's actions menu...` flake (05-19) — investigated with two targeted repro attempts (up to 1200 concurrently-seeded real servers; the exact preceding spec-file sequence), neither reproduced it. Root cause remains unidentified and outside this plan's own files.
2. A second, related flake the real 20× run reproduced at iteration 6: `@servers activating a row with the keyboard navigates to that server's detail URL`, timing out waiting for a live-SSE-inserted row with no reload fallback. Also outside this plan's own files.

Neither is masked with a retry, `test.fixme`, or a longer timeout — both are documented for the next plan that touches `servers-list.spec.ts` or the SSE broadcaster.

## User Setup Required

None — no external service configuration required, no new npm packages installed.

## Next Phase Readiness

- **Task 1 and Task 2 are complete and committed.** `tests/e2e/critical-path.spec.ts` is a real, non-flaky, non-stubbed proof of the whole roadmap SS6.6 flow (6/6 clean local runs, including inside the one 20-repetition attempt that hit an unrelated failure elsewhere). CI now runs the whole E2E suite on every PR and on main.
- **Task 3 (this plan's checkpoint) is unresolved** — presented to the user below with the real local evidence above, since the true result is 5 clean repetitions followed by a real, pre-existing, out-of-scope failure at iteration 6, not a clean 20/20.
- **QA-04 stays Pending in REQUIREMENTS.md**, per this executor's own instructions: the requirement's literal text needs the nightly to have actually run green, which cannot happen without a remote, and the real local evidence here is 5/5 + 1 unrelated failure, not 20/20 either way.
- `.planning/phases/05-ui-web/deferred-items.md` now carries two open, well-evidenced flake entries for whichever plan next touches `servers-list.spec.ts` or the SSE broadcaster's Redis-subscriber startup path.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19 (Tasks 1-2; Task 3 pending)*

## Self-Check: PASSED

Verified on disk: `tests/e2e/critical-path.spec.ts`, `tests/e2e/fixtures/stack.ts`,
`.github/workflows/ci.yml`, `.github/workflows/nightly.yml`, `scripts/e2e-repeat.mjs`,
`package.json`, `.planning/phases/05-ui-web/deferred-items.md`. All three task commits (`912225b`,
`0612b08`, `edfe218`) confirmed present in `git log --oneline`. `pnpm test` (1348 tests),
`pnpm typecheck` (including `tests/e2e/tsconfig.json`), `pnpm lint`, `pnpm boundaries`,
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`, and a full `pnpm test:e2e` (69/69) all
green. The real `node scripts/e2e-repeat.mjs 20` run completed 5 clean 69/69 iterations before
stopping at iteration 6/20 on a pre-existing, out-of-scope flake — `docker ps -aq --filter
"label=noodara.test=true"` and `lsof -i :3000 -i :3100` both empty immediately after.
