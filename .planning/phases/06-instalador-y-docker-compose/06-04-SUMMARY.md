---
phase: 06-instalador-y-docker-compose
plan: 04
subsystem: infra
tags: [posix-sh, dash, openssl, env-generation, secrets, vitest]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 01
    provides: install.sh skeleton (exit-code table, noodara_step/warn/note/fail, source-only guard), tests/unit/installer/sh-harness.ts, pnpm check:posix-sh
  - phase: 06-instalador-y-docker-compose
    plan: 02
    provides: install.sh preflight predicates (noodara_check_base_commands already requires openssl)
provides:
  - "install.sh: noodara_generate_secret (base64|hex), noodara_build_database_url/noodara_build_redis_url (hex-in-URL round-trip proof), noodara_secure_env_file, noodara_generate_env (fresh mode-600 .env, HTTP cookie opt-out, admin pre-seed pair), noodara_env_has_key/noodara_env_append_if_missing/noodara_backup_env/noodara_set_env_value/noodara_merge_env (D-11 additive merge + timestamped backup)"
  - "tests/unit/installer/env-file.test.ts: 52 cases (26 per interpreter x 2 interpreters) proving secret generation, fresh .env generation/permissions/cookie-opt-out/admin-pair, and the additive merge+backup mechanism under real /bin/sh and /bin/dash"
  - "tests/integration/installer/env-contract.test.ts: proves a generated .env is accepted by the real compiled apps/control-plane/dist/env.js validator, plus the base64-in-URL negative control"
  - ".env.example: NOODARA_COOKIE_INSECURE documented as the HTTP-only opt-out"
affects: [06-07-compose-production, 06-09-main-flow, 06-10-dind-harness, 06-12-preflight-scenarios]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Every secret embedded in a URL (DATABASE_URL/REDIS_URL) is openssl rand -hex 32, never base64 -- a base64 secret's '/' throws 'Invalid URL' when new URL() parses it (proven by env-contract.test.ts's negative control), while hex is always URL-unreserved and round-trips byte-for-byte"
    - "D-11 additive merge never reads an existing .env value: noodara_env_has_key/noodara_env_append_if_missing only ever check presence via an anchored grep -q '^KEY=', so a value containing '#', '=' or base64 '==' padding is never touched because it is never parsed"
    - "noodara_set_env_value is the one exception: it rewrites a single anchored '^KEY=' line via awk, writing to a same-directory temp file under umask 077 then mv-ing over the original (T-06-23 crash-safety)"
    - "noodara_secure_env_file's chown failure is swallowed only when the caller is non-root (dev/test); escalated to noodara_fail env-write-failed when the caller genuinely is root (the real /opt/noodara target)"

key-files:
  created:
    - tests/unit/installer/env-file.test.ts
    - tests/integration/installer/env-contract.test.ts
  modified:
    - install.sh
    - .env.example

key-decisions:
  - "noodara_merge_env <path> <version> [<key> <value>]... does NOT auto-maintain NOODARA_PREVIOUS_VERSION -- that key is written only once, by noodara_generate_env at fresh-install time (initialized equal to NOODARA_VERSION), keeping the plan's own 'changes exactly one line' merge test literally true; a future upgrade-flow caller (Plan 06-09) that wants D-12's rollback hint to reflect a genuine prior version reads the current NOODARA_VERSION before calling noodara_merge_env and calls the generic noodara_set_env_value directly for NOODARA_PREVIOUS_VERSION"
  - "noodara_merge_env's variadic [<key> <value>]... trailing arguments are what let 'a complete file changes exactly one line' and 'a file missing a newly required key gets it appended' both hold with the same function: extra pairs for already-present keys are safe no-ops via noodara_env_append_if_missing"
  - "BETTER_AUTH_SECRET (not embedded in a URL) still generated as hex, not base64, for consistency with every other non-master-key secret -- only NOODARA_MASTER_KEY uses base64, since it is the one value env.ts requires to decode to exactly 32 raw bytes"

patterns-established:
  - "Secret round-trip proof pattern: generate via install.sh's own function inside a test snippet, print both the derived value and the raw input via printf, then assert byte-for-byte equality in TypeScript after decodeURIComponent -- reused for both DATABASE_URL and REDIS_URL"
  - "No-secret-in-output proof pattern: capture stdout+stderr from a real generation call, then assert none of the parsed-out generated values appears in either stream (mirrors tests/integration/activity/canary.test.ts's canary discipline, applied to shell output)"

requirements-completed: []  # INST-01/INST-02/INST-05 intentionally NOT marked complete -- see Deviations (same precedent as 06-01/06-02).

# Metrics
duration: ~6min (commits 04:31:15-04:36:34, first-to-last task commit; total session including context reading longer, not separately timestamped)
completed: 2026-09-21
---

# Phase 06 Plan 04: `.env` secret generation and additive merge Summary

