---
phase: 05-ui-web
plan: 36
subsystem: infra
tags: [github-actions, ci, gitleaks, playwright, supply-chain, provenance, pnpm]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-20/05-21's original CI/nightly workflows and security:scan-leaks canary suite"
provides:
  - "CI security job that can pass its first real run (playwright browser installed before the canary spec)"
  - "Least-privilege, timeout-bounded, SHA-pinned CI/nightly workflow jobs"
  - "Checksum-verified gitleaks binary download in the full-tree scan step"
  - "Package-provenance gate covering all 52 locked direct dependencies at their pinned versions (was 27/52 at dist-tags.latest)"
  - "docs/ci-readiness.md: the honest record of what remains unverifiable without a remote"
affects: [05-37]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "scripts/*.mjs guard main() behind an import.meta.url === file://process.argv[1] check so the module can be imported by a unit test without a full network side effect"
    - "pnpm list -r --depth 0 --json as the sanctioned, lockfile-driven dependency enumeration source (no hand-parsed YAML, no hardcoded list)"

key-files:
  created:
    - tests/unit/scripts/check-package-provenance.test.ts
    - docs/ci-readiness.md
  modified:
    - scripts/check-package-provenance.mjs
    - .github/workflows/ci.yml
    - .github/workflows/nightly.yml

key-decisions:
  - "check-package-provenance.mjs enumerates dependencies+devDependencies via pnpm list -r --depth 0 --json instead of a hardcoded list, matching the review's own 52-dependency denominator exactly"
  - "ioredis's expected repository changed from redis/ioredis (dist-tags.latest) to luin/ioredis (the actual repository declared by the pinned 5.11.1 release) -- concrete proof the locked-version check changes the result"
  - "Removed two stale EXPECTED_PACKAGES entries (fastify-type-provider-zod, bare playwright) that are not direct dependencies of any workspace manifest"
  - "nightly.yml's canary job also got the playwright-install fix, beyond the plan's literal ci.yml-only text, since it runs the identical security:scan-leaks command with the identical missing-browser defect (Rule 1, files_modified already covered nightly.yml)"
  - "nightly.yml's workflow-level permissions block replaced with identical job-level blocks on all three jobs, to satisfy the literal per-job permissions requirement rather than relying on inheritance"

requirements-completed: [QA-04, QA-05]

# Metrics
duration: ~35min
completed: 2026-09-20
---

# Phase 05 Plan 36: CI readiness gap closure (SC5/QA-04/QA-05 + WR-C-14) Summary

**Fixed the CI security job's missing Playwright install (and nightly's identical copy), pinned/scoped/bounded every workflow job, checksum-verified the gitleaks binary download, rewrote the package-provenance gate to enumerate all 52 locked direct dependencies at their pinned versions (was 27/52 at dist-tags.latest), and wrote the honest CI-readiness record — QA-04/QA-05 stay Pending.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- `ci.yml`'s `security` job (and `nightly.yml`'s `canary` job, same bug) now installs a Playwright
  browser before running `pnpm security:scan-leaks`, which ends in `playwright test --grep @canary`
  — previously both jobs would have failed before testing anything on their first real run.
- Every job in both workflow files (8 in `ci.yml`, 3 in `nightly.yml` — 11 total) now has an
  explicit `permissions:` block and a `timeout-minutes:` value sized above its real observed cost.
- Every third-party `uses:` in both files is pinned to a commit SHA with the tag kept as a
  trailing comment.
- `ci.yml`'s full-tree gitleaks step downloads the release archive and gitleaks' own published
  checksum file separately and verifies with `sha256sum -c` before extracting — no more
  `curl | tar`.
- `scripts/check-package-provenance.mjs` now enumerates every direct dependency (prod+dev) from
  the locked pnpm tree instead of a hardcoded 29-entry list. Coverage: **52/52**, up from 27/52.
  The seven WR-C-14-named missing production packages (`ssh2`, `argon2`, `better-auth`, `pg`,
  `fastify`, `pino`, `zod`) are now covered.
- `docs/ci-readiness.md` records precisely what remains unverifiable without a remote, and the
  exact human observation required before QA-04/QA-05 can move to `Complete`.

## Task Commits

1. **Task 2 (RED half): failing coverage test for the provenance gate** - `0181774` (test)
2. **Task 2 (GREEN half): lockfile-driven provenance enumeration** - `5e652ca` (feat)
3. **Task 1: harden CI/nightly workflows, unblock the security job** - `32de7bc` (fix)
4. **Task 3: docs/ci-readiness.md** - committed in the plan-metadata commit below (docs)

_TDD note: Task 2 is `tdd="true"` in the plan. Commit `0181774` is the RED commit (test added,
verified failing against the pre-change script — see "TDD RED evidence" below); commit `5e652ca`
is the GREEN commit (implementation, test passes). No REFACTOR commit was needed — the
implementation didn't require a follow-up cleanup pass once green._

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

## TDD RED Evidence (Task 2)

