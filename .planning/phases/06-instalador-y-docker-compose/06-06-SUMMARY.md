---
phase: 06-instalador-y-docker-compose
plan: 06
subsystem: infra
tags: [posix-sh, dash, curl, github-releases, ipv4, vitest]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 01
    provides: install.sh skeleton (exit-code table, noodara_step/warn/note/fail, source-only guard), tests/unit/installer/sh-harness.ts, pnpm check:posix-sh
  - phase: 06-instalador-y-docker-compose
    plan: 02
    provides: install.sh noodara_resolve_port (the panel port every resolved public URL embeds)
  - phase: 06-instalador-y-docker-compose
    plan: 04
    provides: install.sh noodara_env_assert_single_line / noodara_env_assert_no_single_quote (reused to validate the D-19 registry override before it can reach .env)
provides:
  - "install.sh: noodara_fetch_url (the single curl seam, body/redirect modes, https-only + TLS 1.2 + bounded timeouts), noodara_normalize_tag, noodara_validate_tag, noodara_resolve_version (D-04: NOODARA_VERSION override > releases/latest redirect > GitHub API grep/sed fallback, exit 40 on total failure), noodara_resolve_image_prefix (D-01/D-19: NOODARA_REGISTRY/NOODARA_REPO_OWNER default or the undocumented NOODARA_INTERNAL_IMAGE_PREFIX test-only override), noodara_looks_like_ipv4, noodara_get_public_ip (D-07: ifconfig.io > icanhazip.com > ipecho.net/plain), noodara_get_local_ip (ip route get fallback), noodara_resolve_public_url (D-07's full three-tier order, exit 41 on total failure)"
  - "tests/unit/installer/resolution.test.ts: 83 cases (proportioned across /bin/sh + real /bin/dash for every interpreter-scoped describe block) proving every resolution branch, every fallback step, every injection-rejection class, and the curl call-site discipline, entirely against local stubs -- zero real network/DNS calls"
