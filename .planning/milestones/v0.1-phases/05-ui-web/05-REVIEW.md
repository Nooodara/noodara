---
phase: 05-ui-web
reviewed: 2026-09-20T00:00:00Z
depth: standard
diff_base: 5592107
scope_note: "gap-closure round 2 delta only (git diff 5592107..HEAD); round 1 delta archived as 05-REVIEW-gap-closure-round1.md"
files_reviewed: 29
files_reviewed_list:
  - apps/control-plane/src/app.ts
  - apps/control-plane/src/logger.ts
  - apps/control-plane/src/logger.test.ts
  - apps/control-plane/src/server.test.ts
  - apps/control-plane/src/services/connect-and-discover.ts
  - apps/control-plane/src/services/edit-server.ts
  - apps/control-plane/src/services/log-recovery-failure.ts
  - apps/control-plane/src/services/log-recovery-failure.test.ts
  - apps/control-plane/src/services/server-service-deps.ts
  - apps/control-plane/src/services/trust-fingerprint.ts
  - apps/control-plane/src/worker.ts
  - apps/web/src/app/(shell)/servers/[id]/page.tsx
  - apps/web/src/components/ActivityRow.tsx
  - packages/domain/src/server/connection-result.ts
  - packages/domain/src/server/connection-result.test.ts
  - packages/ui/src/Button.tsx
  - packages/ui/src/contrast.ts
  - packages/ui/src/contrast.test.ts
  - packages/ui/theme.css
  - packages/ui/tokens.css
  - scripts/check-package-provenance.mjs
  - tests/e2e/host-key.spec.ts
  - tests/integration/helpers/boot-process.ts
  - tests/integration/routes/validation-issue-contract.test.ts
  - tests/integration/servers/connect-wedge.test.ts
  - tests/integration/servers/edit-clears-pending-fingerprint.test.ts
  - tests/integration/servers/trust-fingerprint-binding.test.ts
  - tests/integration/services/connect-and-discover.test.ts
  - tests/integration/services/edit-server.test.ts
  - tests/unit/integration-helpers/boot-process-build-env.test.ts
  - tests/unit/scripts/check-package-provenance-timeout.test.ts
findings:
  critical: 1
  warning: 3
  info: 1
  total: 5
status: issues_found
---

# Phase 05: Code Review Report (gap-closure round 2 delta)

**Reviewed:** 2026-09-20
**Depth:** standard
**Files Reviewed:** 30 (29 listed + `apps/web/src/lib/detail-state.ts` read transitively as load-bearing evidence for CR-01, see below)
**Status:** issues_found

## Summary

This is a delta review of phase 05's gap-closure round 2 (`5592107..HEAD`) against round 1's own
findings (`05-REVIEW-gap-closure-round1.md`, GR-01..GR-05). Four of five hold up as genuinely fixed;
one (GR-04) was not touched in this round at all. The host-key trust path itself
(`trust-fingerprint.ts`, `connection-result.ts`, `connect-and-discover.ts`, `edit-server.ts`) is
now solid on the axis round 1 flagged as CRITICAL: no sequence I could construct promotes a stale or
wrong-host fingerprint, and every superseded-parking bypass round 1 named is now refused with a typed
409 and zero side effects, backed by real integration coverage.

