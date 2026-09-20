---
status: issues_found
phase: 05-ui-web
depth: standard
files_reviewed: 47
diff_base: a8c03c5
reviewed: 2026-09-20
scope_note: "gap-closure delta only (git diff a8c03c5..HEAD); initial review archived as 05-REVIEW-initial.md"
files_reviewed_list:
  - .github/workflows/ci.yml
  - .github/workflows/nightly.yml
  - apps/control-plane/src/queue/connect-server-worker.ts
  - apps/control-plane/src/routes/events.ts
  - apps/control-plane/src/routes/http-errors.ts
  - apps/control-plane/src/routes/server-schemas.ts
  - apps/control-plane/src/routes/servers.ts
  - apps/control-plane/src/server.ts
  - apps/control-plane/src/services/connect-and-discover.ts
  - apps/control-plane/src/services/edit-server.ts
  - apps/control-plane/src/services/fail-in-flight-connection.ts
  - apps/control-plane/src/services/trust-fingerprint.ts
  - apps/control-plane/src/worker.ts
  - apps/web/next.config.ts
  - apps/web/src/app/(shell)/activity/page.tsx
  - apps/web/src/app/(shell)/error.tsx
  - apps/web/src/app/(shell)/layout.tsx
  - apps/web/src/app/(shell)/servers/[id]/page.tsx
  - apps/web/src/app/page.tsx
  - apps/web/src/app/setup/page.tsx
  - apps/web/src/components/ActivityList.tsx
  - apps/web/src/components/ServerSheet.tsx
  - apps/web/src/components/TrustFingerprintDialog.tsx
  - apps/web/src/lib/activity-groups.ts
  - apps/web/src/lib/api-client.ts
  - apps/web/src/lib/detail-sync.ts
  - apps/web/src/lib/discovery-progress.ts
  - apps/web/src/lib/error-copy.ts
  - apps/web/src/lib/require-session.ts
  - apps/web/src/lib/safe-storage.ts
  - apps/web/src/lib/server-form.ts
  - packages/domain/src/server/server-state.ts
  - packages/domain/src/server/connection-result.ts
  - packages/domain/src/server/connection-result.test.ts
  - packages/ui/src/Banner.tsx
  - packages/ui/src/Button.tsx
  - packages/ui/src/CopyButton.tsx
  - packages/ui/src/Field.tsx
  - packages/ui/src/RowMenu.tsx
  - packages/ui/src/SegmentedControl.tsx
  - packages/ui/src/StatusPill.tsx
  - packages/ui/src/ThemeToggle.tsx
  - packages/ui/src/contrast.ts
  - packages/ui/src/contrast.test.ts
  - packages/ui/theme.css
  - packages/ui/tokens.css
  - scripts/check-package-provenance.mjs
findings:
  critical: 1
  warning: 4
  info: 0
  total: 5
---

# Phase 05: Code Review Report (gap-closure delta)

**Reviewed:** 2026-09-20
**Depth:** standard
**Files Reviewed:** 47
**Status:** issues_found

## Summary

This review covers only the gap-closure delta (`a8c03c5..HEAD`) against the phase's own gap-closure
audit (`05-GAP-CLOSURE-AUDIT.md`), which claims most of the 37 triaged warnings are `CLOSED`. Most of
those claims hold up under direct re-reading: the `CONNECTING` wedge (WR-A-01), the SSE backpressure gap
(WR-A-03, with one reservation below), the detail-page stale-snapshot/invented-progress races (WR-B-01/02,
gap 3), the activity-log refresh bugs (WR-B-04/05/06), api-client timeouts (WR-B-11), safe-storage/error
boundary (WR-B-13), the field-error path normalization and the `sshUser` field wiring (WR-B-07, including
the residual the audit itself flagged and a later commit closed), setup-token URL/Referrer-Policy, CI
`permissions`/`timeout-minutes`/SHA-pinning/checksum-verified gitleaks (WR-C-11/12/13), and the provenance
gate's manifest-derived enumeration (WR-C-14) are all real, and I could not find a case where the fix
introduced a new *regression* in those areas.

