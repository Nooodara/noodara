---
phase: 06-instalador-y-docker-compose
plan: 09
subsystem: infra
tags: [posix-sh, dash, docker-compose, health-wait, setup-token, ufw, vitest]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 01
    provides: install.sh skeleton (exit-code table, noodara_step/warn/note/fail, source-only guard), tests/unit/installer/sh-harness.ts
  - phase: 06-instalador-y-docker-compose
    plan: 02
    provides: noodara_preflight (root/base-commands/OS/arch/resources/snap/port, one documented order, first-failure-wins)
  - phase: 06-instalador-y-docker-compose
    plan: 04
    provides: noodara_generate_env/noodara_merge_env/noodara_set_env_value/noodara_backup_env (D-11 additive merge), noodara_secure_env_file
  - phase: 06-instalador-y-docker-compose
    plan: 06
    provides: noodara_resolve_version/noodara_resolve_public_url/noodara_resolve_image_prefix/noodara_resolve_port, noodara_fetch_url (the single curl seam)
  - phase: 06-instalador-y-docker-compose
    plan: 07
    provides: the production docker-compose.yml six-service topology, and its own 06-07-SUMMARY.md-recorded real stack-startup timing (used to size the health-wait bound)
  - phase: 06-instalador-y-docker-compose
    plan: 08
    provides: noodara_ensure_docker (D-14 apt-repo install, docker-daemon-unavailable gate)
provides:
  - "install.sh: noodara_main wired end to end -- preflight -> ensure Docker -> noodara_is_installed/noodara_prepare_install_dir -> resolve version/image-prefix/public-URL/port -> generate-or-merge .env (with NOODARA_PREVIOUS_VERSION recorded only when the version genuinely changes) -> noodara_place_compose_file (the real docker-compose.yml embedded verbatim) -> noodara_pull_images -> noodara_compose_up -> noodara_wait_for_health -> noodara_print_summary, with noodara_write_log recording non-secret step names to install.log throughout"
  - "install.sh: noodara_compose_json_field_for_service (jq-free docker compose ps --format json parser, both NDJSON and single-array shapes), noodara_migrate_did_fail (distinguishes migrations-failed=52 from compose-up-failed=51), noodara_redact_diagnostic_text (masks a setup-token line or a userinfo-bearing connection string in a D-12 log tail before it ever reaches stderr), noodara_read_setup_token (D-13, charset/length-validated), noodara_check_ufw (read-only, exact Pitfall-5 wording), noodara_env_get_value (single-quote-tolerant .env reader)"
  - "tests/unit/installer/main-flow.test.ts: 106 cases (proportioned across /bin/sh + real /bin/dash) proving the fresh-install/upgrade branch, byte-identical compose-file embedding, pull/up/health-wait exit codes 50/51/52/53, D-12's never-a-destructive-command guarantee, the setup-token/admin-exists/admin-preseed summary paths, the ufw advisory's exact wording and read-only-ness, and a canary end-to-end proof that no generated secret or the setup token ever reaches install.log or any file other than .env/.env.bak-*"