Two new, real defects surfaced while actively trying to construct inconsistent-row sequences per this
review's brief, both rooted in the same root cause: `lastErrorCode` is written only by the connect
flow (`applyConnectionResult`) and is never reconciled by the two *other* code paths that resolve a
host-key situation without going through a new connect attempt (`editServer`'s identity-change clear,
`trustFingerprint`'s successful promote). One of the two (CR-01) leaves the admin with **zero** UI
action to recover the server — a real dead end reachable through the ordinary "edit a server while it
has an unresolved host-key mismatch" flow, not a contrived edge case, and not covered by the existing
regression tests for either GR-01 or GR-02.

## Round 1 Gap Tracking (GR-01..GR-05)

| ID | Round-1 severity | Round-2 status | Evidence |
|---|---|---|---|
| GR-01 | CRITICAL | **RESOLVED** | `trust-fingerprint.ts:104-110` refuses promotion unless `row.lastErrorCode === 'HOST_KEY_CHANGED'`, repeated as a defence-in-depth `WHERE` predicate at `:144-149`; `connection-result.ts:77-96` now clears `pendingFingerprint` on every success and every non-`HOST_KEY_CHANGED` failure. All three round-1 "bypass" scenarios (later `AUTH_FAILED`, later `COMMAND_TIMEOUT`, later successful reconnect superseding a parked value) are asserted refused in `tests/integration/servers/trust-fingerprint-binding.test.ts:269-348`, and the domain-level fix is asserted in `packages/domain/src/server/connection-result.test.ts:96-184` and `tests/integration/services/connect-and-discover.test.ts` (GR-01 cases added in this delta). |
| GR-02 | WARNING | **RESOLVED** | `edit-server.ts:264-266`'s `hostIdentityChanged` block unconditionally clears `hostFingerprint`/`hostFingerprintCapturedAt` regardless of status, composed alongside (not replacing) the pre-existing `CONNECTED`-only D-14 clear. Verified for `ERROR`/`UNREACHABLE`/`DISCONNECTED`/`PENDING` in `tests/integration/services/edit-server.test.ts:720-882` and for `UNREACHABLE`/`CONNECTED` over real HTTP in `tests/integration/servers/edit-clears-pending-fingerprint.test.ts:162-225`. |
| GR-03 | WARNING | **RESOLVED in production wiring**, but see WR-02 below | `log-recovery-failure.ts` logs the swallowed `failInFlightConnection` failure via `deps.logger?.warn`, never derives message text from the error, and never throws. Both real call sites now pass a logger: `apps/control-plane/src/app.ts:65` (`resolveServerServicesDeps({ events: eventPublisher, logger })`, `logger = app.log`) and `apps/control-plane/src/worker.ts:49` (`logger` = the worker's own module-level pino instance). Proven against a real captured pino stream (not just a fake) in `tests/integration/servers/connect-wedge.test.ts:209-263`. |
| GR-04 | WARNING | **NOT ADDRESSED THIS ROUND** | `apps/control-plane/src/routes/events.ts` has zero diff between `5592107` and `HEAD` (`git diff 5592107..HEAD -- apps/control-plane/src/routes/events.ts` is empty). The SSE idle/staleness bound round 1 asked for is still absent; this item remains open and was simply out of this round's file set, not fixed. |
| GR-05 | WARNING | **RESOLVED** | Both `execFileSync` calls in `scripts/check-package-provenance.mjs` now pass `timeout: 30_000` (`:254`, `:301`), with fail-closed behaviour on the `pnpm list` call (no fallback, throws an actionable error) and a documented fallback-to-registry-API path on the `npm view` call. Verified with a mocked `child_process` in `tests/unit/scripts/check-package-provenance-timeout.test.ts`. |

## Narrative Findings (AI reviewer)

### CR-01 (CRITICAL): Editing a server's identity while it is ERROR/HOST_KEY_CHANGED leaves an admin with no UI action anywhere on the page to reconnect it

**Files:**
`apps/control-plane/src/services/edit-server.ts:229-275`,
`apps/web/src/lib/detail-state.ts:60-86`,
`apps/web/src/components/HostKeyChangedBanner.tsx:52`,
`apps/web/src/components/ServerDetailToolbar.tsx:85-94`

**Issue:** Constructing the exact sequence this review's brief asked for — a legitimate edit made
while a server is parked in `ERROR`/`HOST_KEY_CHANGED` — produces a row the frontend cannot recover
from through any rendered control:

1. A real `HOST_KEY_CHANGED` connect failure parks the server: `status=ERROR`,
   `lastErrorCode=HOST_KEY_CHANGED`, `pendingFingerprint=X`.
2. The admin edits `host`/`sshPort`/`sshUser` on this server (e.g. correcting a typo, or
   re-pointing the record at a different machine) via the real `PATCH /api/servers/:id` route.
   `editServer` is not in its `row.status === 'CONNECTED'` branch (`:235`) since the row is `ERROR`,
   so no `transition()` call happens and **`status` and `lastErrorCode` are left completely
   untouched** — only `hostIdentityChanged`/`identityChanged` fire (`:264-275`), correctly nulling
   `hostFingerprint`, `hostFingerprintCapturedAt`, `pendingFingerprint` and
   `pendingFingerprintSeenAt` (GR-01/GR-02's own fixes, confirmed working).
3. The resulting row: `status=ERROR`, `lastErrorCode=HOST_KEY_CHANGED`, `hostFingerprint=null`,
   `pendingFingerprint=null`. This is directly reachable through the real HTTP surface — no direct
   DB manipulation needed — and is exactly the row shape
   `tests/integration/services/edit-server.test.ts:721-735` ("ERROR + host change ... leaves status
   untouched") arranges, combined with the `UF-01` describe block's pending-fingerprint clear
   (`:644-670`). Neither test checks what happens next on the frontend.
4. On the detail page, `deriveDetailState` (`detail-state.ts:31-34`) checks `lastErrorCode ===
   'HOST_KEY_CHANGED'` **unconditionally**, before considering `status` or `pendingFingerprint` at
   all, so it still returns `'host-key-changed'` and the page renders `HostKeyChangedBanner`.
5. `HostKeyChangedBanner` (`HostKeyChangedBanner.tsx:52`) correctly (and deliberately, per its own
   comment) omits its `action` prop when `pendingFingerprint === null` — there is genuinely nothing
   to trust, so no "Trust new fingerprint" button renders. This half is correct and intentional.
6. `derivePrimaryAction` (`detail-state.ts:73-86`) has **no such guard**: its `PrimaryActionServer`
   type only picks `status`/`lastErrorCode` (never `pendingFingerprint`), and its `ERROR` branch is
   `lastErrorCode === 'HOST_KEY_CHANGED' ? null : retryAction()` — unconditionally `null` for this
   exact combination, on the stated (and, since GR-01/GR-02, now false) assumption that "the action
   lives in the dedicated error banner instead" (`:63-65`).
7. `ServerDetailToolbar` renders its `Button` only `{primaryAction !== null ? ... : null}`
   (`ServerDetailToolbar.tsx:85`), so with `primaryAction === null` **no button renders in the
   toolbar either**.

Net result: the page shows the `HOST_KEY_CHANGED` banner with no "Trust" action and a toolbar with no
"Connect"/"Retry" action. There is no rendered control anywhere on this screen that issues a
`/connect` or `/discover` request for this server. The only way to unstick it is to call the API
directly (curl/script) or delete and re-register the server. This is reachable through ordinary
product use, not a contrived edge case, and both round-1 fixes (GR-01, GR-02) that made this state
newly reachable landed without anyone re-checking `derivePrimaryAction`'s stale assumption.

`tests/e2e/host-key.spec.ts:429-514` ("UF-01/GR-02 regression") drives exactly this sequence against
a real backend and correctly asserts the Trust button disappears (`:494`) and that
`hostFingerprint`/`pendingFingerprint` are both null (`:508-509`) — but it never asserts on
`page.getByTestId('server-detail-primary-action')`, so it does not notice that nothing replaced the
removed Trust button. This finding has zero regression coverage today.

**Fix:** Give `derivePrimaryAction` the information it needs to fall back to a real action for this
exact orphaned combination — thread `pendingFingerprint` into `PrimaryActionServer` and change the
`ERROR` branch to something like
`lastErrorCode === 'HOST_KEY_CHANGED' && pendingFingerprint !== null ? null : retryAction()`. As a
defense-in-depth companion (not a substitute — the UI fix alone would still leave a stale/misleading
`lastErrorCode` on the row), consider having `editServer` also clear `lastErrorCode` in the
`hostIdentityChanged` branch when it is `HOST_KEY_CHANGED`, since an identity change that clears the
trust state also invalidates the reason that state was recorded. Add a test asserting
`server-detail-primary-action` (or an equivalent) is present and enabled after this exact sequence.

### WR-01 (WARNING): `trustFingerprint`'s successful promote never clears `lastErrorCode`, so a server the admin just correctly trusted still displays the HOST_KEY_CHANGED banner until the next connect attempt

**Files:**
`apps/control-plane/src/services/trust-fingerprint.ts:134-151`,
`apps/web/src/lib/detail-state.ts:31-34`

**Issue:** The atomic conditional `UPDATE` that promotes `pending_fingerprint` into `host_fingerprint`
sets `hostFingerprint`, `hostFingerprintCapturedAt`, `pendingFingerprint: null`,
`pendingFingerprintSeenAt: null`, `status: nextStatus` (`ERROR -> PENDING`) and `updatedAt` — but
never `lastErrorCode: null`. This line is unchanged by round 2's diff (it sits outside every hunk in
`git diff 5592107..HEAD -- apps/control-plane/src/services/trust-fingerprint.ts`), so it predates
this round, but it directly interacts with round 2's own GR-01 gate (which now *requires*
`lastErrorCode === 'HOST_KEY_CHANGED'` to reach this UPDATE at all) and sits inside the exact file
this review's brief asked to scrutinize.

Consequence: immediately after a successful "Trust new fingerprint" action, the row is
`status=PENDING`, `hostFingerprint=<the newly trusted value>`, `pendingFingerprint=null`, but
`lastErrorCode` is still `'HOST_KEY_CHANGED'`. `deriveDetailState` (`detail-state.ts:31-34`) checks
`lastErrorCode === 'HOST_KEY_CHANGED'` first, unconditionally — not gated on `status` at all — so the
detail page keeps rendering `HostKeyChangedBanner` ("This server's host key changed... Verify the
fingerprint on the server itself before continuing", now with "Observed: not available" since
`pendingFingerprint` is null) even though the admin just did exactly the verification the banner asks
for. This is not a dead end (`derivePrimaryAction`'s `PENDING` branch ignores `lastErrorCode` and
still offers "Connect", which clears `lastErrorCode` on its next successful `applyConnectionResult`),
but it is a real, user-visible, self-inconsistent state with no test coverage: neither
`tests/integration/servers/trust-fingerprint-binding.test.ts:180-199` ("returns 200 and promotes...")
nor the real-backend e2e test `tests/e2e/host-key.spec.ts:524-617` (`:604-612`) asserts on
`lastErrorCode` after a successful trust. This is the same class of stale-signal issue round 1's GR-02
warned about ("trains the admin to treat HOST_KEY_CHANGED as routine noise... undermining the same
TOFU signal GR-01 is about") — here triggered by the trust action succeeding, not by an edit.

**Fix:** add `lastErrorCode: null` to the `UPDATE`'s `.set({...})` at `trust-fingerprint.ts:134-143`.
Add a regression test asserting `after.lastErrorCode` is `null` (not just `hostFingerprint`/
`pendingFingerprint`/`status`) after a successful trust, in both
`trust-fingerprint-binding.test.ts` and the real-backend e2e test.

### WR-02 (WARNING): `logger.ts`'s bare-Error guard only intercepts `args[0] instanceof Error`; printf-style interpolation or an Error nested under a key other than `err` still bypasses both the hook and the custom `err` serializer

**File:** `apps/control-plane/src/logger.ts:42-46,61-75`

**Issue:** Traced the two other leak surfaces this review's brief named:

- **Format-string interpolation.** Pino formats a string first argument with additional positional
  arguments through `quick-format-unescaped` (confirmed in
  `node_modules/.pnpm/pino@10.3.1/node_modules/pino/lib/genLog`/`tools.js`). A call shaped like
  `logger.error('connect failed: %s', err)` has `args[0]` as a string, so `hooks.logMethod`
  (`:62-64`) takes the `!(first instanceof Error)` branch and passes `args` through unmodified —
  `err` is never intercepted, and `%s`/`%o` interpolation stringifies the raw `Error` (including its
  `message`) directly into `msg`, with neither the hook nor `serializers.err` ever seeing it. Verified
  no such call site exists today (`grep -rn "log\.\(error\|warn\|...\)(" ... | grep "%[sdifjoO]"`
  returns nothing across `apps/control-plane/src`, `apps/web/src`, `packages`), so this is latent, not
  exploited — but nothing (no lint rule, no wrapper type) prevents a future call site from
  reintroducing it.
- **Error nested under a non-`err` key.** `serializers.err` (`:42-46`) is registered by pino for the
  literal key `err` only. A call like `logger.warn({ error: someError }, 'msg')` (key `error`, not
  `err`) bypasses the custom serializer entirely; pino would then serialize the raw `Error` object
  with no serializer applied. For a bare `Error`, `message`/`stack` are non-enumerable own properties
  so this specific shape does not leak them by default — but a `cause` set via
  `new Error(msg, { cause })` *is* a plain enumerable own assignment and would survive default JSON
  serialization if ever logged un-nested under `err` (the current custom `err` serializer discards
  `cause` because it returns a brand-new `{ name }` object, so this is safe today *only* because every
  call site consistently uses the exact key `err` — confirmed by grep across every log call site in
  `apps/control-plane/src`).

Both gaps are consistent with the module's actual guarantee, but the module's own comment
(`:47-60`, "this hook is what makes `logger.error(err)` safe WITHOUT editing any call site... at
every log level, for every call site") reads as broader than what is actually enforced (every call
site that passes a bare Error as literally `args[0]`, or nests it under literally the key `err`).

**Fix:** Not urgent given zero current exploitation, but worth closing the gap structurally rather
than relying on convention: either (a) add an ESLint rule/pattern banning printf-placeholder log
calls and non-`err`-keyed error objects in this codebase, or (b) extend `hooks.logMethod` to also
scan the merging object's own top-level values (not just `args[0]`) for an `Error` instance under any
key and rewrite each to the same `{ name }`-only shape `serializers.err` already produces, so the
safety net does not depend on every future call site remembering the `err` convention.

### WR-03 (WARNING): `ServerServicesDeps.logger` is optional with nothing enforcing that a future construction site wires it, silently reintroducing GR-03's original defect

**File:** `apps/control-plane/src/services/server-service-deps.ts:44-59`

**Issue:** `logger?: ServiceLogger` is genuinely optional by design (`:52-58`'s own comment: "most
services never log, and a test fixture should not be forced to supply one"), and
`logRecoveryFailure` degrades to a silent no-op when absent (`log-recovery-failure.ts:38-42`, by
design). Both current production call sites (`app.ts:65`, `worker.ts:49`) correctly pass `logger`
today. But nothing — no required field, no lint rule, no runtime assertion — would catch a future
third call site (a new CLI entrypoint, a new worker, a maintenance script) that constructs
`ServerServicesDeps` without a `logger`. That site would compile and run fine, and would silently
reintroduce exactly the "recovery failure disappears with zero trace" defect GR-03 was written to
close, with no test or type-checker signal that anything regressed.

**Fix:** Not urgent while there are only two call sites (both correct), but worth a cheap guardrail
before a third one is added — e.g. a code comment at the `ServerServicesDeps` interface pointing at
`app.ts`/`worker.ts` as the two sanctioned call sites, or a lint rule / grep-based CI check (mirroring
this repo's own `check-package-provenance.mjs` philosophy of "a re-runnable, non-bypassable check
instead of a one-off human read") asserting every `resolveServerServicesDeps(` call site in
production code passes `logger`.

### IN-01 (INFO): `tests/e2e/host-key.spec.ts`'s fixed host ports rely entirely on manual coordination across files

**File:** `tests/e2e/host-key.spec.ts:18-26`

**Issue:** `FIXED_HOST_PORT = 42_544` and `REAL_TRUST_FLOW_HOST_PORT = 42_545` are hardcoded, with a
comment noting they are "distinct from `tests/integration/ssh/host-key-changed.test.ts`'s 42_522 and
`connection-loss.test.ts`'s 42_533." This is correctly reasoned about today (Playwright's own
`workers: 1`/`fullyParallel: false` config serializes this file's own tests against each other), but
the uniqueness guarantee across the whole test suite is manual and undocumented anywhere central — a
new spec file reusing one of these ports by accident would not be caught until a flaky CI run, and
`pnpm test:e2e:repeat`'s nightly loop (mentioned in `CLAUDE.md` §3.2) would be the most likely place
such a collision would first surface, non-deterministically. Not asking for a fix in this delta
review; flagging as worth a shared port-registry constant if this pattern grows past two or three
files.

---

_Reviewed: 2026-09-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
