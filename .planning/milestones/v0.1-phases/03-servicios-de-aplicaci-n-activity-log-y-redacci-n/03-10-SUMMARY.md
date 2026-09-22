---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 10
subsystem: security
tags: [testcontainers, ssh, redaction, activity-log, ci, security, tdd]

# Dependency graph
requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: "03-05..03-09's five server services behind createServerServices, the shared tests/integration/services/helpers/service-fixture.ts harness, tests/integration/helpers/ssh.ts's startSshd/readTestKey/assertNoStrayTestContainers, apps/control-plane/src/logger.ts and activity/redaction.ts"
provides:
  - "tests/integration/activity/canary-full-flow.test.ts: SEC-02/D-18's real register -> connect+discover -> edit -> host-key-change -> trust -> connect -> delete flow against a live Ubuntu sshd Testcontainer, proving five per-run canaries (password, private key, its passphrase, master key) never reach the logger, a service result, activity_events.metadata, discovery_snapshots.payload or a simulated service error"
  - "pnpm security:scan-leaks now runs both the fast Phase-1 canary and this full-flow canary; CI's security job documents the added Testcontainer cost and gets its own stray-container guard"
affects: [phase-4-http-routes, phase-5-qa-05-nightly]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A Redactor's registration is attempt-scoped, not flow-scoped: @noodara/ssh's ssh2-adapter releases every raw value it reveals the moment a connect attempt's session closes (WR-02), so a test that needs a still-registered secret at the very end of a multi-connect flow (to exercise appRedactor.redact against a simulated error) must re-register it immediately before that capture rather than relying on a single up-front registration to survive the whole flow"
    - "The fixture's password-only account (pwuser) and key-only accounts (root/deployer) are mutually exclusive by design (tests/integration/images/sshd-common/setup-users.sh) — a D-18-style flow that needs both a password credential and a later key credential against the same real server must change sshUser in the same edit that replaces the credential, which is exactly D-14's access-change transition (CONNECTED -> DISCONNECTED, reason clean_close), not an artificial test contrivance"

key-files:
  created:
    - tests/integration/activity/canary-full-flow.test.ts
  modified:
    - package.json
    - .github/workflows/ci.yml

key-decisions:
  - "The plan's own must_haves.truths text states 'exactly three discovery_snapshots rows' but its own Act sequence only names two successful connect+discovery runs (steps 2 and 6) with step 4 failing at the SSH-connect phase before discovery ever runs — connectAndDiscover only inserts a snapshot on the branch where a DiscoverySnapshot was actually produced, so the real, correct count is two; the test asserts two with an inline comment explaining the arithmetic rather than following the plan's literal (incorrect) number"
  - "editServer's credential-replacement step (Task 1's Act step 3) also changes sshUser from pwuser to deployer in the same call, since the fixture's password-only account never receives an authorized key at all — without this, step 6's later key-credential connect could never physically succeed against a real server; this is D-14's access-change semantics working as designed, not a deviation from it"
  - "Capture (a)'s raw-row logging passes each servers/credentials row through toLogSafe (a shallow, entity-shaped allowlist) while service results are logged as-is, since ServerView is already credential-free by construction (D-19) and toLogSafe's own contract is documented specifically for flat DB rows, not nested API result shapes"

requirements-completed: [SEC-02, DISC-03]

# Metrics
duration: 65min
completed: 2026-09-16
---

# Phase 3 Plan 10: SEC-02 Full-Flow Leak Scan Summary

**A real register -> connect+discover -> edit -> host-key-change -> trust -> connect -> delete flow against a live Ubuntu 24.04 sshd Testcontainer, driven only through `createServerServices`, proves five per-run canary secrets never leak into logs, service results, activity metadata, discovery snapshots or a simulated error — and `pnpm security:scan-leaks` now runs it in CI as a dedicated, container-guarded job.**

## Performance