**`install.sh` gains `noodara_generate_secret`/URL builders (hex-in-URL, proven against a base64-breaks-URL negative control), `noodara_generate_env` (fresh mode-600 `.env` with the D-05 HTTP cookie opt-out and D-04 admin pre-seed pair), and the D-11 additive-merge/backup mechanism (`noodara_env_has_key`/`noodara_env_append_if_missing`/`noodara_backup_env`/`noodara_set_env_value`/`noodara_merge_env`) -- every generated secret proven acceptable to the real, already-shipped `apps/control-plane/src/env.ts` fail-fast validator via a compiled-`dist/env.js` contract test, not a re-implementation of its rules.**

## Performance

- **Duration:** ~6 min for the six task commits (04:31:15-04:36:34); total session (context reading + implementation) longer but not separately timestamped
- **Tasks:** 3 (each TDD, RED then GREEN as separate commits)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- `noodara_generate_secret base64|hex`: `openssl rand -base64 32` (decodes to exactly 32 bytes, the only shape `NOODARA_MASTER_KEY`'s validator accepts) / `openssl rand -hex 32` (64 lowercase hex chars, used for every other secret). `noodara_build_database_url`/`noodara_build_redis_url` hardcode the Compose-internal `postgres`/`redis` hostnames and the `noodara` role/database name. A dedicated negative-control test proves a base64 secret containing `/` throws `Invalid URL` when parsed, pinning the exact regression (Dokploy-adjacent URL-corruption class) this task exists to prevent.
- `noodara_generate_env <path> <public_url> <port> <version> <image_prefix>`: creates a missing parent directory mode 700 under `umask 077`, writes a mode-600 `.env` with exactly the 14-key inventory (`NOODARA_VERSION`, `NOODARA_PREVIOUS_VERSION`, `NOODARA_IMAGE_PREFIX`, `NOODARA_PORT`, `NOODARA_PUBLIC_URL`, `NOODARA_MASTER_KEY`, `BETTER_AUTH_SECRET`, `POSTGRES_USER/PASSWORD/DB`, `REDIS_PASSWORD`, `DATABASE_URL`, `REDIS_URL`, `PORT`), writes `NOODARA_COOKIE_INSECURE=true` only for an `http://` public URL (absent entirely for `https://`), and writes the admin pre-seed pair only when both `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` are supplied (warning naming both variable names, never a value, when only one is set). Proven: two fresh generations differ for every secret key; no generated secret value appears in stdout or stderr of the whole generation.
- `noodara_secure_env_file`: re-asserts mode 600 + `chown root:root` on every call, tolerating a non-root test caller while escalating a real chown failure to `noodara_fail env-write-failed` when the caller genuinely is root.
- D-11 additive merge: `noodara_env_has_key` (anchored `^KEY=` match, no suffix/prefix false positives), `noodara_env_append_if_missing` (append-only-if-absent), `noodara_backup_env` (`<path>.bak-<timestamp>`, mode 600), `noodara_set_env_value` (single-line rewrite via awk, crash-safe temp-file-then-`mv`), `noodara_merge_env` (backs up once, rewrites only `NOODARA_VERSION`, appends any given extra `<key> <value>` pairs only when missing, re-secures at the end). Proven: a merge over a complete fixture (including values containing `#`, `=`, and base64 `==` padding) changes exactly one line; a merge over a fixture missing a key appends it and leaves every pre-existing line byte-identical.
- `tests/integration/installer/env-contract.test.ts`: generates a full variable set by calling `install.sh`'s own real functions through `runInstallerShell` (never re-implemented in TypeScript), spawns a fresh `node --input-type=module` process that only imports the compiled `apps/control-plane/dist/env.js`, and asserts exit 0 with no `NOODARA_CONFIG_ERROR` on stderr -- plus the base64-in-URL negative control.
- `.env.example` gains the previously-undocumented `NOODARA_COOKIE_INSECURE` entry.
- Full suite: `pnpm test` 123 files / 1693 tests green; `pnpm check:posix-sh` clean (522 lines); `pnpm typecheck` and `pnpm lint` clean; the real repo `.env` checksum verified byte-identical before and after (`a49dbb13d4d714ed9d8c0ffe50a5a5367c335cd4`, never touched).

## Task Commits

Each task was TDD'd with RED and GREEN as separate commits:

1. **Task 1: Secret generation with shapes the real validator accepts**
   - `99c709d` test(06-04): add failing tests for secret generation and URL builders
   - `e098a48` feat(06-04): add secret generation and URL builders to install.sh
2. **Task 2: Fresh `.env` generation, permissions, and the HTTP cookie opt-out**
   - `e5a79aa` test(06-04): add failing tests for fresh .env generation and permissions
   - `8127b46` feat(06-04): generate fresh .env with mode 600 and HTTP cookie opt-out
3. **Task 3: Additive merge and timestamped backup for an existing `.env` (D-11)**
   - `993f21e` test(06-04): add failing tests for additive .env merge and backup
   - `fd215d0` feat(06-04): add additive .env merge and timestamped backup for re-runs

_Every RED commit was confirmed failing for the expected reason before its paired GREEN commit landed. Task 1's second test file (`tests/integration/installer/env-contract.test.ts`) was verified RED by temporarily reverting `install.sh` to its pre-Task-1 state, re-running the suite (both cases failed: "generation failed with status 127" and "could not find a base64 secret containing '/'" since the underlying shell function did not exist), then restoring the implementation before the single `feat:` commit that covers both test files' behavior._

## Files Created/Modified

- `install.sh` - Adds `noodara_generate_secret`, `noodara_build_database_url`, `noodara_build_redis_url`, `noodara_secure_env_file`, `noodara_generate_env`, `noodara_env_has_key`, `noodara_env_append_if_missing`, `noodara_backup_env`, `noodara_set_env_value`, `noodara_merge_env` (300 -> 522 lines)
- `tests/unit/installer/env-file.test.ts` - New file, 52 test cases (26 per interpreter) under `describe.each(posixInterpreters())`, covering secret generation, URL builders, fresh `.env` generation, permissions, cookie opt-out, admin pre-seed, and the D-11 merge/backup mechanism
- `tests/integration/installer/env-contract.test.ts` - New file, 2 test cases: real-validator acceptance proof and the base64-in-URL negative control
- `.env.example` - Adds the previously-undocumented `NOODARA_COOKIE_INSECURE` entry

## Decisions Made

See `key-decisions` in the frontmatter above -- the `NOODARA_PREVIOUS_VERSION` ownership split (written once by `noodara_generate_env`, not auto-maintained by `noodara_merge_env`) is the one genuinely ambiguous corner of the plan's prose; documented in detail there. Two smaller decisions: `noodara_merge_env`'s variadic trailing `<key> <value>` pairs are what make both the "complete file, one line changes" and "missing key gets appended" behaviors provable with a single function, and `BETTER_AUTH_SECRET` uses hex (not base64) for consistency even though it is not embedded in a URL -- only `NOODARA_MASTER_KEY` needs base64's exact-32-decoded-bytes shape.

## Deviations from Plan

**1. [hard_rule #11 -- reality over invented results] Requirements INST-01, INST-02, INST-05 intentionally NOT marked complete.** The plan's frontmatter lists `requirements: [INST-01, INST-02, INST-05]`, and the standard state-update step calls `requirements.mark-complete` on every listed ID. All three describe end-to-end installer behavior reachable only through the real `curl | sh` entrypoint: INST-01 ("...con un solo comando... genera `.env`... levanta api/worker/web/postgres/redis..."), INST-02 ("Volver a ejecutar el instalador sobre una instalación existente no destruye datos ni secrets"), INST-05 ("El instalador acepta variables opcionales... para crear el admin"). This plan built and proved the `.env` generation/merge machinery in isolation at the shell-unit and real-validator-contract layers (D-18 layer 1), but `noodara_main` still only prints its banner -- none of this plan's new functions are wired into the real install flow yet (Plan 06-09 does that, per 06-01/06-02's own identical precedent for the same requirement family). `REQUIREMENTS.md`'s INST-01/INST-02/INST-05 checkboxes remain `[ ]` (Pending).

No auto-fixed bugs, missing critical functionality, or blocking issues (Rules 1-3) were encountered -- every RED confirmed failing for the expected reason, and every GREEN passed on the first attempt with no fix-up cycles.

## Known Stubs

None -- no UI or data-flow stubs; this plan is shell logic and tests only.

## Threat Flags

None -- every new surface (secret generation, `.env` write path, additive merge) was already named and mitigated in this plan's own `<threat_model>` (T-06-03, T-06-04, T-06-02, T-06-11, T-06-23, T-06-24, T-06-SC); no new, un-modeled surface was introduced.

## Issues Encountered

None beyond the requirements-tracking deviation above.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `noodara_generate_env`/`noodara_merge_env` are ready for Plan 06-09's `noodara_main` to call directly once preflight (06-02), Docker install (06-08), and compose orchestration (06-07) all exist.
- `noodara_set_env_value` is the documented mechanism a future upgrade flow uses to record a genuine `NOODARA_PREVIOUS_VERSION` before calling `noodara_merge_env` -- see the key-decisions note above.
- The real-validator contract test (`env-contract.test.ts`) is a reusable pattern for Plan 06-07/06-09's own compose-orchestration tests: spawn a fresh `node` process importing `dist/env.js`, never import `env.ts` directly.
- No blockers for Plan 06-05 (next plan in this phase's wave sequence).

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 5 relevant files (`install.sh`, `.env.example`, `tests/unit/installer/env-file.test.ts`, `tests/integration/installer/env-contract.test.ts`, this SUMMARY) verified present on disk; all 6 task commit hashes (`99c709d`, `e098a48`, `e5a79aa`, `8127b46`, `993f21e`, `fd215d0`) plus this plan's own docs commit (`ef6f6d3`) verified present in `git log --oneline --all`.