Ran `pnpm exec vitest run tests/unit/scripts/check-package-provenance.test.ts` against the
pre-change script (commit `0181774`'s parent). Result:

```
TypeError: enumerateLockedDependencies is not a function
 ❯ tests/unit/scripts/check-package-provenance.test.ts:19:24 (and :32, :40)

⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
Error: process.exit unexpectedly called with "1" (test file: ...)
 ❯ scripts/check-package-provenance.mjs:264:11

 Test Files  1 failed (1)
      Tests  3 failed (3)
```

The old script's top-level `main().catch(...)` also ran as an import-time side effect (confirming
it still had no `enumerateLockedDependencies` export and no import guard), performing a full
network scan of its old hardcoded 29-entry list and calling `process.exit(1)` because that scan
found genuine `FAIL` entries against the current registry state — a separate, real symptom of the
same underlying defect, not a false negative in the test.

After the GREEN implementation: `pnpm exec vitest run tests/unit/scripts/check-package-provenance.test.ts`
→ `Test Files 1 passed (1)`, `Tests 3 passed (3)`, 1.35s, zero network calls (the test only
exercises the local `pnpm list` enumeration, never the registry-resolution path).

## Coverage: old vs. new (WR-C-14)

| | Old (pre-05-36) | New (05-36) |
|---|---|---|
| Enumeration source | Hardcoded 29-entry `EXPECTED_PACKAGES` list | `pnpm list -r --depth 0 --json` (dependencies + devDependencies, all 7 workspaces, `link:` excluded) |
| Denominator | 52 (05-REVIEW.md's own cross-manifest count) | 52 (computed by the script itself — matches the review's count exactly) |
| Numerator | 27 (05-REVIEW.md WR-C-14) | 52 — `node scripts/check-package-provenance.mjs`'s own printed line: `Coverage: 52/52 locked direct dependencies verified.` (exit 0) |
| Version checked | Registry `dist-tags.latest` | The exact version `pnpm-lock.yaml` resolved (from `pnpm list`'s own output) |
| Unlisted package behaviour | N/A (list was hardcoded, nothing to be "unlisted" at runtime) | Enumerated package with no `EXPECTED_PACKAGES` entry fails the gate by name, never silently skipped |

Concrete proof the version-pinning fix changes real output: `ioredis@5.11.1` (this repository's
actual pin — see ADR-0000's Phase 4 RESP3-compatibility decision) declares
`repository.url -> git://github.com/luin/ioredis.git` in its own published `package.json`.
`ioredis`'s registry `dist-tags.latest` (6.0.0 at the time of this change) instead resolves to
`redis/ioredis`. The pre-05-36 script (checking `latest`, no version argument to `npm view`)
silently verified a release this repository does not even install. `EXPECTED_PACKAGES`'s `ioredis`
entry now expects `luin/ioredis`, matching the pinned version — this is the exact case
`tests/unit/scripts/check-package-provenance.test.ts`'s second test pins down.

## Files Created/Modified

- `tests/unit/scripts/check-package-provenance.test.ts` - unit test pinning the WR-C-14 coverage
  fix and the locked-version resolution fix; no network call, runs against local `pnpm list` output.
- `scripts/check-package-provenance.mjs` - rewritten enumeration (`enumerateLockedDependencies`),
  locked-version resolution, `--list` mode, `import.meta.url` main-module guard, expanded
  `EXPECTED_PACKAGES` table (52 entries, 25 new + 1 corrected + 2 removed as stale), documented
  publisher-asserted-URL limitation in the header.
- `.github/workflows/ci.yml` - `playwright install` step in `security`; job-level `permissions:`
  and `timeout-minutes:` on all 8 jobs; every `uses:` SHA-pinned; checksum-verified gitleaks
  download.
- `.github/workflows/nightly.yml` - `playwright install` step in `canary`; job-level `permissions:`
  replacing the workflow-level block; `timeout-minutes:` already present, unchanged; every `uses:`
  SHA-pinned.
- `docs/ci-readiness.md` - new. Records what's fixed, what's still `Pending`, and the exact human
  observation required for QA-04/QA-05.

## Decisions Made

- **Enumeration scope: prod + dev direct dependencies, not prod-only.** The plan's `must_haves`
  literally requires "every production dependency in the lockfile". Enumerating both
  `dependencies` and `devDependencies` is a superset that also satisfies that requirement, and it
  is the only enumeration that reproduces 05-REVIEW.md's own "52 external dependencies" figure
  exactly (verified: `pnpm list -r --depth 0 --json --prod` alone yields 30 entries including 3
  workspace-internal links = 27 external prod-only; the review's 52 only matches when
  `devDependencies` are included too). Matching the review's own denominator makes the "27 of 52
  → new numerator/denominator" comparison in the SUMMARY an apples-to-apples number, not a
  different metric relabeled.
- **`ioredis` expected repository corrected, not just left mismatched.** Discovered empirically
  (see "Concrete proof" above) that checking the locked version genuinely changes the correct
  answer for a real package already in this project's dependency tree, not just a hypothetical.
  Updated the expectation rather than leaving the gate broken for a legitimate dependency.
- **Two stale `EXPECTED_PACKAGES` entries removed** (`fastify-type-provider-zod`,
  bare `playwright`) — 05-REVIEW.md WR-C-14 finding 1 explicitly named both as not being real
  dependencies of any workspace. They can no longer be reached by the new enumeration-driven gate
  either way; removing the dead entries avoids a future reader assuming they still mean something.
  `fastify-type-provider-zod`'s historical verification record remains intact in
  `docs/adr/0000-package-legitimacy-approvals.md` and `docs/adr/0001-fastify-zod-type-provider.md`
  (neither file was touched by this plan).
- **`nightly.yml`'s workflow-level `permissions:` block replaced by identical job-level blocks.**
  The plan's acceptance criteria literally count a `permissions:` key inside each `jobs.*` entry;
  a single workflow-level block (which was already present and already `contents: read`) would
  satisfy GitHub Actions' actual security semantics via inheritance, but not the literal per-job
  counting check. Replaced rather than duplicated to avoid two sources of truth for the same
  scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `nightly.yml`'s `canary` job had the identical missing-`playwright-install` bug as `ci.yml`'s `security` job**
- **Found during:** Task 1 (re-reading `nightly.yml` in full per the task's own `read_first` list)
- **Issue:** `nightly.yml`'s `canary` job runs the exact same `pnpm security:scan-leaks` command
  (which ends in `playwright test --grep @canary`) with no browser-install step, the same defect
  the plan's own text describes for `ci.yml`'s `security` job. The plan's prose ("the e2e and
  nightly jobs already have the install step") refers to `nightly.yml`'s `e2e-repeat` job, which
  does have it — not `canary`, which does not.
- **Fix:** Added `pnpm exec playwright install --with-deps chromium` before `pnpm security:scan-leaks`
  in the `canary` job, identical form to the `security`/`e2e`/`e2e-repeat` jobs.
- **Files modified:** `.github/workflows/nightly.yml`
- **Verification:** `grep -c "playwright install" .github/workflows/nightly.yml` shows 2 real
  `run:` steps (`e2e-repeat`, `canary`) plus 1 comment mention; YAML re-parses clean.
- **Committed in:** `32de7bc` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug, directly parallel to the plan's own named defect, inside the plan's own `files_modified` list).
**Impact on plan:** Closes a real gap in the exact requirement (QA-05) this plan exists to fix. No scope creep — `nightly.yml` was already in `files_modified`.

## Verification Note: plan's own suggested `awk` acceptance check has a pre-existing quirk

Task 1's acceptance criteria suggests:
`awk '/^  security:/,/^  [a-z][a-z-]*:$/' .github/workflows/ci.yml | grep -c "playwright install"`.
For a single-word job name like `security` (no hyphen), the line `  security:` matches BOTH the
awk range's start pattern and its end pattern simultaneously — awk closes the range on the same
line it opened, so this command only ever prints the one line `  security:` and `grep -c` on that
returns 0, regardless of what the job body actually contains. This is a property of the job name
matching the end-of-range regex, not something this plan's edits caused or can fix by restructuring
the job (the job must be named `security` per the existing CI contract). Verified with a corrected
range extraction (breaks the range on the *next* distinct top-level job key) that the `security`
job's step list does contain `pnpm exec playwright install --with-deps chromium` — full section
reproduced in this plan's execution transcript. The simpler, unambiguous checks
(`grep -c "playwright install" .github/workflows/ci.yml` = 3 total occurrences: 2 real `run:`
steps in `security`/`e2e` + 1 comment mention) confirm the same fact without the range ambiguity.

## Issues Encountered

None beyond the awk quirk noted above (not a defect in this plan's changes).

## Known Stubs

None.

## Threat Flags

None — every new surface introduced (checksum verification, SHA-pinned actions, per-job
permissions, provenance enumeration) is itself a mitigation named in this plan's own threat
register (T-5G-36-01 through T-5G-36-07), not a new unmitigated surface.

## User Setup Required

None - no external service configuration required. QA-04/QA-05 remain `Pending`; the only
"setup" that would move them is pushing this repository to a remote and observing a real CI/
nightly run, which is explicitly out of scope for this local-only environment (see
`docs/ci-readiness.md`).

## Next Phase Readiness

- CI/nightly workflows are structurally ready to pass their first real run (browser installed
  where needed, least-privilege and bounded, SHA-pinned, checksum-verified binary download).
- `scripts/check-package-provenance.mjs` genuinely covers the full locked dependency tree now;
  a future dependency addition will fail the gate until a human adds its `EXPECTED_PACKAGES` entry.
- `docs/ci-readiness.md` gives Plan 05-37's human-verification checkpoint the exact, already-written
  observation criteria to hand to the user — no new investigation needed there.
- QA-04/QA-05 stay `Pending` in `.planning/REQUIREMENTS.md` (untouched by this plan, as required).

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All claimed files verified present on disk (`tests/unit/scripts/check-package-provenance.test.ts`,
`docs/ci-readiness.md`, `scripts/check-package-provenance.mjs`, `.github/workflows/ci.yml`,
`.github/workflows/nightly.yml`, this file). All three task commit hashes (`0181774`, `5e652ca`,
`32de7bc`) verified present in `git log --oneline --all`. No missing items.