affects: [06-10-dind-harness, 06-11-fresh-install-scenarios, 06-12-preflight-scenarios, 06-13-ci-release, 06-14-docs, 06-15-release-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The production docker-compose.yml is embedded into install.sh as three quoted heredocs interleaved with two single-%s printf calls (rather than one heredoc), because the real file's two healthcheck.test lines contain the literal JS arrow-function substring catch(()=>...) -- an unavoidable literal \"((\" that check-posix-sh's arith-command rule flags as a bashism false positive. The workaround follows this file's own $'/\"local\" precedent (06-06-SUMMARY.md): _noodara_pcf_lp holds a single \"(\" character, and the two affected lines are assembled from it via printf's %s substitution at RUNTIME, so the literal two-character sequence \"((\" never appears together on any physical source line of install.sh. Proven byte-for-byte identical to docker-compose.yml by a runtime-equivalence test (run the real function against a tmpdir, diff the output), not a static heredoc-extraction test -- the multi-segment construction makes static extraction impractical, and the runtime proof is strictly stronger (it proves what the installer actually writes, not just its source shape)."
    - "docker compose ps --format json parsed without jq: noodara_compose_json_field_for_service splits on \"}\" record boundaries (awk RS=\"}\"), not on newlines -- this is what makes it tolerate both the single-JSON-array and NDJSON shapes Compose has shipped across versions with one implementation."
    - "noodara_write_log is a standalone function, explicitly called by noodara_main at each major step, deliberately NOT wired into noodara_step/noodara_warn themselves -- those two helpers run from noodara_preflight and others BEFORE the install directory is guaranteed to exist, and Plan 06-02's own already-tested invariant (\"noodara_preflight writes nothing under NOODARA_INSTALL_DIR\") would break the moment either helper attempted a file write. See Deviations."
    - "noodara_wait_for_health's D-12 rollback hint prefers a NOODARA_PREVIOUS_VERSION env-var override (for isolated unit tests), then falls back to reading the value noodara_main already wrote into .env, then a generic placeholder -- a real install never sets NOODARA_PREVIOUS_VERSION as a process environment variable, only as a .env key, so the original single-source design (env-var only) was a genuine bug caught while writing this plan's own full-flow D-12 test. See Deviations."
    - "Every arithmetic increment in this plan's new code goes through awk (_noodara_wfh_attempt=$(awk -v n=\"$_noodara_wfh_attempt\" 'BEGIN { print n + 1 }')), never $(( )) -- continues 06-02's own established workaround for check-posix-sh's arith-command rule, which cannot distinguish a genuine POSIX arithmetic expansion from bash's ((...)) compound command."

key-files:
  created:
    - tests/unit/installer/main-flow.test.ts
  modified:
    - install.sh
    - tests/unit/installer/skeleton.test.ts

key-decisions:
  - "Embedding (not the network-fetch fallback) was chosen for the compose file, per the plan's own stated preference -- the only obstacle (the two catch(()=>...) healthcheck lines) was solved with a printf-substitution workaround rather than falling back to a second network dependency mid-install."
  - "noodara_print_summary takes explicit positional args (public_url, env_path, version) rather than reading noodara_main's own same-named globals implicitly -- this file has no `local`, so every function's globals ARE visible to every other function called from the same invocation, but relying on that hidden coupling would make noodara_print_summary untestable in isolation; explicit args keep it independently callable and independently tested."
  - "noodara_read_setup_token validates the extracted value's shape (charset [A-Za-z0-9_-], length 20-128) before ever returning it, rather than trusting docker compose logs output wholesale -- a log line corrupted by a terminal escape sequence or other junk fails this check and is never echoed to the operator's terminal (hard_rule #9's own requirement)."

requirements-completed: []  # INST-01/02/04/05 intentionally NOT marked complete -- the objective's own text is explicit: "leave them Pending unless the plan alone proves them end to end (it cannot, without a real run)." See Deviations.

# Metrics
duration: ~18min (task commits, first to last: 09:01:51-09:20:10); total session including context reading and manual verification considerably longer, not separately timestamped
completed: 2026-09-21
---

# Phase 06 Plan 09: noodara_main wiring — the full install/upgrade flow Summary

**`install.sh`'s `noodara_main` is rewired from a banner-only stub into the complete, ordered install flow (preflight → Docker → install-directory bootstrap → `.env` generate-or-merge → compose-file placement → pull → up → health-wait → setup-token/ufw/summary), with the production `docker-compose.yml` embedded byte-for-byte via a printf-substitution workaround for a real `check-posix-sh` false positive, a jq-free `docker compose ps --format json` parser, D-12's diagnostic log tail now redacted before it ever reaches the operator, and a canary test proving no generated secret or the setup token ever reaches `install.log` or any file other than `.env`/`.env.bak-*`.**

## Performance

- **Duration:** ~18min for the seven task/fix commits (09:01:51–09:20:10); total session (context reading across all eight prior plans' SUMMARYs, `install.sh`, `docker-compose.yml`, test conventions, `bootstrap-admin.ts`, manual dash/awk verification of the compose-embedding workaround) considerably longer, not separately timestamped.
- **Tasks:** 3 (plan) + 1 cross-plan regression fix (skeleton.test.ts)
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- **Task 1 — install-directory bootstrap, compose placement, fresh-vs-upgrade branch:** `noodara_is_installed` keys on `$NOODARA_INSTALL_DIR/.env` existing (D-10). `noodara_prepare_install_dir` creates/re-asserts mode 700. `noodara_place_compose_file` writes the real `docker-compose.yml` verbatim, mode 644, proven byte-identical by a runtime-equivalence test (see Decisions/Patterns). `noodara_main` restructured into preflight → ensure Docker → prepare dir → resolve version/image-prefix/public-URL/port → generate-or-merge `.env` → place compose file → (Task 2/3 stubs). `NOODARA_PREVIOUS_VERSION` is recorded (via `noodara_env_get_value` + `noodara_set_env_value`) only when the version genuinely changes, before `noodara_merge_env` overwrites `NOODARA_VERSION`.
- **Task 2 — pull, up, health-wait, D-12 diagnostics:** `noodara_compose_json_field_for_service` parses `docker compose ps[--format json]` without jq, tolerating both shapes Compose has shipped. `noodara_pull_images` skips the pull when `NOODARA_INTERNAL_IMAGE_PREFIX` is set (D-19). `noodara_compose_up` distinguishes `migrations-failed` (52) from `compose-up-failed` (51) via `noodara_migrate_did_fail`. `noodara_wait_for_health` polls `api`/`web` health via a bounded loop (60 attempts × 5s, both overridable only for tests), never an unbounded `while` — on timeout it names the unhealthy service, shows its log tail, and states the rollback remedy; nothing on any failure path runs `docker compose down`, `volume rm`, or touches `.env`.
- **Task 3 — setup token, ufw advisory, summary, install.log:** `noodara_read_setup_token` extracts the last `NOODARA_SETUP_TOKEN=` line from `docker compose logs api`, validating its shape before returning it (D-13, T-06-45). `noodara_check_ufw` is read-only, printing 06-RESEARCH.md Pitfall 5's exact wording (the "typically bypass" qualifier), the precise `ufw allow <port>/tcp` command, and a cloud-firewall reminder — never a mutating ufw subcommand. `noodara_redact_diagnostic_text` masks a setup-token line or a userinfo-bearing connection string, applied to both Task 2's `noodara_compose_up`/`noodara_wait_for_health` log-tail printing (a fix layered onto Task 2's own code, within this task's scope). `noodara_write_log` appends non-secret step/variable-name lines to `install.log`, mode 600. `noodara_print_summary` prints the panel URL, the token or admin-exists/admin-created line (never a fabricated token), the HTTP warning, the ufw advisory, and the upgrade rollback hint.
- **Cross-plan regression fix:** `tests/unit/installer/skeleton.test.ts`'s "reaches `noodara_main` and exits 0" assertion was written against 06-01's banner-only stub; Task 1's real preflight wiring made running `install.sh` directly, unprivileged, genuinely (and correctly) fail with exit 10 (not-root) instead. Updated the assertion to the new, correct behavior — not a regression, `noodara_main`'s real work simply starts where the stub used to return immediately.
- 106 new tests (`main-flow.test.ts`, proportioned across `/bin/sh` + real `/bin/dash`); full `pnpm test` 126 files / 2055 tests green (2055 = 1949 baseline + 106 net new); `pnpm check:posix-sh` clean (1837 lines); `pnpm typecheck`/`pnpm lint` clean.

## Task Commits

Each task was TDD'd with RED and GREEN as separate commits, plus one standalone regression fix:

1. **Task 1: Install-directory bootstrap, compose placement, fresh-vs-upgrade branch**
   - `4f2ee24` test(06-09): add failing tests for install-dir bootstrap and fresh-vs-upgrade branch
   - `ca8019f` feat(06-09): wire install-dir bootstrap, compose placement and fresh-vs-upgrade branch
2. **Task 2: Pull, compose up, health-wait diagnostics**
   - `344f0ad` test(06-09): add failing tests for pull, compose up, and health-wait diagnostics
   - `d62f5c8` feat(06-09): wire image pull, compose up, and D-12 health-wait diagnostics
3. **Cross-plan regression fix (discovered running the full suite before Task 3, root-caused to Task 1's own commit)**
   - `c759066` fix(06-09): update skeleton test for noodara_main's real preflight behavior
4. **Task 3: Setup token, ufw advisory, summary, install.log**
   - `8cef021` test(06-09): add failing tests for setup token, ufw advisory, summary and install.log
   - `37533b1` feat(06-09): wire setup token, ufw advisory, install.log and the final summary

_Every RED commit was confirmed failing for the expected reason against the pre-task `install.sh` (exit 127 for not-yet-defined functions, or a wrong exit code/message for behavior changes layered onto already-existing functions) before its paired GREEN commit landed — verified by temporarily checking out the prior commit's `install.sh` via `git show HEAD:noodara/code/install.sh`, running the new test file, then restoring the working-tree implementation._

## Files Created/Modified

- `install.sh` — `noodara_env_get_value`, `noodara_is_installed`, `noodara_prepare_install_dir`, `noodara_place_compose_file` (+ `_noodara_pcf_lp`), `noodara_compose_json_field_for_service`, `noodara_service_health`/`noodara_service_exit_code`, `noodara_migrate_did_fail`, `noodara_pull_images`, `noodara_compose_up`, `NOODARA_HEALTH_WAIT_ATTEMPTS`/`NOODARA_HEALTH_WAIT_INTERVAL`, `noodara_wait_for_health`, `noodara_redact_diagnostic_text`, `noodara_read_setup_token`, `noodara_check_ufw`, `NOODARA_INSTALL_LOG_FILE`, `noodara_write_log`, `noodara_print_summary`, and the fully rewired `noodara_main` (1263 → 1837 lines)
- `tests/unit/installer/main-flow.test.ts` — New file, 106 test cases under `describe.each(posixInterpreters())` (plus interpreter-agnostic structural tests), covering every acceptance criterion listed in the plan's three tasks
- `tests/unit/installer/skeleton.test.ts` — One assertion updated to reflect `noodara_main`'s new real preflight behavior (exit 10, not 0, when run directly unprivileged)

## Decisions Made

See `key-decisions` in the frontmatter above. In short: embedding was chosen over the network-fetch fallback for the compose file (the printf-substitution workaround solved the only real obstacle); `noodara_print_summary` takes explicit args rather than relying on this file's own global-variable-leakage precedent, for testability; `noodara_read_setup_token` validates shape before ever returning a value.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `noodara_wait_for_health`'s D-12 rollback hint referenced a process environment variable a real install never sets**
- **Found during:** Task 3's own full-flow D-12 test (writing the test surfaced the gap before it was ever committed as Task 2's final form)
- **Issue:** Task 2's original implementation read `${NOODARA_PREVIOUS_VERSION:-<placeholder>}` — but `NOODARA_PREVIOUS_VERSION` is a *key inside `.env`*, written by `noodara_main`/`noodara_generate_env`/`noodara_set_env_value`; it is never exported as a real shell environment variable during an actual install. A genuine health-check failure would always have printed the generic placeholder text instead of the real previous version.
- **Fix:** `noodara_wait_for_health` now prefers an env-var override (kept for isolated unit tests of the function alone), then falls back to reading the value directly out of `.env` via `noodara_env_get_value`, then a generic placeholder only if truly nothing is known.
- **Files modified:** `install.sh`
- **Verification:** The new full-flow D-12 test (`tests/unit/installer/main-flow.test.ts`) seeds a real `.env` with `NOODARA_PREVIOUS_VERSION`, runs the whole `noodara_main` through a failing health check, and asserts the real value (`NOODARA_VERSION=1.0.0`) appears in stderr — this would have failed against the original single-source design.
- **Committed in:** `37533b1` (Task 3 GREEN commit)

**2. [Rule 3 - Blocking, cross-plan] `tests/unit/installer/skeleton.test.ts`'s stale "exits 0" assertion**
- **Found during:** Running the full `pnpm test` suite before Task 3 (the targeted `main-flow.test.ts` runs during Tasks 1–2 never surfaced this, since it lives in a different file)
- **Issue:** 06-01's own skeleton test asserted that running `install.sh` directly with no arguments always exits 0 — true only while `noodara_main` was a banner-only stub. Task 1 restructured `noodara_main` to run real preflight, so the same invocation (unprivileged, on the CI/dev machine) now correctly fails with exit 10 (`not-root`). The old assertion became factually wrong the moment Task 1's commit landed, not a new defect introduced by Task 3.
- **Fix:** Updated the assertion to expect exit 10 and a `root`-mentioning stderr message, with a comment explaining why this is the correct new behavior, not a regression.
- **Files modified:** `tests/unit/installer/skeleton.test.ts`
- **Verification:** `pnpm exec vitest run tests/unit/installer/skeleton.test.ts` — 15/15 pass; full `pnpm test` — 126 files / 2055 tests green.
- **Committed in:** `c759066` (standalone fix commit, before Task 3's own test/feat pair)

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug in this plan's own new code, 1 Rule 3 cross-plan test-assertion fix directly caused by Task 1's own change). No scope creep beyond what discovering and fixing each required.

**Process gap, disclosed honestly (hard_rule #11):** the skeleton.test.ts breakage was actually introduced by Task 1's own commit (`ca8019f`), not discovered until Task 3's full-suite run — Task 1 and Task 2's own verification only ran the targeted `main-flow.test.ts` file, not the full `pnpm test` suite, so this gap went undetected across two task boundaries. It is disclosed here rather than silently folded into Task 3's commit as if it were new-to-Task-3 work.

## How the compose file reaches the install directory

**Embedded**, not downloaded. `noodara_place_compose_file` writes the repo's own `docker-compose.yml` content via three quoted heredocs (`<<'NOODARA_COMPOSE_EOF_A/B/C'`) interleaved with two single-`%s` `printf` substitutions, because the real file's two `healthcheck.test` lines contain the literal JS arrow-function substring `catch(()=>...)` — an unavoidable, genuine `((` two-character sequence that `scripts/check-posix-sh.mjs`'s `arith-command` rule flags as a bashism false positive (it cannot distinguish a heredoc's literal body text from bash's `((...))` compound command). hard_rule #7 forbids editing that gate. The workaround: `_noodara_pcf_lp` holds a single `(` character as a shell variable; the two affected lines are assembled via `printf`'s `%s` substitution, so the literal two-character sequence `((` never appears together on any physical *source* line of `install.sh` — it only comes together in the *output* file, at runtime, after substitution. Verified: `node scripts/check-posix-sh.mjs install.sh` is clean, and a runtime-equivalence test (`noodara_place_compose_file` run against a tmpdir, then diffed against the repo's real `docker-compose.yml`) proves the written file is byte-for-byte identical under both `/bin/sh` and real `/bin/dash` — chosen over a static heredoc-extraction test because the multi-segment construction makes static extraction awkward, and the runtime proof is strictly stronger (it proves what the installer actually writes, not merely its source shape).

## Known Stubs

None — every function this plan's `noodara_main` calls is a real, tested implementation; no UI or data-flow stub, no placeholder text.

## Threat Flags

None — every new surface this plan introduces (the setup-token extraction from container logs, the D-12 diagnostic log tail, the ufw read-only advisory, `install.log`'s own contents) was already named and mitigated in this plan's own `<threat_model>` (T-06-09, T-06-41, T-06-42, T-06-05, T-06-43, T-06-44, T-06-45, T-06-46). No new, un-modeled surface was introduced.

## Rules Explicitly Not Fully Implemented (hard_rule's own requirement to disclose)

- **Hard rule #9's `pnpm test:integration`/`pnpm test:e2e`/installer-DinD-suite prohibition** was honored as written — none of those suites were run. Their own real-VPS-shaped proof of this plan's flow is Plans 06-10 through 06-12's job, not this one's.
- **INST-01, INST-02, INST-04, INST-05 intentionally NOT marked complete**, per this plan's own objective text ("leave them Pending unless the plan alone proves them end to end (it cannot, without a real run)"). `noodara_main` genuinely now performs the full described flow at the shell-unit layer (D-18 layer 1) for the first time in this phase, and every plan's own SUMMARY in this phase (06-01 through 06-08) already established the identical precedent for the same requirement family. The real, end-to-end proof against a genuine Ubuntu 22.04/24.04 VPS or DinD container is Plans 06-10 through 06-12's job. `REQUIREMENTS.md`'s four checkboxes remain `[ ]` (Pending); `requirements.mark-complete` was deliberately not run for this plan.
- **`docs/install.md`'s own copy of the ufw wording** does not exist yet (Plan 06-14) — this plan's `noodara_check_ufw` comment says "see docs/install.md", a forward reference that is not yet backed by a real file. Not a defect of this plan; flagged so Plan 06-14 knows the exact wording to quote verbatim.
- **Every rule in hard_rules #1–#11 was otherwise followed in full**: no attribution trailers (verified via `git log -1 --format=%B` after every commit), no forbidden git commands, no `git add .`, staged only by explicit path, `git diff --cached --name-only` checked before every commit, no `prettier --write`, TDD RED-then-GREEN for every task with genuine RED confirmed against the prior commit's `install.sh`, only the required test files/`pnpm test`/`pnpm lint`/`pnpm typecheck`/`pnpm check:posix-sh` run (no integration/e2e/installer-DinD suite), the POSIX gate's known false positives worked around without editing it, no real `noodara_main` run unstubbed, no real `docker compose up/down/pull`, no write under `/opt`/`/etc`/`/var`/`/usr`, every filesystem target injected via `mkdtemp`, PATH restricted where the plan required it, no network in tests, no secret ever passed on a command line, no `set -x`, `docs/ui-build-prompt.md` never read/edited/staged/committed, `git stash list` empty throughout.

## Issues Encountered

- **The compose-embedding "((" false positive** (see "How the compose file reaches the install directory" above) — the single most significant implementation challenge this plan encountered, solved with a printf-substitution workaround rather than the network-fetch fallback.
- **`\command` does not bypass a same-named shell function** in either dash or bash (confirmed empirically: `dash -c 'command() { echo shadowed; }; \command -v ls'` still prints "shadowed") — an early test-fixture design attempted to delegate an overridden `command()` shadow back to the real builtin via a leading backslash (matching the common belief that a backslash defeats function/alias resolution), which caused infinite recursion and a hung/crashed test process. Fixed by reverting to a blanket `command() { return 0; }` test fixture (matching `preflight.test.ts`'s own established pattern) and relying on `noodara_check_ufw`'s own graceful `ufw status || return 0` fallback to produce the correct "ufw absent" test outcome regardless. This is a test-fixture-only issue, not a production `install.sh` defect.
- **Two `docker()` test-stub design details required care**: (a) shadowing `id` to make `noodara_check_root` pass also makes `noodara_secure_env_file`'s own `id -u` re-check believe the caller is genuinely root, escalating a real (non-root, macOS dev machine) `chown` failure into a fatal error — fixed by also shadowing `chown() { return 0; }` in the shared test fixture; (b) the shared fixture's generic `docker()` shadow had to explicitly handle `compose ps --format json` (returning both services healthy) once `noodara_main` started calling the real health-wait loop, otherwise every full-flow test slept through the real 60×5s default timeout — fixed by adding that case and setting `NOODARA_HEALTH_WAIT_ATTEMPTS=3`/`NOODARA_HEALTH_WAIT_INTERVAL=0` as the fixture's own defaults.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `noodara_main` is now a complete, ordered, real install flow — every function Plans 06-02 through 06-08 built and unit-tested in isolation is now genuinely composed and reachable through the single real entry point.
- Plans 06-10 through 06-12 (Docker-in-Docker layer-2 integration, fresh-install/upgrade/preflight scenarios against real Ubuntu 22.04/24.04 containers) can now exercise this plan's `noodara_main` for real, end to end — no rework expected in `install.sh` itself, only new test infrastructure.
- Plan 06-14 (docs) should quote `noodara_check_ufw`'s exact wording verbatim from `install.sh` rather than re-deriving it, per this plan's own comment pointing at `docs/install.md`.
- Known follow-up (not a blocker): the two-commit-boundary process gap (skeleton.test.ts's staleness going undetected across Task 1/2) is a reminder for future plans in this phase to run the FULL `pnpm test` suite, not just the targeted new test file, before considering a task genuinely complete — noted here for the orchestrator's own process record, not as an unresolved defect.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 4 relevant files (`install.sh`, `tests/unit/installer/main-flow.test.ts`, `tests/unit/installer/skeleton.test.ts`, this SUMMARY) verified present on disk; all 7 task/fix commit hashes (`4f2ee24`, `ca8019f`, `344f0ad`, `d62f5c8`, `c759066`, `8cef021`, `37533b1`) verified present in `git log --oneline --all`.

## Post-execution fix

An orchestrator audit of this plan's `noodara_main` found four bugs on the re-run/upgrade path
(all on files this plan itself touched — INST-02 idempotency, D-09/D-10/D-12/D-13). Fixed here as
a direct follow-up, TDD RED→GREEN, no new `PLAN.md`.

### Finding A — every re-run failed preflight with "port in use"

`noodara_check_port` failed with exit 16 whenever the panel port was listening — on an existing
installation that listener is Noodara's own `web` container, so every re-run/upgrade died in
preflight before doing anything. Fixed: on an existing installation (`noodara_is_installed`, D-10's
own `.env`-exists signal) the busy-port check is skipped entirely — that port being in use is
expected. A fresh install keeps the exact original check. An operator-supplied `NOODARA_PORT` that
disagrees with the port already recorded in `.env` gets a single warning naming both values and
pointing at editing `.env`; `.env` always wins (the additive merge already never rewrote it — this
warning makes that guarantee visible instead of a silent no-op). `noodara_preflight`'s documented
order and its "writes nothing" invariant are both unchanged.

### Finding B — the re-run summary could advertise the wrong panel URL/port; upgrade needlessly depended on public-IP lookups

`noodara_main` re-resolved the public URL and port from scratch on every upgrade (three external
IP services, then `ip route`) even though `.env` already had the answer, and could print a
different URL/port than the one actually written to `.env`. A host with no outbound access to
those services used to fail an upgrade with exit 41 for no real reason. Fixed: a new
`noodara_resolve_installed_public_url` reads `NOODARA_PUBLIC_URL` straight out of `.env` (via
`noodara_env_get_value`) and only falls back to network resolution when the key is genuinely
missing from `.env`; the panel port is read the same way directly in `noodara_main`. The value read
back from `.env` is still passed through `noodara_validate_public_url` before ever being printed
(an operator may have hand-edited the file). `noodara_check_ufw` and `noodara_print_summary` now
take the already-resolved port as an explicit parameter (falling back to the original
`noodara_resolve_port` when called with none, so every pre-existing direct caller/test is
unaffected) so the ufw advisory and the summary can never disagree with what is actually in `.env`.
An explicit `NOODARA_PUBLIC_URL` override that disagrees with the recorded value gets the identical
single warning pattern as the port above.

### Finding C — a same-version re-run was not the no-op D-09 requires

D-09's own text is explicit, not silent, about this case: *"si ya está en esa versión, no cambia
nada y solo verifica salud"* ("if already on that version, nothing changes and it only verifies
health"). The pre-fix code still wrote a fresh `.env.bak-<timestamp>` (a full copy of every secret
on disk), rewrote `.env`'s `NOODARA_VERSION` line, re-placed the compose file, pulled images and ran
`docker compose up -d` on every same-version re-run. Fixed: `noodara_main` now detects a true no-op
— target version equals `.env`'s `NOODARA_VERSION` **and** every key the additive merge would
otherwise append (`NOODARA_IMAGE_PREFIX`, `NOODARA_PORT`, `NOODARA_PUBLIC_URL`) is already present
— and, in that case, skips the backup/merge, skips `docker compose pull`, **and skips
`docker compose up -d` itself**, going straight to the health check and summary. **Decision** (D-09
was not actually silent, so this is a literal reading, not a judgment call): `docker compose up -d`
does **not** run on a true no-op, matching D-09's own "nothing changes" wording exactly — it does
not attempt to repair a manually-stopped stack in that case, which is D-09's stated behavior for
v0.1, not an oversight. When a release adds a required key, the additive merge (with its one
backup) still runs even at the same version. `docker-compose.yml` is still re-placed unconditionally
(harmless — it is always the same static content install.sh itself embeds, regardless of
`NOODARA_VERSION`).

### Finding D — a stale setup token could be printed after an admin already exists

`noodara_read_setup_token` takes the last `NOODARA_SETUP_TOKEN=` line out of
`docker compose logs api`'s full log **history**. `bootstrapAdmin` only re-emits that line at boot
time, so on a re-run where the `api` container was not recreated (Finding C's own no-op path is
exactly that case), an earlier boot's token line is still sitting in the log even after an admin
has since been created through the panel — the summary would print a stale, meaningless token,
contradicting D-13/INST-04.

**Chosen signal:** `noodara_probe_admin_exists` reuses the *existing* `POST /api/setup` route
(`apps/control-plane/src/routes/setup.ts`) exactly as it already behaves — **no
`apps/control-plane` change was needed**, contrary to the objective's fallback-heuristic framing.
Read before choosing this: the route calls `adminExists()` **before** ever looking at the submitted
token (D-02's "the setup route disappears once an admin exists" rule), so a deliberately-invalid,
non-secret placeholder token/email/password can never succeed either way, and the response status
alone reveals which branch was taken — 404 means an admin exists, 400 (`setup-service.ts`'s own
`TOKEN_INVALID`) means it does not. `redeemSetupToken` looks the token up by its hash **before**
validating email/password, so the placeholder email/password are never reached, and this failure
path writes zero activity events. `login-guard.ts`'s progressive lockout (AUTH-04) only hooks Better
Auth's own `/sign-in/email` path, never this plain Fastify route — confirmed by reading it, per the
objective's own instruction. The probe runs via `docker compose exec -T api node -e ...` (the same
"no host port needed" pattern this repo's own compose healthchecks already use for `/health`),
since `api` publishes no host port (same-origin, D-10).

**Limits, stated honestly:** the probe prints exactly one of `exists`/`missing`/`unknown` and always
exits 0 — it never fails the whole installer over its own inconclusive result.
`noodara_print_summary` treats `exists` as authoritative (skips the log read entirely) and falls
back to the original D-13 log-reading behavior for `missing`/`unknown`. This means: if the exec
probe itself cannot run for some other reason (an unusual `docker compose exec` failure, a network
error *inside* the container reaching its own `127.0.0.1:3000`), a same-version no-op re-run could
still, in that narrow case, print a stale token exactly as before this fix — this is the one
documented, honest limitation of this approach. No `apps/control-plane` change is proposed as a
follow-up, since the existing route already provides a fully reliable signal in the normal case.

### Also (process)

The full `pnpm test` unit suite is now run after every task by this fix's own process (not just the
touched test file) — the objective's own prompt named this as the concrete failure mode from the
original plan execution (two commits shipped with `skeleton.test.ts` red). Verified clean at every
commit boundary in this follow-up.

### Verification

- `pnpm check:posix-sh` — clean (2009 lines).
- `pnpm test` — 126 files / 2083 tests green. 14 new unique `it()` cases added across
  `preflight.test.ts` (5, Finding A) and `main-flow.test.ts` (9, Findings B/C/D) — 28 test
  executions once doubled across `/bin/sh` and real `/bin/dash`; the canary-extension commit added
  assertions to existing/new test bodies rather than further `it()` blocks.
- `pnpm lint` / `pnpm typecheck` — clean (9/8 cached tasks; neither `install.sh` nor
  `tests/unit/installer/*.test.ts` are part of any package's lint/typecheck project, matching this
  phase's pre-existing convention).
- Orchestrator's own Finding A repro (install dir with `.env`, `ss` reporting the recorded port
  listening) now passes preflight; a fresh install with a busy port still exits 16.
- Same-version re-run: `.env` byte-identical (SHA-256 checksum before/after), zero `.env.bak-*`
  created, no `compose pull`/`compose up -d` in the recorded `docker` argv, health check and
  summary still ran.
- Canary/secret-leak coverage extended to the same-version, version-changed-upgrade and
  half-finished-install re-run paths — all green.

### Commits

- `8dae6bf` test(06-09): add failing tests for re-run preflight port handling (Finding A)
- `60af6ec` fix(06-09): stop preflight failing an existing installation's own busy panel port (Finding A)
- `5900be7` test(06-09): add failing tests for upgrade URL/port sourcing, same-version no-op and stale setup token (Findings B, C, D)
- `8dc27a4` fix(06-09): source re-run URL/port from .env, no-op a same-version re-run, and probe admin existence before trusting a stale token (Findings B, C, D)
- `8d83299` test(06-09): extend secret-leak canary coverage to same-version, upgrade and half-finished re-run paths

### Not fully implemented

- Nothing from the four findings was deferred — A, B, C and D are all fixed and tested.
- Finding D's "unknown" fallback path (log-reading heuristic) retains the same theoretical staleness
  window as before this fix, in the narrow case where the exec-based probe itself cannot run —
  documented above, not silently left out.