- **Duration:** ~65 min
- **Tasks:** 2 completed
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- `tests/integration/activity/canary-full-flow.test.ts` drives the entire D-18 flow through `createServerServices(fixture.deps)` with a real `createSsh2Adapter()` against a real `startSshd({ ubuntu: '24.04' })` container — never a fake `SshPort` or a double for any step: register with the fixture's password-only account, connect+discover, edit (credential swap + `sshUser` change from `pwuser` to `deployer`, D-13/D-14 access transition), force a host-key change via a direct row `UPDATE` (no second container), reach `HOST_KEY_CHANGED`, trust the parked fingerprint, connect again successfully, then delete with exact-name confirmation.
- All five D-18 capture sources are asserted clean of every canary: pino log output (service results plus raw `servers`/`credentials` rows through `toLogSafe`), every service result's `JSON.stringify`, every `activity_events.metadata` row for the server, every `discovery_snapshots.payload` row (captured before deletion, since the server's own delete cascades that table), and a simulated service error redacted through `appRedactor.redact` — the exact pattern phase 4's future error handler must follow.
- DISC-03 is proven against real, independently-collected facts: exactly two `discovery_snapshots` rows exist before deletion (one per connect attempt that actually reached discovery — steps 2 and 6; the failed `HOST_KEY_CHANGED` attempt never reaches discovery at all), the denormalized `servers.hostname`/`osDistribution`/`arch`/`dockerInstalled` columns are non-null and match the last snapshot's own facts, and zero snapshot rows remain after `deleteServer`.
- `pnpm security:scan-leaks` (`package.json`) now names both `tests/integration/activity/canary.test.ts` (fast, container-free) and `tests/integration/activity/canary-full-flow.test.ts`, in that order, deterministic under the integration config's `fileParallelism: false`.
- CI's `security` job (`.github/workflows/ci.yml`) documents why its runtime is now noticeably longer (a real sshd Testcontainer build+start) and gained its own `if: always()` stray-container guard, mirroring the `integration`/`boot-smoke` jobs verbatim in mechanism (`docker ps -aq --filter "label=noodara.test=true"`).
- A real, load-bearing interaction was found and worked around: `@noodara/ssh`'s ssh2 adapter releases every raw revealed secret from the shared `appRedactor` the moment each connect attempt's session closes (WR-02) — by the end of a multi-connect flow, the password/passphrase canaries are no longer registered. The test re-registers them immediately before the final simulated-error capture so that capture is a meaningful proof of the real redaction pattern, not an artifact of stale registration state (the private-key canary's full PEM text is caught unconditionally by the redactor's structural `BEGIN...PRIVATE KEY` pattern either way).

## Task Commits

1. **Task 1: the D-18 full-flow canary against a real sshd container** - `761e869` (test)
2. **Task 2: widen security:scan-leaks and guard the CI security job** - `133354e` (chore)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified

- `tests/integration/activity/canary-full-flow.test.ts` - the D-18 full-flow canary (one `it`, real Testcontainer, five captures, five canaries)
- `package.json` - `security:scan-leaks` now names both canary files
- `.github/workflows/ci.yml` - `security` job comment updated, stray-container guard step added

## Decisions Made

