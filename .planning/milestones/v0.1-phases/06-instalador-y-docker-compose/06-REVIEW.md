---
phase: 06-instalador-y-docker-compose
reviewed: 2026-09-21T21:55:13Z
depth: standard (install.sh reviewed at deep/line-by-line depth per instructions)
files_reviewed: 29
files_reviewed_list:
  - install.sh
  - docker-compose.yml
  - apps/control-plane/Dockerfile
  - apps/web/Dockerfile
  - .dockerignore
  - .github/workflows/release.yml
  - .github/workflows/ci.yml
  - .github/workflows/nightly.yml
  - apps/web/next.config.ts
  - .env.example
  - docker-compose.dev.yml
  - scripts/check-posix-sh.mjs
  - scripts/check-workflow-pins.mjs
  - tests/integration/helpers/installer-dind.ts
  - tests/integration/images/installer-dind-common/entrypoint.sh
  - tests/integration/installer/installer-scenario-helpers.ts
  - tests/unit/installer/sh-harness.ts
  - package.json
  - vitest.installer.config.ts
  - vitest.integration.config.ts
  - tests/integration/installer/tsconfig.json
  - tests/integration/installer/compose-stack.test.ts
  - tests/integration/installer/fresh-install.test.ts
  - tests/integration/installer/idempotent-rerun.test.ts
  - tests/integration/installer/preflight-scenarios.test.ts
  - tests/integration/installer/preseed-admin.test.ts
  - tests/integration/installer/env-compose-roundtrip.test.ts
  - tests/unit/docs/install-docs-accuracy.test.ts
  - docs/install.md
  - README.md
  - docs/adr/0007-production-topology-and-installer.md
  - docs/releases/v0.1-gate.md