affects: [06-07-compose-production, 06-09-main-flow, 06-10-dind-harness, 06-15-release-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One injectable network seam: noodara_fetch_url is the only place curl is ever invoked (2 call sites, both inside its own body -- body mode and redirect mode); every resolver goes through it, and every test replaces it with a shadowing shell function, so no test ever touches the real network or DNS."
    - "curl is https-only and version-pinned defensively for anything that influences what gets installed: --proto '=https' --tlsv1.2 on both call sites, plus --connect-timeout \"$NOODARA_FETCH_TIMEOUT\" --max-time 15 (T-06-31) -- not literally what 06-06-PLAN.md's <action> text spelled out (which omitted --proto/--tlsv1.2), added per hard_rule #8's blanket requirement."
    - "Tag validation is a deny-by-default POSIX case/glob character-class check, not a regex: noodara_validate_tag rejects on first character outside [A-Za-z0-9_], any character outside [A-Za-z0-9_.-], length >128, empty, or the literal 'latest' -- the same negated-bracket-class idiom rejects newline, CR, space, =, ;, /, $, backtick and quotes in a single case arm, since none of them is in the allowed set."
    - "Every new function's internal variables are namespaced _noodara_<abbrev>_<name> (ffu/vt/rv/gpi/rpu), continuing 06-04's post-execution security-fix precedent -- this file has no `local` (strict POSIX sh), so every bare-named variable is process-global and would otherwise silently clobber a same-named caller variable the moment the helper ran. Verified directly: calling noodara_resolve_public_url/noodara_resolve_version from a caller holding its own port/ip/url/tag globals leaves all four untouched."
    - "noodara_resolve_public_url's operator-facing note (chosen URL + how to change it, D-07) is printed to stderr, not via the stdout-only noodara_note helper the <action> text names -- see Deviations."
    - "IPv4 shape validation is a loose case-pattern check (four dot-separated digit groups, then a negated-class scan for any non-[0-9.] character), deliberately not RFC-exact -- its only job is distinguishing a real IP-echo response from an HTML captive-portal body or an empty response."

key-files:
  created:
    - tests/unit/installer/resolution.test.ts
  modified:
    - install.sh

key-decisions:
  - "noodara_resolve_public_url's D-07 note (resolved URL + remedy) goes to stderr via a direct printf, not through the stdout-only noodara_note() helper the plan's <action> text literally names. noodara_resolve_version/noodara_resolve_port already establish a strict single-line-stdout return contract that every future caller depends on (public_url=$(noodara_resolve_public_url), consumed directly by noodara_generate_env in Plan 06-04, whose own noodara_env_assert_single_line guard exists specifically to catch an embedded newline). Routing the note through noodara_note's stdout would have appended a second line to that exact command-substitution capture, corrupting the returned URL with an embedded newline and tripping that very guard. Stderr reaches the real installer's terminal exactly the same way stdout does, satisfies 'operator is told the URL and how to change it', and is printed exactly once, per the plan's own 'must not print the URL twice' instruction."
  - "curl on both call sites inside noodara_fetch_url adds --proto '=https' --tlsv1.2, not literally present in 06-06-PLAN.md's own <action> text (which specified only -fsSL --connect-timeout ... --max-time 15). hard_rule #8 is unconditional for any curl call that 'influences what gets installed' -- this seam resolves both the image tag (noodara_resolve_version) and the public URL (noodara_get_public_ip), so both requirements apply squarely. Every URL this file ever calls through this seam is already a literal https:// URL, so --proto '=https' only forbids a malicious redirect target from downgrading the connection."
  - "The version-tag character-class check for NOODARA_INTERNAL_IMAGE_PREFIX (space/double-quote/dollar/backtick, plus the pre-existing single-quote/newline/CR guards from Plan 06-04) is a deny-list of four explicit case arms rather than the version tag's allow-list shape, since a registry prefix legitimately needs '/', ':' and '.' (e.g. localhost:5000/owner) that a Docker-tag allow-list would wrongly reject."
  - "NOODARA_REPO_OWNER defaults to the literal placeholder REPLACE_WITH_GITHUB_OWNER (NOODARA_REPO_NAME defaults to noodara) -- 06-CONTEXT.md D-02 confirms no GitHub repo exists yet; Plan 06-15 is where the human creates the real repo and must supply the real owner, either by editing this default or exporting NOODARA_REPO_OWNER/NOODARA_REPO_NAME before the first real curl | sh publication."

requirements-completed: []  # INST-01 intentionally NOT marked complete -- see Deviations (same precedent as every prior plan in this phase).

# Metrics
duration: ~3min (test commit to feat commit, 06:41:52-06:44:10); total session including context reading and verification longer, not separately timestamped
completed: 2026-09-21
---

# Phase 06 Plan 06: Version, public URL, and image-prefix resolution Summary

**`install.sh` gains one injectable `curl` seam (`noodara_fetch_url`, https-only + TLS 1.2 + bounded timeouts) and five resolvers built on it: `noodara_resolve_version` (D-04's operator-override > `releases/latest` redirect > GitHub API fallback chain, with `noodara_validate_tag`'s character-class allow-list rejecting every injection class including a hostile API response body), `noodara_resolve_image_prefix` (D-01's GHCR default plus D-19's undocumented registry override), and `noodara_resolve_public_url` (D-07's explicit-override > public-IP-chain > local-route-IP three-tier order, with the operator note routed to stderr to protect the function's single-line stdout return contract) -- all proven against local stubs only, zero real network or DNS calls in any of 83 new test cases.**

## Performance

- **Duration:** ~3 min for the two task commits (06:41:52-06:44:10); total session (context reading, implementation, verification) longer but not separately timestamped
- **Tasks:** 2 (each TDD, RED then GREEN as separate commits)
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- **Task 1 -- the network seam and D-04 version resolution:** `noodara_fetch_url <mode> <url>` (`body`/`redirect`) is the sole `curl` call site in the whole file (2 invocations, both inside its own body -- proven by a structural test that also documents why the plan's own literal `grep -c 'curl '` acceptance command returns 3, not 2, against this file: it false-positives on Plan 06-02's pre-existing, out-of-scope `for cmd in curl openssl ss ip awk grep` preflight line). `noodara_normalize_tag` strips one leading `v`. `noodara_validate_tag` is a POSIX `case`/glob character-class check (first char `[A-Za-z0-9_]`, rest `[A-Za-z0-9_.-]`, 1-128 chars, never `latest`) applied unconditionally to every tag source. `noodara_resolve_version` chains operator override (zero network calls, proven via an invocation-count-0 test) -> `releases/latest` redirect tail (`awk -F/`) -> GitHub API body (`sed`-parsed, one physical line required, so HTML/empty/truncated/newline-split bodies all extract nothing and fail closed) -> exit 40 naming `NOODARA_VERSION`. `noodara_resolve_image_prefix` returns `NOODARA_REGISTRY/NOODARA_REPO_OWNER` by default or the D-19 test-only `NOODARA_INTERNAL_IMAGE_PREFIX` override, itself validated against space/double-quote/dollar/backtick/single-quote/newline/CR before ever reaching `.env`.
- **Task 2 -- D-07 public URL resolution:** `noodara_looks_like_ipv4` is a loose `case`-based IPv4 shape check. `noodara_get_public_ip` tries `ifconfig.io` -> `icanhazip.com` -> `ipecho.net/plain` in that exact order (proven via a call-order log), skipping any response that doesn't shape-validate as IPv4 (an HTML captive-portal body from the first service is rejected and the chain continues). `noodara_get_local_ip` extracts the `src` field from `ip route get 1.1.1.1`. `noodara_resolve_public_url` implements D-07's full order: explicit override (byte-identical, no scheme normalisation, zero lookups) > public-IP chain (with the resolved port from `noodara_resolve_port`) > local-route IP (with a `noodara_warn` naming the private-address fallback) > exit 41 naming `NOODARA_PUBLIC_URL`. The chosen URL and remedy are printed exactly once, to stderr (see Decisions).
- 83 new tests pass (proportioned across `/bin/sh` + real `/bin/dash`); full `pnpm test` 124 files / 1802 tests green; `pnpm check:posix-sh` clean (850 lines); `pnpm typecheck`/`pnpm lint` clean (both fully cached -- no package source touched by this plan).

## Task Commits

Each task was TDD'd with RED and GREEN as separate commits, both in one shared RED/GREEN pass since both tasks land in the same two files:

1. **RED (Tasks 1+2):** `adc84d7` test(06-06): add failing tests for version, public-URL, and image-prefix resolution -- 83/83 failing with exit 127 (functions not yet defined), confirmed before implementing.
2. **GREEN (Tasks 1+2):** `485c6ba` feat(06-06): resolve version, public URL, and image prefix (D-04/D-07/D-19) -- 83/83 passing on the first full implementation pass, after two `check-posix-sh` false-positive fixes made during implementation (see Issues Encountered) and two real test bugs found and fixed before commit (see Issues Encountered).

## Files Created/Modified

- `install.sh` - Adds `NOODARA_REPO_OWNER`/`NOODARA_REPO_NAME`/`NOODARA_REGISTRY`/`NOODARA_FETCH_TIMEOUT` constants and `noodara_fetch_url`, `noodara_normalize_tag`, `noodara_validate_tag`, `noodara_resolve_version`, `noodara_resolve_image_prefix`, `noodara_looks_like_ipv4`, `noodara_get_public_ip`, `noodara_get_local_ip`, `noodara_resolve_public_url` (606 -> 850 lines)
- `tests/unit/installer/resolution.test.ts` - New file, 83 test cases under `describe.each(posixInterpreters())` (plus 3 interpreter-agnostic structural tests reading `install.sh`'s own source), covering the curl call-site discipline, `noodara_validate_tag`'s full rejection/acceptance table, `noodara_resolve_version`'s every branch (operator override, redirect success, API fallback, hostile/HTML/empty/truncated API bodies, total failure, `latest` rejection even via the redirect path, normalisation), `noodara_resolve_image_prefix`'s default and D-19 override paths, `noodara_get_public_ip`'s exact call order and HTML-rejection-then-continue behavior, `noodara_get_local_ip`, and `noodara_resolve_public_url`'s full D-07 order including the single-print-to-stderr proof

## Decisions Made

See `key-decisions` in the frontmatter above. In short: the D-07 operator note moves to stderr (protects the stdout return contract every downstream caller depends on), `curl` gains `--proto '=https' --tlsv1.2` beyond the plan's literal text (hard_rule #8 is unconditional here), the D-19 registry-prefix guard is a deny-list (not the version-tag's allow-list, since a registry prefix legitimately contains `/`, `:`, `.`), and `NOODARA_REPO_OWNER`/`NOODARA_REPO_NAME` ship as an explicit, obviously-a-placeholder default for Plan 06-15's human handoff.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `noodara_fetch_url` adds `--proto '=https' --tlsv1.2` to both curl invocations**
- **Found during:** Task 1 implementation
- **Issue:** 06-06-PLAN.md's `<action>` text specifies only `-fsSL --connect-timeout "$NOODARA_FETCH_TIMEOUT" --max-time 15`. This seam resolves both the release tag (`docker pull` target) and the public IP (`NOODARA_PUBLIC_URL`, compared by the Origin guard) -- exactly the class of curl call hard_rule #8 requires to be https-only with TLS pinning, and every URL passed through it is already a literal `https://` URL, so the addition is pure defense-in-depth against a malicious redirect target downgrading the connection.
- **Fix:** Added `--proto '=https' --tlsv1.2` to both the `body` and `redirect` mode curl invocations.
- **Files modified:** `install.sh`
- **Verification:** `pnpm exec vitest run tests/unit/installer/resolution.test.ts` (83/83 pass, including every stub-based test, none of which depends on the real flags since curl itself is never invoked in tests); `pnpm check:posix-sh` clean.
- **Committed in:** `485c6ba` (Task 1/2 GREEN commit)

**2. [Rule 1 - Bug] `noodara_resolve_public_url`'s D-07 note routed to stderr, not through `noodara_note`'s stdout**
- **Found during:** Task 2 implementation, before any test was written for this function
- **Issue:** The plan's `<behavior>` text says the note is printed "via `noodara_note`" (which is stdout-only per its own doc comment). This function's stdout is also its return-value channel (`public_url=$(noodara_resolve_public_url)`, the exact contract `noodara_resolve_version`/`noodara_resolve_port` already establish and Plan 06-04's `noodara_generate_env` already consumes). Printing the note to stdout would append a second line to that capture, corrupting the returned URL with an embedded newline and immediately tripping `noodara_env_assert_single_line`'s own guard the moment `noodara_generate_env` tried to write it.
- **Fix:** The note (resolved URL + remedy) is printed via a direct `printf ... >&2`, never through `noodara_note`. Documented at length in the function's own header comment.
- **Files modified:** `install.sh`
- **Verification:** `install.sh noodara_resolve_public_url` test "prints the resolved URL exactly once across combined stdout+stderr note text" asserts the URL appears exactly once in each stream.
- **Committed in:** `485c6ba` (Task 1/2 GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 missing-critical/security, 1 bug). Both were caught before committing, not as a follow-up fix cycle. No scope creep -- both stay entirely inside this plan's two files.

## Issues Encountered

- **`check-posix-sh` false positive 1 (`ansi-c-quote`):** the D-19 dollar-sign guard's first draft, `case "$NOODARA_INTERNAL_IMAGE_PREFIX" in *'$'*)`, contains the literal two-character substring `$'` (a single-quoted `$` immediately followed by the glob's own closing quote), which the gate's `ansi-c-quote` rule (`/\$'/`, meant to catch bash's `$'...'` quoting) flags even though this is not ANSI-C quoting at all. Fixed by rewriting the pattern as `*"\$"*)` (double-quoted, backslash-escaped `$`), which the gate does not flag and which matches identically. hard_rule #7 forbids editing the gate itself; the workaround stays entirely inside `install.sh`.
- **`check-posix-sh` false positive 2 (`local`):** the local-IP-fallback warning's first draft used the phrase "this server's private local address", and the gate's `local` rule (`/(^|\s)local\s+\S/`, meant to catch bash's `local` keyword) matched "local address" inside that plain English sentence. Fixed by rewording to "this server's own private-network address instead" -- no behavior change, the word "local" simply doesn't appear standalone followed by another word anymore.
- **Real test bug 1:** `noodara_get_public_ip`'s "returns non-zero when all three services fail" test originally called `noodara_get_public_ip; printf "STATUS=%s\n" "$?"` as a bare top-level sequence. `install.sh` runs under `set -eu`, and a plain top-level command returning non-zero (not part of an `if`/`while`/`&&`/`||`) aborts the whole script immediately -- the `printf` never ran, and the script's own exit code (1) was mistaken for a signal to check. Fixed by wrapping in `if noodara_get_public_ip; then ...; else ...; fi`, the `-e`-safe idiom every other conditional check in this file already uses.
- **Real test bug 2 (acceptance-criterion drift, hard_rule #12):** 06-06-PLAN.md's own literal acceptance command, `grep -v '^[[:space:]]*#' install.sh | grep -c 'curl '`, returns **3** against the final `install.sh`, not the 2 the plan's prose implies -- confirmed by running the exact command directly. The third match is Plan 06-02's pre-existing, out-of-scope `noodara_check_base_commands` line (`for cmd in curl openssl ss ip awk grep; do`), which lists `curl` as a required base-command *name*, not an invocation. Rather than inventing a passing result, the structural test in `resolution.test.ts` matches on `curl -` (every genuine invocation in this file's own convention always carries at least one flag) instead of the bare substring `curl `, which preserves the criterion's actual intent -- "no other function may call curl directly" -- and is documented inline in the test itself. The locked curl-invocation count recorded per the plan's own request: **2** (both inside `noodara_fetch_url`).

## Known Stubs

None -- no UI or data-flow stubs; this plan is shell logic and tests only.

## Threat Flags

None -- every new surface this plan introduces (the two IP-echo/GitHub-API trust boundaries, the D-19 registry override) was already named and mitigated in this plan's own `<threat_model>` (T-06-29, T-06-30, T-06-07, T-06-31, T-06-32); no new, un-modeled surface was introduced. The one addition beyond the plan's literal text (`--proto '=https' --tlsv1.2`) strengthens an already-modeled mitigation rather than opening a new one.

## User Setup Required

None -- no external service configuration required. Plan 06-15's human prerequisite (creating the real GitHub repo, D-02) will need to either edit `NOODARA_REPO_OWNER`/`NOODARA_REPO_NAME`'s defaults in `install.sh` or export both as environment variables before the first real `curl | sh` publication -- flagged in `key-decisions` above for that handoff.

## Next Phase Readiness

- `noodara_resolve_version`, `noodara_resolve_public_url` and `noodara_resolve_image_prefix` are ready for Plan 06-07 (production `docker-compose.yml`, which references `${NOODARA_VERSION}`/the resolved image prefix) and Plan 06-09 (`noodara_main`'s real install flow, which will call all three and pass their results into Plan 06-04's `noodara_generate_env`).
- Plan 06-09 is also where `NOODARA_INTERNAL_IMAGE_PREFIX`'s "implies skipping `docker pull`" behavior (documented in this plan's own comment) becomes real -- this plan only resolves the value, it does not yet skip any pull (no pull exists yet to skip).
- Plan 06-10's Docker-in-Docker layer-2 suite can exercise the full D-07/D-04 resolution chains against a real Ubuntu 22.04/24.04 container, including genuinely calling `NOODARA_INTERNAL_IMAGE_PREFIX` to point at locally built images with no registry -- no rework needed.
- No blockers for Plan 06-07 (next plan in this phase's wave sequence).

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

Both files (`install.sh`, `tests/unit/installer/resolution.test.ts`) verified present on disk;
both task commit hashes (`adc84d7`, `485c6ba`) verified present in `git log --oneline --all`.