- Test-count arithmetic: the plan's own `<behavior>` text stated "exactly three" `discovery_snapshots` rows but its own Act sequence only produces two successful discovery runs; the test asserts two with an explanatory comment (see Deviations).
- `editServer`'s Task-1 Act step 3 additionally changes `sshUser` (`pwuser` -> `deployer`) alongside the credential replacement, since the fixture's password-only account has no authorized key at all — a necessary, D-14-consistent correction for the flow to be physically realizable against the real fixture image.
- Capture (a)'s raw-row logging uses `toLogSafe` (a shallow allowlist for `servers`/`credentials` rows); service results are logged as-is since `ServerView` is already credential-free by construction.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in the plan's own must_haves text] "exactly three" discovery_snapshots corrected to two**
- **Found during:** Task 1, while translating the plan's `<behavior>` block into concrete assertions.
- **Issue:** The plan states "exactly three `discovery_snapshots` rows exist for the server before deletion (one per successful connect run: steps 2 and 6, plus none for the failed step-4 connect)" — but its own parenthetical only names two successful runs (steps 2 and 6), and `connectAndDiscover`'s implementation only inserts a snapshot row on the branch where a `DiscoverySnapshot` was actually produced (never on an SSH-connect-phase failure like step 4's `HOST_KEY_CHANGED`). The correct count, following the plan's own flow, is two.
- **Fix:** Asserted `toHaveLength(2)` with an inline comment explaining the arithmetic, rather than the plan's literal (internally inconsistent) number.
- **Files modified:** `tests/integration/activity/canary-full-flow.test.ts`
- **Verification:** Test passes; the assertion is directly checked against real persisted rows, not a magic number asserted blindly.
- **Committed in:** `761e869` (Task 1 commit)

**2. [Rule 2 - Missing critical detail for a physically realizable flow] `editServer`'s credential-replacement step also changes `sshUser`**
- **Found during:** Task 1, while arranging the real SSH accounts the flow needs.
- **Issue:** The plan's Task 1 instruction says only "editServer replacing the credential with the encrypted private key + passphrase," without mentioning `sshUser`. The fixture's password-only account (`pwuser`) never receives an authorized key at all (`tests/integration/images/sshd-common/setup-users.sh`), so a later connect with a key credential against the *same* `sshUser` could never succeed on a real container — only `root`/`deployer` accept the `ed25519_locked` key.
- **Fix:** The edit call also sets `sshUser: 'deployer'` alongside the credential replacement, which correctly triggers D-14's access-change transition (`CONNECTED -> DISCONNECTED`, reason `clean_close`) since both fields changed together on a `CONNECTED` row — exactly the semantics `classifyServerEdit` already models, not a new behavior.
- **Files modified:** `tests/integration/activity/canary-full-flow.test.ts`
- **Verification:** The full flow passes end-to-end against the real container, including the subsequent `HOST_KEY_CHANGED`/trust/reconnect sequence over the `deployer` account.
- **Committed in:** `761e869` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (Rule 1: a plan-text arithmetic inconsistency; Rule 2: a necessary field addition for the flow to be physically realizable against the real test fixture). Neither changes SEC-02/DISC-03 scope or the production services under test — both are corrections confined to this plan's own new test file.

## Issues Encountered

A full `pnpm test:integration` run showed a cascading failure (234/311 tests) rooted in
`tests/integration/ssh/*.test.ts` files this plan does not touch — confirmed pre-existing,
machine-specific Docker resource contention, not a regression from this plan's three modified
files. Logged in this phase's new `deferred-items.md` with full reproduction/isolation evidence
(re-running the affected file alone passed cleanly, 16/16). Each task's own `<verify>` command,
`pnpm security:scan-leaks` (both canaries together), `pnpm test` (739 unit tests), `pnpm
typecheck`, `pnpm lint` and `pnpm exec turbo boundaries` all pass; zero stray
`noodara.test=true` containers after every one of those runs.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Every phase-3 success criterion now has automated evidence: SERV-01/02/03, DISC-03, ACT-01 and
  SEC-02 all have integration-test proof, and `pnpm security:scan-leaks` is the single command
  QA-05's nightly (phase 5) can extend with the connect/deploy/AI-query flow.
- This was the last plan of phase 3. No blockers for phase 4 (HTTP routes, connect-server worker,
  domains/networking/secrets).

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-16*

## Self-Check: PASSED

`tests/integration/activity/canary-full-flow.test.ts`, this SUMMARY and this phase's new
`deferred-items.md` are all present on disk; both task commits (`761e869`, `133354e`) are present
in git history.