findings:
  critical: 0
  warning: 8
  info: 1
  total: 9
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-09-21T21:55:13Z
**Depth:** standard (install.sh read and traced line-by-line, per the reviewer's own instructions)
**Files Reviewed:** 31 (see `files_reviewed_list`; a few Dockerfiles for the DinD test images and
the remaining `tests/unit/installer/*.test.ts`/`tests/integration/installer/*.test.ts` files were
scanned but not read line-by-line — no findings were dropped as a result, see "Scope note" below)
**Status:** issues_found

## Summary

`install.sh` is unusually disciplined for a 2,200-line, `local`-free POSIX shell script: almost
every writer that touches a real file follows an explicit temp-file-then-atomic-`mv` pattern with
its own `noodara_fail`-mapped exit code, every network call goes through one seam
(`noodara_fetch_url`) with pinned TLS and an explicit timeout, every operator-influenced value that
reaches `.env` or a shell metacharacter-sensitive context is validated before the first byte is
written, and the file's own extensive commentary records a real audit history (`Post-execution
fix`, `Finding A/B/C/...`) that this review independently re-verified rather than took on faith. I
traced global-variable lifetimes across every function call (no `local` exists, so every assignment
is process-global) and found the codebase's own discipline of "always bind parameters as the very
first statement of a function" is in fact sufficient to prevent the caller-variable-clobbering bug
class the task asked me to hunt for — I could not construct a concrete trigger for it. I also
confirmed, by actually sourcing `install.sh` and calling `noodara_place_compose_file` against a
scratch directory, that the compose file it embeds is byte-identical to the repo's own root
`docker-compose.yml`.

The real gaps found are narrower and more mundane than a headline vulnerability: two of
`install.sh`'s own `.env`-mutation helpers (`noodara_env_append_if_missing`,
`noodara_set_env_value`) do not follow the atomic-write-with-checked-failure discipline the rest of
the file applies everywhere else, a real cleanup-ordering gap in one installer test can leak ~1.6GB
of Docker images on a rare failure path, one assertion in the installer test suite has no execution
timeout (breaking this project's own stated "every exec/build/load has an explicit timeout" rule),
two Vitest configs gate a release-blocking CI job behind `passWithNoTests: true` with a now-stale
justifying comment, and `docs/install.md`'s admin-password section understates how late (and how
slowly) a policy-violating `NOODARA_ADMIN_PASSWORD` actually fails. None of these rise to a security
vulnerability or a real data-loss path in the current code (the backup-before-mutate ordering and
`set -e`'s own interaction with unchecked-but-unconditional statements both turned out to
mitigate the worst-case outcome I initially suspected for the `.env`-writer findings below — see
each finding's own reasoning chain). No BLOCKER-tier finding is reported.

**Scope note:** `tests/unit/installer/{docker-install,env-file,main-flow,preflight,resolution,
skeleton}.test.ts`, `tests/integration/installer/{control-plane-image,dind-harness,env-contract,
web-image}.test.ts`, and the `installer-dind-*` Dockerfiles were grep-scanned for the standard-issue
anti-patterns (vacuous assertions, `.skip`/`.todo`, missing timeouts) and spot-read where the grep
scan raised a question; none produced a new confirmed finding beyond what's captured below. I did
not find anything in them worth listing as "unconfirmed" either — they are not called out further
here to keep this report to confirmed findings only.

## Structural Findings (fallow)

None provided for this review (no `<structural_findings>` block was included in the task).

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: `.env` additive-merge append is not atomic, unlike every other writer in `install.sh`

**File:** `install.sh:846-860` (`noodara_env_append_if_missing`), reached from `noodara_merge_env`
at `install.sh:910-927` on every genuine version upgrade.

**Issue:** Every other function in this file that mutates a real on-disk file — the Docker GPG
keyring (`noodara_docker_download_gpg_key`, `install.sh:424-446`), the apt sources list
(`noodara_docker_write_sources_list`, `install.sh:467-503`), the compose file
(`noodara_place_compose_file`, `install.sh:1399-1591`) — writes to a `.tmp.$$` file first and only
`mv`s it into place after checking the write succeeded, explicitly removing the temp file and
calling `noodara_fail env-write-failed` on any failure. `noodara_env_append_if_missing` is the one
`.env`-mutating writer that instead appends directly to the live file:

```sh
printf '%s=%s\n' "$key" "$value" >> "$path"
```

This runs on every real upgrade (`noodara_merge_env` calls it once per `NOODARA_IMAGE_PREFIX`/
`NOODARA_PORT`/`NOODARA_PUBLIC_URL` pair). A write failure partway through this `printf` (disk-full
— plausible on a host sitting close to the documented 5GB minimum right after a multi-GB image pull
— or any other I/O error) can leave a truncated/malformed trailing line appended directly to the
real, in-use `/opt/noodara/.env`, which `docker compose up -d` reads moments later in the same
`noodara_main` run. This is mitigated by `noodara_backup_env` already having copied an intact `.env`
moments earlier in the same call (`noodara_merge_env`, `install.sh:915`), so the operator is never
left without a good copy — but the live file `docker compose` actually uses on this run can still be
malformed, which is exactly the class of bug ("a path where a failure leaves a half-written `.env`")
this review was asked to hunt for.

**Fix:** Route `noodara_env_append_if_missing` through the same temp-file-then-atomic-`mv` pattern
already used by `noodara_set_env_value`/`noodara_place_compose_file` (append to a `.tmp.$$` copy of
the file, then `mv` over the original), or at minimum check the `printf`'s own exit status and call
`noodara_fail env-write-failed` on failure so the operator gets an actionable message instead of a
raw shell error.

### WR-02: `noodara_set_env_value`'s own atomic write is missing the failure checks its siblings have

**File:** `install.sh:876-902` (`noodara_set_env_value`).

**Issue:** This function already writes to a temp file and `mv`s it into place (the right shape),
but — unlike `noodara_docker_download_gpg_key`/`noodara_docker_write_sources_list` (which both carry
an explicit `Post-execution fix (orchestrator audit Finding 3)` comment applying exactly this
pattern) — neither the `awk`-write into `$tmp_file` nor the final `mv "$tmp_file" "$path"` is
checked:

```sh
(
  umask 077
  NOODARA_SET_ENV_KEY="$key" NOODARA_SET_ENV_VALUE="$value" awk '...' "$path" > "$tmp_file"
)
mv "$tmp_file" "$path"
```

Traced through `set -eu`: because neither statement is inside an `if`/`&&`/`||`, a failure of either
one aborts the whole script immediately via `set -e` — so the real `.env` is never actually left
half-written (a failing `awk`-write never reaches the `mv`; a same-filesystem `mv` is itself atomic,
so it either fully replaces `$path` or doesn't run at all). The concrete consequences are narrower
than a corrupted `.env`, but still real: (1) the script exits with `awk`'s or `mv`'s own raw exit
code instead of `noodara_fail`'s structured `env-write-failed` (30), breaking the D-17 "every
failure gets its own numbered, actionable exit code" contract for this one path; (2) a failed write
leaves the temp file — `${dir}/.noodara-env-tmp.$$`, a full copy of `.env` including every secret,
mode 600 — behind in `/opt/noodara` with no cleanup, unlike every sibling writer which explicitly
`rm -f`s its own temp file on failure.

**Fix:** Apply the same `if ! ...; then rm -f "$tmp_file"; noodara_fail env-write-failed "..."; fi`
shape already used by `noodara_docker_download_gpg_key`/`noodara_docker_write_sources_list` to both
the `awk` write and the `mv`.

### WR-03: `noodara_generate_env`'s directory creation is the one `mkdir` in the file left unchecked

**File:** `install.sh:763-765`.

**Issue:**

```sh
if [ ! -d "$env_dir" ]; then
  (umask 077 && mkdir -p "$env_dir")
fi
```

Contrast with `noodara_prepare_install_dir` (`install.sh:1370-1375`), which checks the identical
`mkdir -p` with `|| noodara_fail env-write-failed "Failed to create $NOODARA_INSTALL_DIR."`. In the
real `noodara_main` flow this branch is dead code — `noodara_prepare_install_dir` has always already
created `NOODARA_INSTALL_DIR` (and `env_dir` always resolves to exactly that directory) before
`noodara_generate_env` is ever called — but `noodara_generate_env` is also called directly (by this
suite's own unit/integration tests, and by any future caller) against a directory that does not yet
exist. An `mkdir` failure there would abort with a raw, non-actionable shell error rather than the
intended `env-write-failed` (30).

**Fix:** `(umask 077 && mkdir -p "$env_dir") || noodara_fail env-write-failed "Failed to create $env_dir."`, matching `noodara_prepare_install_dir`'s own pattern.

### WR-04: `docs/install.md` understates how late and how slowly an invalid `NOODARA_ADMIN_PASSWORD` actually fails

**File:** `docs/install.md:109-115` (First login section); actual enforcement in
`packages/domain/src/validators/password.ts:9-51` and
`apps/control-plane/src/boot/bootstrap-admin.ts:136-147`.

**Issue:** The docs state: *"The password must be at least 12 characters; it may contain any
character except a literal single quote (`'`), which cannot be written safely into the generated
`.env` file and is rejected outright before anything is written."* Read together, this reads as if
both requirements are enforced the same way. They are not: `install.sh` itself only ever checks for
an embedded newline/CR and a literal single quote (`noodara_env_assert_single_line`/
`noodara_env_assert_no_single_quote`, `install.sh:754-757`) — it has no length check at all. The
12-character minimum, the "must not be a common password" rule, and the "must not equal the admin
email or its local part" rule are all enforced later, inside the `api` container at boot
(`validatePassword`, `bootstrap-admin.ts`'s `preseedAdmin`), which throws
`AdminPreseedPolicyError` and never calls `app.listen`. Verified against
`tests/integration/installer/idempotent-rerun.test.ts`'s own "broken image never listens on 3000"
scenario (run 6): this failure mode is architecturally identical — the `api` healthcheck fails, the
container never becomes healthy, and `install.sh` only reports the problem after its full
`NOODARA_HEALTH_WAIT_ATTEMPTS x NOODARA_HEALTH_WAIT_INTERVAL` budget (5 minutes by default) elapses,
exiting 53 with a log tail containing the real `AdminPreseedPolicyError` message. The docs do not
mention the common-password or email-equality rules at all, and the phrasing around "rejected
outright before anything is written" only actually applies to the quote check, not to the length or
policy checks — an operator who supplies a too-short/too-common `NOODARA_ADMIN_PASSWORD` gets a
5-minute stall and an opaque exit 53 instead of the instant, clear rejection the doc's wording
implies.

**Fix:** Split the sentence so it's clear which checks `install.sh` itself performs before writing
anything (single quote, newline/CR only) versus which are domain-policy checks enforced by the
control plane at boot (length, common-password, equals-email) that surface as a slow health-check
timeout (exit 53) rather than an immediate rejection; name the common-password and equals-email
rules explicitly so an operator can avoid tripping them.

### WR-05: `install.sh`/`docs/install.md` both overstate the disk-free "nearest existing ancestor" walk

**File:** `install.sh:231-235` (`noodara_check_resources`); `docs/install.md:15-16`.

**Issue:** Both the code comment (`install.sh:214-216`, "*the nearest existing ancestor, when the
install dir does not exist yet*") and the docs (*"or its nearest existing parent, on a fresh
host"*) describe a real ancestor walk, but the implementation only strips exactly one path segment:

```sh
disk_target="$NOODARA_INSTALL_DIR"
if [ ! -d "$disk_target" ]; then
  disk_target="${NOODARA_INSTALL_DIR%/*}"
  [ -z "$disk_target" ] && disk_target="/"
fi
```

For the real, fixed default (`/opt/noodara`) this is harmless in practice — `/opt` always exists on
a stock Ubuntu 22.04/24.04 install — but the claimed behavior ("nearest existing ancestor") and the
actual behavior ("exactly one level up, then whatever `df` reports for that, even if it also doesn't
exist") genuinely diverge, and a `df` call against a still-nonexistent path fails silently into
`disk_kb=""` → `disk_mb=0` → a confusing `insufficient-disk` failure rather than a real measurement.

**Fix:** Either loop `disk_target="${disk_target%/*}"` until `[ -d "$disk_target" ]` (a real ancestor
walk) or correct both comments to describe the actual one-level behavior.

### WR-06: `preflight-scenarios.test.ts`'s no-Docker scenario can leak ~1.6GB of built images on a narrow failure window

**File:** `tests/integration/installer/preflight-scenarios.test.ts:288-296`.

**Issue:**

```ts
const images = buildInstallerScenarioImages('0612-nodocker');
const volumeName = `noodara-nodocker-donor-${randomUUID()}`;
execFileSync('docker', ['volume', 'create', '--label', 'noodara.test=true', volumeName], {
  timeout: 60_000,
  stdio: 'ignore',
});

let donor: InstallerDindFixture | undefined;
let target: InstallerDindFixture | undefined;
try {
  ...
} finally {
  await donor?.stop();
  await target?.stop();
  execFileSync('docker', ['volume', 'rm', '-f', volumeName], { stdio: 'ignore', timeout: 60_000 });
  removeBuiltImages(images);
  await assertNoStrayTestContainers();
}
```

`buildInstallerScenarioImages` (which builds and tags the two ~1.6GB combined production images,
per `fresh-install.test.ts`'s own comment) and the subsequent `docker volume create` both run
*before* the `try` block that owns all cleanup. If `docker volume create` throws (or anything else
in that two-line window fails), `removeBuiltImages(images)` in `finally` never runs and the just-
built images are never removed — this suite's own sibling helper, `startInstallerDind` in
`tests/integration/helpers/installer-dind.ts:143-164`, wraps its own `docker volume create` in a
try/catch specifically to avoid this exact leak class (`removeVolume(volumeName)` on a build/start
failure), but this test does not apply the same guard around its own volume-create call.

**Fix:** Move `buildInstallerScenarioImages` and `docker volume create` inside the `try` (or wrap
them in their own try/catch that removes any already-built images before re-throwing), so every
failure path — not just the ones after both succeed — cleans up what was already built.

### WR-07: One `docker` spawn in the installer test suite has no execution timeout

**File:** `tests/integration/installer/idempotent-rerun.test.ts:475`; secondarily
`tests/integration/installer/control-plane-image.test.ts:159` and
`tests/integration/installer/web-image.test.ts:106`.

**Issue:**

```ts
it('leaves zero noodara.test=true containers/volumes behind at the daemon level (checked mid-suite)', async () => {
  const result = execFileSync('docker', ['ps', '-aq', '--filter', 'label=noodara.test=true']).toString();
  ...
```

This is the one `docker`/`docker compose` spawn in this file (and across its sibling installer
suites) with no options object at all — every other invocation in
`idempotent-rerun.test.ts`/`fresh-install.test.ts`/`preflight-scenarios.test.ts`/
`installer-scenario-helpers.ts` passes an explicit `timeout:`, matching this codebase's own stated
convention ("hard_rule #7: explicit timeouts on every exec/build/load", quoted directly in
`installer-dind.ts`'s own header comment). `execFileSync` with no `timeout` blocks forever if the
Docker daemon is unresponsive at exactly this point in the suite, hanging the whole run instead of
failing after a bounded time. The two `removeImage`/cleanup `spawnSync('docker', ['rmi', '-f', tag],
{ stdio: 'ignore' })` calls in `control-plane-image.test.ts:159` and `web-image.test.ts:106` share
the same gap, though as best-effort cleanup calls (`spawnSync`, not `execFileSync`, so a hang there
would not throw, only stall the `afterAll` hook) they are lower-impact.

**Fix:** Add an explicit `timeout:` (e.g. the file's own `CLI_TIMEOUT_MS`/`RUN_TIMEOUT_MS`-scale
constant) to all three calls.

### WR-08: `passWithNoTests: true` lets the installer/integration CI gates silently no-op if the glob ever matches zero files

**File:** `vitest.installer.config.ts:21-24`; `vitest.integration.config.ts:22`.

**Issue:** Both configs set `passWithNoTests: true` with a comment justifying it as a temporary
state for a not-yet-populated suite:

```ts
// No installer integration tests exist yet in this plan (Plan 06-10..06-12 add them);
// passWithNoTests is deliberate here, matching vitest.integration.config.ts's own precedent
// for a not-yet-populated suite.
passWithNoTests: true,
```

This comment is now stale — `tests/integration/installer/**` contains eight real, release-gating
test files (`fresh-install.test.ts`, `idempotent-rerun.test.ts`, `preflight-scenarios.test.ts`,
`preseed-admin.test.ts`, `compose-stack.test.ts`, `control-plane-image.test.ts`,
`web-image.test.ts`, `dind-harness.test.ts`, `env-contract.test.ts`,
`env-compose-roundtrip.test.ts`) — but the `passWithNoTests: true` flag is still live. `ci.yml`'s
`installer` job (push-to-main only) and `nightly.yml`'s `installer` job both run `pnpm
test:installer` and treat a green exit as proof the real Docker-in-Docker installer suite ran; with
`passWithNoTests: true` still set, a future accidental typo in the `include` glob, a directory
rename, or a CI checkout that omits `tests/integration/installer/` would make this release-blocking
gate report success having run zero tests, rather than failing loudly. Same reasoning applies to
`vitest.integration.config.ts`'s `include: ['tests/integration/**/*.test.ts']` with
`tests/integration/installer/**` excluded — that suite is also long populated.

**Fix:** Remove `passWithNoTests: true` from both configs now that each suite is genuinely
populated (or replace it with an explicit assertion in CI that the expected number of test files
were discovered), so an empty run fails instead of passing.

## Info

### IN-01: `noodara_ensure_docker` path names are consistent, but the file's own `NOODARA_REPO_OWNER` placeholder appears in three independently-maintained copies

**File:** `install.sh:41`, `docs/install.md:26,45,222,252,258`, `README.md:17`.

**Issue:** This is already tracked as accepted debt in `docs/releases/v0.1-gate.md` (the placeholder
owner itself is explicitly out of scope per this review's instructions), but worth noting for the
record: `tests/unit/docs/install-docs-accuracy.test.ts` only checks that the placeholder-owner URL
appears *at least twice* in `docs/install.md` and never checks `README.md`'s own copy of the install
command against the same placeholder-derived URL. Not a functional defect — `README.md`'s command is
in fact byte-identical to `install.sh`'s own derived URL today — just an untested doc/doc
consistency point that could silently drift once the placeholder is replaced in Plan 06-15's own
handoff, if only `docs/install.md` (and not `README.md`) is updated.

**Fix:** Optional — extend `install-docs-accuracy.test.ts`'s existing URL-shape test to also assert
`README.md` contains the identical derived URL, closing the one doc file it currently doesn't check.

---

_Reviewed: 2026-09-21T21:55:13Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard (install.sh at deep/line-by-line depth)_
