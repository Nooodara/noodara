---
phase: 06-instalador-y-docker-compose
review: 06-REVIEW.md
fixed: 2026-09-21
status: all_confirmed_findings_fixed
---

# Phase 6: Code Review Fix Report

Fixes every confirmed WARNING (WR-01..WR-08) from `.planning/phases/06-instalador-y-docker-compose/06-REVIEW.md`.
IN-01 is informational and explicitly out of scope per the orchestrator's instructions -- left
untouched.

Every finding below was independently re-verified against the actual code before being fixed (per
this fix round's own instructions, since earlier reviews in this project contained false
positives). All eight were confirmed real.

## Findings

### WR-01: `noodara_env_append_if_missing` appended directly to the live `.env`

**Verdict:** Confirmed. `install.sh:846-860` (pre-fix) appended via `printf ... >> "$path"` --
the one `.env`-mutating writer in the file that did not go through the temp-file-then-atomic-`mv`
pattern every sibling writer uses.

**Fix:** Now copies the existing file to `.noodara-env-append-tmp.$$` in the same directory under
`umask 077`, appends the new line there (emitting its own leading newline only when the original
file's own last byte, read once via `tail -c 1` before any write, is not already a newline), and
`mv`s the temp file over the original only after the write is proven to have succeeded. A failure
at either step removes the temp file and calls `noodara_fail env-write-failed`, naming the key,
never the value.

**Tests:** `tests/unit/installer/env-file.test.ts` -- byte-identical preservation for a file
containing `#`, quotes, `=`, and trailing spaces, both with and without a trailing newline; an
unwritable-directory failure test proving exit 30, no temp file, and no mutation.

**Commits:**
- RED: `0d82e3d` `test(06): pin atomic .env writer behavior for WR-01/WR-02/WR-03`
- GREEN: `e28276a` `fix(06): make .env writers atomic and named on failure (WR-01/WR-02/WR-03)`

### WR-02: `noodara_set_env_value`'s atomic write had no failure checks

**Verdict:** Confirmed. The `awk`-write into the temp file and the final `mv` were both unchecked
-- a failure aborted through `set -e` with `awk`'s/`mv`'s own raw exit code (never
`env-write-failed`, breaking the "every failure gets its own numbered, actionable exit code"
contract), and a failing write left the temp file (a full secret-bearing copy of `.env`, mode 600)
behind with no cleanup.

**Fix:** Both the `awk` write and the `mv` are now checked with `if ! ...; then rm -f
"$tmp_file"; noodara_fail env-write-failed "..."; fi`, matching
`noodara_docker_download_gpg_key`/`noodara_docker_write_sources_list`'s own precedent. The failure
message names the key, never the value.

**Tests:** `tests/unit/installer/env-file.test.ts` -- an unwritable-directory failure test proving
exit 30, the key name in stderr, the value never in stderr, and no temp file left behind.

**Commits:** same pair as WR-01 (`0d82e3d` / `e28276a`) -- the review grouped these three
writer-hygiene findings as one closely related fix.

### WR-03: `noodara_generate_env`'s directory-creation `mkdir` was unchecked

**Verdict:** Confirmed. `(umask 077 && mkdir -p "$env_dir")` had no `||` failure handler, unlike
the identical pattern in `noodara_prepare_install_dir`.

**Fix:** `(umask 077 && mkdir -p "$env_dir") || noodara_fail env-write-failed "Failed to create
$env_dir."`, matching `noodara_prepare_install_dir`'s own shape exactly.

**Tests:** `tests/unit/installer/env-file.test.ts` -- an unwritable-parent-directory failure test
proving exit 30 and a "Failed to create" message.

**Commits:** same pair as WR-01/WR-02.

### WR-04: `docs/install.md` understated how late an invalid `NOODARA_ADMIN_PASSWORD` fails

**Verdict:** Confirmed. `install.sh` itself only ever checked the admin password for an embedded
newline/CR and a literal single quote -- no length check at all. The 12-character minimum, the
common-password rule and the equals-identifier rule were all enforced only later, inside the `api`
container at boot (`preseedAdmin` in `bootstrap-admin.ts`, via
`packages/domain/src/validators/password.ts`'s `validatePassword`), surfacing as an opaque exit 53
only after a full `NOODARA_HEALTH_WAIT_ATTEMPTS x NOODARA_HEALTH_WAIT_INTERVAL` stall (5 minutes
by default).

**Design decision (recorded in `.planning/STATE.md`):** `install.sh` now mirrors, up front and
before anything is written, only the parts of the real policy that are cheap and provably stable
to mirror in shell: the minimum length (12, guard-tested against the real
`PASSWORD_MIN_LENGTH` TypeScript constant so the two can never drift silently) and the
equals-admin-email/equals-its-pre-`@`-part rule. The common-password list is deliberately **not**
mirrored -- a data file that would eventually drift from a shell copy -- `docs/install.md` instead
states plainly that the control plane rejects a common password later, at boot, surfacing as exit
53 with the reason in the `api` service's log tail.

The check runs on **both** paths that can matter, established by tracing the code rather than
guessing:
1. **Fresh install** (`noodara_generate_env`), before `.env` is ever written -- the obvious path.
2. **A re-run's repair branch** (`noodara_main`). Tracing `noodara_merge_env`'s own append-pairs
   list shows `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` are never included -- D-11 means
   install.sh never re-consumes or revalidates those two keys from the operator's shell
   environment once `.env` already has them. But the **already-recorded** `.env` values are
   consumed again on every repair (the `api` container reads `.env` via `env_file:` on every
   `docker compose up -d`, and `preseedAdmin` retries as long as no admin has been successfully
   created). Without this second check, a `.env` left over from an earlier attempt with a
   policy-violating admin password would repeat the identical 5-minute stall and exit 53 on every
   single repair retry. `noodara_main` now reads `.env`'s own `NOODARA_ADMIN_EMAIL`/
   `NOODARA_ADMIN_PASSWORD` (via `noodara_env_get_value`) at the moment a repair is decided and
   revalidates them before any pull/up, failing fast instead.

Length is counted with POSIX sh's `${#value}`, documented in install.sh's own comment as
counting **bytes** under dash, never Unicode characters -- the safe direction, since a multi-byte
password can only ever be falsely **accepted** by this pre-filter (never falsely rejected); the
control plane's own character-accurate check remains the final authority.

**Docs:** `docs/install.md`'s "First login" section now splits what `install.sh` itself checks
(quote, newline/CR, length, equals-identifier) from what the control plane checks later at boot
(common password), naming the exact diagnostic command
(`docker compose -f /opt/noodara/docker-compose.yml logs api`) and exit code (53).
`tests/unit/docs/install-docs-accuracy.test.ts` gained two new tests pinning the documented
minimum length against install.sh's own constant and requiring the First-login section to mention
the common-password/exit-53 behavior.

**Tests:** `tests/unit/installer/admin-password-policy.test.ts` (new) -- length/identity rejection
and acceptance cases, the multi-byte false-accept documentation case, and a guard test extracting
`PASSWORD_MIN_LENGTH` from `packages/domain/src/validators/password.ts`'s real source at test time
and pinning it against install.sh's `NOODARA_ADMIN_PASSWORD_MIN_LENGTH`. `main-flow.test.ts` gained
a repair-path test proving a too-short admin password already recorded in `.env` fails fast (exit
30, before any pull/up) rather than stalling to exit 53.

**Commits:**
- RED (tests): `658e2cb` `test(06): pin the admin-password pre-validation design decision (WR-04)`
- Docs: `e235017` `docs(06): clarify admin-password policy timing in install.md (WR-04)`
- STATE.md decision: `67760e0` `docs(06): record the WR-04 admin-password pre-validation decision in STATE.md`

**Process note:** the `noodara_validate_admin_password_policy` implementation and its two call
sites landed inside the WR-01/WR-02/WR-03 `fix(06)` commit (`e28276a`) rather than a dedicated
WR-04 fix commit. This happened because both the WR-01..03 fixes and the WR-04/WR-05 fixes were
written into `install.sh` before RED verification began, and a working-tree restore used to prove
RED for WR-01..03 (`git show HEAD:.../install.sh > install.sh` followed by restoring a full
backup) inadvertently carried the already-written WR-04/WR-05 code along with it into that same
commit. The WR-04 tests above were still independently run against the genuinely unfixed
`install.sh` (via the same backup/restore technique) and confirmed to fail for the right reason
(exit 53 instead of a fast exit 30) before being committed -- the RED proof is real, it simply
does not have its own matching GREEN commit in the install.sh history. Flagged here rather than
silently left inconsistent with the stated commit convention.

### WR-05: The disk-space check's "nearest existing ancestor" comment overstated the code

**Verdict:** Confirmed. The code stripped exactly one path segment (`${NOODARA_INSTALL_DIR%/*}`)
and queried `df` against whatever that produced, even when it also did not exist -- genuinely a
one-level walk, not the ancestor walk the comment and `docs/install.md` both claimed.

**Fix:** Implemented the real walk: `disk_target="${disk_target%/*}"` in a loop, with `/` as the
floor, until `[ -d "$disk_target" ]` is true.

**Tests:** `tests/unit/installer/preflight.test.ts` -- a 3-level non-existent
`NOODARA_INSTALL_DIR` under a `mkdtemp` base, with an injectable `df` that only answers for the
one path argument that genuinely exists (any other path argument fails, mirroring real `df`'s
behavior against a nonexistent path). Proves the check reaches the real ancestor and succeeds; a
companion test proves it still fails (exit 15) when even the real ancestor reports insufficient
space.

**Commits:**
- RED: `d0e37bb` `test(06): pin the real disk-check ancestor walk (WR-05)`
- GREEN: bundled into `e28276a` (see the WR-04 process note above -- the same working-tree
  restore mistake carried this fix's code into that commit too).

### WR-06: `preflight-scenarios.test.ts`'s no-Docker scenario could leak ~1.6GB of images

**Verdict:** Confirmed. `buildInstallerScenarioImages` and the donor `docker volume create` both
ran before the `try` block that owned all cleanup -- a failure in that window left the just-built
images unremoved.

**Fix:** Both now run inside the `try` block; each `finally`-block cleanup call
(`docker volume rm`, `removeBuiltImages`) is guarded so it only runs against something this run
actually created (`volumeCreated`/`images` tracked explicitly).

**Tests:** `tests/unit/scripts/installer-test-resource-cleanup.test.ts` (new, structural,
source-level -- proven against the real file text, not a live Docker reproduction, matching this
project's own `check-workflow-pins.test.ts` precedent). The real fix is additionally exercised for
real by this file's own inclusion in the real-Docker run below (all 17 tests, including this
scenario, passed).

**Commits:**
- RED: `ea650a4` `test(06): pin resource-cleanup ordering in the no-Docker install test (WR-06)`
- GREEN: `5f1b04d` `fix(06): build images and create the donor volume inside the try block (WR-06)`

### WR-07: One `docker` spawn (plus others found by a directed search) had no timeout

**Verdict:** Confirmed for the primary finding
(`idempotent-rerun.test.ts:475`) and the two secondary ones the review named
(`control-plane-image.test.ts:159`, `web-image.test.ts:106`). A directed search across
`tests/integration/installer/` and `tests/integration/helpers/installer-dind.ts` for every other
`spawnSync`/`execFileSync`/`fetch` call (per this fix round's own instructions) found two more,
not named in the review:

- `control-plane-image.test.ts`'s two `/health` `fetch()` calls (its own sibling,
  `web-image.test.ts`, already had `AbortSignal.timeout(10_000)` on its equivalent calls --
  `control-plane-image.test.ts` was the one file in this pair missing it).
- `env-contract.test.ts`'s `spawnSync(process.execPath, ...)` call that imports the compiled
  `env.js`.

Everything else checked (`compose-stack.test.ts`, `installer-dind.ts`, `dind-harness.test.ts`,
`env-compose-roundtrip.test.ts`, `idempotent-rerun.test.ts`'s other calls, `web-image.test.ts`'s
other three `fetch()` calls) already carried an explicit `timeout`/`signal`.

**Fix:** Added `timeout: 30_000` to the three `spawnSync`/`execFileSync` calls and
`signal: AbortSignal.timeout(10_000)` to `control-plane-image.test.ts`'s two `fetch()` calls.

**Tests:** `tests/unit/scripts/installer-test-exec-timeouts.test.ts` (new, structural) -- proves
each of the five call sites carries an explicit timeout/signal. The real fix is additionally
exercised for real by `idempotent-rerun.test.ts`'s own inclusion in the real-Docker run below.

**Commits:**
- RED: `4a73682` `test(06): pin explicit timeouts on every installer-suite docker/fetch spawn (WR-07)`
- GREEN: `9a94814` `fix(06): add explicit timeouts to installer-suite docker/fetch calls (WR-07)`

### WR-08: `passWithNoTests: true` behind stale comments in both gate configs

**Verdict:** Confirmed. Both `vitest.installer.config.ts` and `vitest.integration.config.ts` still
set `passWithNoTests: true` behind a comment claiming "no tests exist yet", even though both
suites are long populated (ten real files under `tests/integration/installer/**` alone).

**Fix:** Both now set `passWithNoTests: false` explicitly, with the stale comment replaced by the
real reason (an `include`/`exclude` glob typo, a directory rename, or an incomplete CI checkout
must now fail the gate loudly instead of silently reporting success with zero tests run).

**Checked for a filter that might legitimately match zero files** (per this fix round's own
instructions), across `package.json` scripts, `scripts/`, and `.github/workflows/*.yml`:
- `package.json`'s `test:boot` (`vitest run --config vitest.integration.config.ts
  tests/integration/boot/boot-command.test.ts`) and `security:scan-leaks` (three explicit
  `tests/integration/activity/canary*.test.ts` paths) -- every named file exists on disk.
- `.github/workflows/nightly.yml:90` (`vitest run --config vitest.integration.config.ts
  tests/integration/ssh/stress-connections.test.ts`) -- file exists on disk.
- `ci.yml`'s and `nightly.yml`'s `installer` jobs run unfiltered `pnpm test:installer`; the PR-gating
  job runs unfiltered `pnpm test:integration`. Neither passes a glob that could silently narrow to
  zero matches.
- `scripts/e2e-repeat.mjs` runs `pnpm test:e2e` (Playwright), unrelated to either Vitest config.

None of these pass a glob that could legitimately match zero files, so none needed a change.

**Tests:** `tests/unit/scripts/vitest-gate-config.test.ts` (new, structural) -- asserts neither
config ever contains the literal `passWithNoTests: true` and that both explicitly set it to
`false`.

**Commits:**
- RED: `4ef42bc` `test(06): pin passWithNoTests: false in the installer/integration gates (WR-08)`
- GREEN: `56a69fe` `fix(06): set passWithNoTests: false on the installer/integration gates (WR-08)`

## Informational finding left untouched

**IN-01** (`README.md`'s own placeholder-owner URL isn't checked against `docs/install.md`'s) is
explicitly out of scope per this fix round's own instructions -- not touched.

## Verification

- `pnpm test` (full unit suite): **2206 tests passed, 132 files** (includes every new/modified test
  file in this round).
- `pnpm lint`: clean (9/9 cached tasks, no new findings; `pnpm lint` scopes to
  packages/apps via Turborepo and does not lint root-level `tests/`, which is unaffected by this
  fix round's scope either way).
- `pnpm typecheck`: clean, exit 0 (includes the explicit
  `tests/integration/installer/tsconfig.json` pass covering every file touched for WR-06/WR-07).
- `pnpm check:posix-sh`: `install.sh clean (2344 lines)`.
- Real-Docker run (the two files touched for WR-06/WR-07, run exactly once, per this fix round's
  own instructions):
  ```
  pnpm exec vitest run --config vitest.installer.config.ts \
    tests/integration/installer/idempotent-rerun.test.ts \
    tests/integration/installer/preflight-scenarios.test.ts
  ```
  **2 test files passed, 17 tests passed, duration 717.30s (~12 minutes).**
- Docker hygiene after the real run: zero `noodara.test=true` containers, zero
  `noodara.test=true` volumes, zero `noodara`-prefixed images remaining (verified by direct
  `docker ps`/`docker volume ls`/`docker images` queries against the real daemon).
- `git fsck --no-reflogs --unreachable | grep -c commit`: `35` -- unchanged from the stated
  baseline, confirming `git stash` was never used.
- Every commit in this round checked individually for attribution trailers -- none found.

## Commit list (chronological)

| Commit | Message |
|---|---|
| `0d82e3d` | `test(06): pin atomic .env writer behavior for WR-01/WR-02/WR-03` |
| `e28276a` | `fix(06): make .env writers atomic and named on failure (WR-01/WR-02/WR-03)` (also carries the WR-04/WR-05 code fixes -- see the WR-04 process note above) |
| `d0e37bb` | `test(06): pin the real disk-check ancestor walk (WR-05)` |
| `658e2cb` | `test(06): pin the admin-password pre-validation design decision (WR-04)` |
| `e235017` | `docs(06): clarify admin-password policy timing in install.md (WR-04)` |
| `67760e0` | `docs(06): record the WR-04 admin-password pre-validation decision in STATE.md` |
| `ea650a4` | `test(06): pin resource-cleanup ordering in the no-Docker install test (WR-06)` |
| `5f1b04d` | `fix(06): build images and create the donor volume inside the try block (WR-06)` |
| `4a73682` | `test(06): pin explicit timeouts on every installer-suite docker/fetch spawn (WR-07)` |
| `9a94814` | `fix(06): add explicit timeouts to installer-suite docker/fetch calls (WR-07)` |
| `4ef42bc` | `test(06): pin passWithNoTests: false in the installer/integration gates (WR-08)` |
| `56a69fe` | `fix(06): set passWithNoTests: false on the installer/integration gates (WR-08)` |

## Deferred / out of scope

- IN-01 (informational) -- explicitly out of scope.
- `buildInstallerScenarioImages`'s own internal partial-failure gap (if the control-plane image
  build succeeds but the web image build then fails, the already-built control-plane image tag is
  never returned to the caller and so can never be cleaned up by WR-06's own fix) was noticed
  while fixing WR-06 but is a pre-existing gap in a shared helper
  (`installer-scenario-helpers.ts`) used identically by `fresh-install.test.ts` and
  `preseed-admin.test.ts`, not something WR-06's own finding named. Left unfixed as out of scope
  for this fix round; flagged here for a future pass.