One claim does not hold: **gap 6 / WR-A-02's "host-key trust is now bound to what the admin saw" is
incomplete in a way that reopens exactly the class of bug it was meant to close.** The atomic
conditional-UPDATE mid-review-swap protection is real and well-built, but the backend never verifies that
the *current* failure is actually a host-key mismatch before promoting whatever `pendingFingerprint` sits
on the row — and `applyConnectionResult`'s success/other-failure branches never clear a fingerprint parked
by an earlier, since-superseded `HOST_KEY_CHANGED` event. This is GR-01 below, classified Critical because
the gap-closure audit explicitly asserts this exact sub-case is fixed ("All three linked defects are
fixed... exactly as WR-A-02's fix required, including the sshUser case") when the code does not implement
the third of the three named steps.

## Narrative Findings (AI reviewer)

### GR-01 (CRITICAL): Trust-fingerprint promotion is not gated on `lastErrorCode`, so a stale/attacker-parked fingerprint from a resolved HOST_KEY_CHANGED event can be promoted later under an unrelated failure

**Files:**
`apps/control-plane/src/services/trust-fingerprint.ts:50-120`,
`packages/domain/src/server/connection-result.ts:62-94`

**Issue:** `05-REVIEW-initial.md`'s WR-A-02 fix recommendation had three parts: (1) clear
`pendingFingerprint` on any identity-changing edit regardless of status, (2) clear `pendingFingerprint` in
`applyConnectionResult`'s success branch, and (3) in `trustFingerprint`, "refuse unless `row.status ===
'ERROR' && row.lastErrorCode === 'HOST_KEY_CHANGED'`". The gap-closure audit's gap 6 says all three
"linked defects are fixed" and cites part (1) (edit-server.ts's `identityChanged` clear) as proof. Parts
(2) and (3) were never implemented:

- `connection-result.ts:75-82` (the `result.ok` branch) returns `{...state, status: nextStatus,
  lastErrorCode: null, hostFingerprint: ..., lastSeenAt: now}` — no `pendingFingerprint: null`. The failure
  branch (`:85-93`) only overwrites `pendingFingerprint` when `errorCode === 'HOST_KEY_CHANGED'`; every
  other error code (`AUTH_FAILED`, `COMMAND_TIMEOUT`, `CONNECT_TIMEOUT`, ...) falls through to
  `state.pendingFingerprint`, i.e. carries forward whatever was already parked. `connection-result.test.ts`
  never exercises a non-null `pendingFingerprint` going into the success branch (`buildState`'s default is
  `null`), so this gap has no regression coverage either.
- `trust-fingerprint.ts:50-120` gates promotion on `row.status === 'CONNECTING'` (busy),
  `row.pendingFingerprint === null` (`NO_PENDING_FINGERPRINT`), and `canTrustFingerprint(row.status)`
  (`SERVER_NOT_TRUSTABLE`, which only lets `ERROR` through per `server-state.ts`'s transition table). It
  never reads `row.lastErrorCode`. `grep -n "lastErrorCode" apps/control-plane/src/services/trust-fingerprint.ts`
  returns nothing.

**Concrete failure scenario:** a genuine, no-attacker-required sequence — no MITM needed, just two
back-to-back connection attempts with different outcomes:

1. Server `CONNECTED`, `hostFingerprint = F0`. An admin reconnects (or a MITM does); the host key presented
   is `F_new`, so the connect fails `HOST_KEY_CHANGED`. Row becomes `status=ERROR,
   lastErrorCode=HOST_KEY_CHANGED, pendingFingerprint=F_new`. The UI shows the host-key-changed banner; the
   admin does not click Trust yet.
2. The admin (or an automated retry) tries again and this attempt fails for an unrelated reason — wrong
   password after a credential rotation, a slow host producing `COMMAND_TIMEOUT`, anything that is not
   `HOST_KEY_CHANGED`. `ERROR_CODE_STATUS` still lands this on `ERROR`, and the failure branch of
   `applyConnectionResult` carries `pendingFingerprint` forward unchanged (`F_new`), while `lastErrorCode`
   becomes e.g. `AUTH_FAILED`. The UI now shows the generic `AUTH_FAILED` banner, not the host-key banner
   (`deriveDetailState` keys off `lastErrorCode === 'HOST_KEY_CHANGED'`), so no admin using only the web UI
   is ever shown a Trust action here.
3. `pendingFingerprint` (`F_new`) is not a secret — `GET /api/servers/:id` returns it unconditionally
   (`ServerViewSchema.pendingFingerprint`). Any authenticated caller — a script, a compromised session, a
   future non-admin role, or simply a stale browser tab that still has the trust dialog's request shape
   memorized — can call `POST /api/servers/:id/trust-fingerprint` with `{ fingerprint: "F_new" }` directly.
   `trust-fingerprint.ts` checks only `status === 'ERROR'` (true, due to the *unrelated* `AUTH_FAILED`) and
   `pendingFingerprint === input.fingerprint` (true) — it promotes `F_new` into `hostFingerprint`, with no
   check that the row's current failure has anything to do with a host-key mismatch.
4. `F_new` is now the trusted key. If step 1's `HOST_KEY_CHANGED` was caused by an actual interception
   (not a legitimate rotation), the interceptor's key is now permanently trusted, and the next real connect
   silently succeeds against it — the exact TOFU bypass class CLAUDE.md §2.3 and the noodara-security skill
   call non-negotiable, and which the backend is required to enforce independently of the UI (the UI's own
   gating on `lastErrorCode === 'HOST_KEY_CHANGED'` is exactly the "solo por prompt o UI" pattern the
   project rules forbid relying on alone).

**Fix:** implement the third step the original recommendation named: in `trustFingerprint`, add
`if (row.lastErrorCode !== 'HOST_KEY_CHANGED') return { ok: false, code: 'SERVER_NOT_TRUSTABLE', ... }`
(or a dedicated code) before the conditional UPDATE. Also close the domain-level root cause so a future
caller of `applyConnectionResult` doesn't reopen this: clear `pendingFingerprint`/`pendingFingerprintSeenAt`
in the success branch, and consider clearing it on any failure whose code is not `HOST_KEY_CHANGED` once a
connection genuinely reaches a terminal outcome for a *different* reason. Add an integration test:
`HOST_KEY_CHANGED` (parks `F_new`) → a second connect that fails `AUTH_FAILED` → `POST
/trust-fingerprint` with `F_new` must return 409, not 200.

### GR-02 (WARNING): edit-server.ts's identity-change fix clears `pendingFingerprint` status-independently but still leaves `hostFingerprint` stale outside `CONNECTED`, guaranteeing a spurious HOST_KEY_CHANGED on the next connect

**File:** `apps/control-plane/src/services/edit-server.ts:213-251`

**Issue:** The gap-closure audit states edit-server.ts's fix is "status-independent, exactly as WR-A-02's
fix required" (gap 6). The original WR-A-02 fix text asked for host/port changes in *any* status to clear
both `pendingFingerprint` *and* `hostFingerprint`/`hostFingerprintCapturedAt` (item (d) in the original
finding: "Only the CONNECTED branch resets hostFingerprint on an identity change... the first connect to a
brand-new host is guaranteed to report a spurious HOST_KEY_CHANGED"). The shipped code only composes the
`pendingFingerprint` clear unconditionally (`:249-251`); `hostFingerprint`/`hostFingerprintCapturedAt` are
still only cleared inside the `row.status === 'CONNECTED'` branch (`:222-235`). Editing `host`/`sshPort`
from `ERROR`, `UNREACHABLE`, `DISCONNECTED` or `PENDING` leaves the old host's trusted fingerprint attached
to the row under the new host/port.

**Concrete scenario:** server in `ERROR` (e.g. `CONNECT_TIMEOUT`) with `hostFingerprint = F0` (from a
previous host). Admin edits `host` to point at a different machine entirely (e.g. correcting a typo, or
re-pointing the record at a replacement box). `identityChanged` is true, `pendingFingerprint` is cleared,
but `hostFingerprint` stays `F0`. The next connect attempt passes `trustedFingerprint = F0` to `ssh.connect`
against the *new* host, whose real key is `F1 != F0` → a guaranteed `HOST_KEY_CHANGED` even though nothing
about this host's identity actually "changed" (it never had a trust relationship at all). This fails
closed (no credential leak), but it trains the admin to treat `HOST_KEY_CHANGED` as routine noise on every
edit, undermining the same TOFU signal GR-01 is about.

**Fix:** in the `identityChanged` block, also set `hostFingerprint: null, hostFingerprintCapturedAt: null`
unconditionally (matching the original recommendation), not only inside the `CONNECTED` branch.

### GR-03 (WARNING): The post-TX1 recovery call in `connectAndDiscover`'s catch swallows a `failInFlightConnection` failure with no log line

**File:** `apps/control-plane/src/services/connect-and-discover.ts:463-475`

**Issue:** `await failInFlightConnection(deps, {...}).catch(() => undefined)` deliberately preserves and
rethrows the *original* error (correct — not masked), but if the recovery call itself throws (e.g. a
transient Postgres error while trying to un-wedge the row), that failure is discarded with zero log output.
CLAUDE.md §2.2 requires "logs adecuados" for every infrastructure failure path. The worker's own `'failed'`
listener (`connect-server-worker.ts:105-133`) does provide a second, logged recovery attempt
(`services.failInFlightConnection` wrapped in try/catch with `options.logger.error(...)` on failure), so
this is not a total loss of recovery — but the *first* attempt's failure is invisible to operators, and if
the second attempt happens to succeed, nobody is ever told the first one failed at all, hiding a real
signal (e.g. a flaky DB) behind an apparently-clean recovery.

**Fix:** log the recovery failure before swallowing it, e.g.
`.catch((recoveryErr: unknown) => { deps.logger?.warn({ err: recoveryErr, serverId: row.id }, 'connect-service post-failure recovery failed; the worker "failed" listener will retry'); })`
(adjust to whatever logger is available on `deps`), so the first attempt's failure is never silent even
when the second attempt papers over it.

### GR-04 (WARNING): SSE backpressure budget (1 MiB) does not meaningfully bound a half-open, heartbeat-only connection in practice

**File:** `apps/control-plane/src/routes/events.ts:36,107-121,131-158`

**Issue:** WR-A-03's fix (`SSE_MAX_BUFFERED_BYTES = 1_048_576`, checked via `exceedsBackpressureBudget`)
is a real, correctly-wired improvement over the pre-fix state (no bound at all, `reply.raw.on('error')`
now registered, `evict()` used consistently for both the heartbeat and stream writes). But the stated goal
— bounding how long "a peer that stops reading... holds one of the capped 32 slots" — is only loosely met
for the realistic worst case the comment itself names: a connection that receives *only* the ~20-byte
`: keepalive\n\n` heartbeat frame every `heartbeatMs` (15s in production) and otherwise never drains
(zero-window / genuinely stuck peer, never producing a `close`/`error` event on its own). At ~20 bytes per
write every 15s, reaching the 1 MiB threshold takes roughly 1,048,576 / 20 × 15s ≈ 218 hours (~9 days) —
worse than the ~15-minute default Linux `tcp_retries2` timeout that would eventually reclaim the same slot
even *without* this fix. A server with normal `server.updated`/`discovery_progress` traffic would evict
such a peer sooner, but the module's own comment singles out "alive but not reading... every event is
buffered... without limit, and the slot is never freed" as the case this fix targets, and for a
mostly-idle connection that case is now bounded in theory but not in any practically useful timeframe.

**Fix:** add an idle/staleness bound independent of buffered bytes — e.g. evict a stream whose buffer has
not drained across N consecutive heartbeat ticks (mentioned in the original WR-A-03 fix text: "evict a
stream whose buffer has not drained across two consecutive heartbeats"), or call
`request.raw.socket.setTimeout(...)`/`setKeepAlive` so the OS-level TCP stack surfaces a dead peer well
before the byte budget would.

### GR-05 (WARNING): `check-package-provenance.mjs`'s `execFileSync` calls still have no per-call timeout, though the original fix recommendation named exactly this

**File:** `scripts/check-package-provenance.mjs:244-248,277-281`

**Issue:** WR-C-12's fix text explicitly said "Add `timeout: 30_000` to both `execFileSync` calls." Neither
`execFileSync('pnpm', ['list', '-r', '--depth', '0', '--json'], { encoding: 'utf8' })` (`:245-247`) nor
`execFileSync('npm', ['view', spec, 'repository.url'], { encoding: 'utf8', stdio: [...] })` (`:277-281`)
sets a `timeout`. The `security` job now has a job-level `timeout-minutes: 40` (ci.yml) that would
eventually kill a hang, but that is a much coarser backstop than the process-level timeout the fix asked
for, and it burns the whole job's budget (and, for a self-hosted or shared runner, the runner's time)
rather than failing this one step promptly with an actionable message.

**Fix:** `execFileSync('pnpm', [...], { encoding: 'utf8', timeout: 30_000 })` and the equivalent for the
`npm view` call, as originally specified.

---

_Reviewed: 2026-09-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
