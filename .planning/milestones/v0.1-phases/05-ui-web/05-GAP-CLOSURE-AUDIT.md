# Phase 05 (ui-web) — Gap Closure Audit (Plan 05-37, the closing gate)

Commit at time of this run: `3546a6d` (HEAD unchanged throughout — this plan creates only this
file). Repository: `/Users/xch4rt/work/myself/noodara/code`, nested inside a personal monorepo with
no git remote (`git remote -v` empty, confirmed again below).

This document trusts no `05-NN-SUMMARY.md` claim. Every verdict below is re-derived from a command
actually run in this session (raw logs in
`/private/tmp/claude-501/-Users-xch4rt-work-myself-noodara-code/ebf9237c-906f-4171-829e-8fa2d8e6adb1/scratchpad/gate-05-37/`)
or a source file actually read in this session, cited by path and line.

---

## 1. The full cross-suite gate, one run, final tree

All eleven commands below were run individually (never chained with `&&`), in the order the plan
specifies, sequentially with respect to Docker usage (never two Docker-consuming suites at once).

| # | Command | Exit | Duration | Result | Log file |
|---|---|---|---|---|---|
| 1 | `pnpm lint` | 0 | 0.80s (cached, `FULL TURBO`) | 9/9 tasks green | `lint.log` |
| 2 | `pnpm typecheck` | 0 | 2.00s (cached, `FULL TURBO`) | 8/8 tasks green | `typecheck.log` |
| 3 | `pnpm boundaries` | 0 | 0.55s | "Checked 612 files in 6 packages, no issues found" | `boundaries.log` |
| 4 | `pnpm check:ui-safety` | 0 | 0.46s | 9/9 gates OK | `ui-safety.log` |
| 5 | `node scripts/check-package-provenance.mjs` | 0 | 28.0s | **52/52** locked direct dependencies verified | `provenance.log` |
| 6 | `pnpm test` (unit) | 0 | 7.33s wall / 6.61s vitest-reported | **1491/1491** passed, 115 files, 0 skipped | `unit.log` |
| 7 | `pnpm build` | **1 then 0** | 2.13s (fail) / 0.56s (pass, see below) | see F1 below | `build-noenv-F1.log`, `build.log` |
| 8 | `pnpm test:boot` | **1 then 0** | 2.73s (fail) / 57.49s (pass, see below) | see F1 below; then **7/7** passed | `boot-noenv-F1.log`, `boot.log` |
| 9 | `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration` | 0 | **2153.44s** (~35.9 min) | **58 files passed, 1 skipped (59); 505 tests passed, 1 skipped (506); 0 failed** | `integration.log` |
| 10 | `pnpm test:e2e --reporter=list` | 0 | 1.5 min | **92/92 passed, 0 failed, 0 skipped** | `e2e.log` |
| 11 | `pnpm security:scan-leaks` | 0 | 3 vitest files (3/3 tests) + 1 Playwright `@canary` test (9.1s) | **all green** | `scan-leaks.log` |

`git rev-parse HEAD` at every step: `3546a6db6adfc0b629a0fadf46c5d1a0062596c7` (unchanged — no
product code was touched by this plan).

### F1 — `pnpm build` / `pnpm test:boot` fail locally without `NOODARA_API_ORIGIN`; CONFIRMED, pre-existing, NOT fixed, does not affect CI

Both `pnpm build` and `pnpm test:boot` (whose `global-setup.ts` → `buildWorkspace()` spawns a bare
`pnpm build` with the parent shell's env, `tests/integration/helpers/boot-process.ts:187-190`) throw
identically on this machine without the env var set:

```
apps/web:build: Error: NOODARA_API_ORIGIN is required (the control plane origin apps/web proxies
/api/* to, e.g. http://localhost:3100 in dev) -- set it before running next dev/build.
```

Re-run with `NOODARA_API_ORIGIN=http://localhost:3100` (the exact value both `ci.yml:45` and
`nightly.yml:34` set at the **workflow-level `env:` block**, applying to every job including
`integration` and `boot-smoke`, confirmed by reading both files): `pnpm build` succeeds (5/5 tasks,
`apps/web` compiles and lists all 9 routes including the new `/` route — see WR-B-15 below);
`pnpm test:boot` then passes 7/7. **Classification: (c) environment problem, pre-existing** — this
is orchestrator finding F1, confirmed byte-for-byte: `turbo.json:7,26` declares
`NOODARA_API_ORIGIN` as a `build.env` input, `tests/integration/global-setup.ts`'s `buildWorkspace()`
never sets it itself, and CI's top-level `env:` block (not a per-job override) means every CI job
already has it. **Not a regression from this wave, not fixed by this wave** (fixing it is out of
this plan's scope — this plan measures and reports only). Both raw failing logs are preserved
(`build-noenv-F1.log`, `boot-noenv-F1.log`) alongside the passing re-runs.

### Baseline diff

| Suite | 05-VERIFICATION.md baseline | This run | Delta | Explained by |
|---|---|---|---|---|
| Unit | 1381/1381 | **1491/1491** | +110 | Eleven gap-closure plans' own new unit tests (contrast.test.ts, connect-wedge tests, detail-sync tests, activity-groups tests, error-copy tests, etc.) |
| Integration | 487 passed / 0 failed / 1 skipped (58 files) | **505 passed / 0 failed / 1 skipped (59 files)** | +18 tests, +1 file | `tests/integration/servers/connect-wedge.test.ts` (05-26, 2 tests) plus other gap-closure integration additions (05-31 trust-fingerprint, 05-34 sse-backpressure, 05-36 provenance) |
| E2E | 73/73 | **92/92** | +19 | Eleven gap-closure plans' new E2E specs (`dod-hardening.spec.ts`, host-key mid-review-swap + real-backend cases, discovery mid-run-mount cases, activity WR-B-04/05 cases, shell revoked-session/root-route cases) |

The one documented flake (`servers-list.spec.ts`'s order-dependent `row.hover()` / row-visibility
cases, `deferred-items.md` "05-19" and "05-20" entries) did **not** reproduce in this run — both
named tests (`:191` keyboard-activation and `:211` actions-menu) passed cleanly
(`e2e.log` lines 60, 62). This is consistent with `deferred-items.md`'s own "rare,
machine/Docker-timing-dependent" characterization, not a claim that it is now impossible.

**No timeout value was changed and no test was newly skipped to make the gate green.**
`git diff a8c03c5..HEAD -- playwright.config.ts vitest.config.ts vitest.integration.config.ts`
is empty — verified directly in this session, zero output. The only skip anywhere in `tests/` or
`src/` is `tests/integration/ssh/stress-connections.test.ts:30`'s
`describe.skipIf(!STRESS_ENABLED)` (100-consecutive-connections stress case, explicitly
env-gated, pre-existing, not part of this wave) — `grep -rn "\.skip\|test\.fixme\|\.only(" tests/
packages/*/src apps/*/src` (excluding node_modules) returns only that one line plus three
unrelated `.skipped`-named boolean fields in `fail-in-flight-connection.test.ts` assertions (not a
Vitest skip API call at all — verified by reading each hit).

### Docker/container hygiene

`docker ps -a --filter "label=noodara.test=true"` returned empty both before and after the full
Docker-using portion of the gate (integration → E2E → security:scan-leaks, run strictly
sequentially, never two at once). One `testcontainers-ryuk-*` reaper container was present
throughout (expected — it is Testcontainers' own reaper, not a stray application container, and a
fresh one is spawned per `NOODARA_API_ORIGIN=... pnpm test:integration` / `security:scan-leaks`
invocation). No process held ports 3000/3100 after the run (`lsof -i :3000 -i :3100` empty).

---

## 2. Re-derived, first-hand verdict per gap

Verdict legend: **CLOSED** (user-visible behaviour proven, real backend where it matters) /
**PARTIAL** (part proven, a real residual remains) / **OPEN** (not proven) / **UNVERIFIED** (no
first-hand evidence obtained — none occurred in this audit).

### Gap 1 — SC3 / DISC-02: discovery shows check-by-check progress, never invents state

**Verdict: CLOSED.**

- `grep -c "firstUnresolvedIndex" apps/web/src/lib/discovery-progress.ts` → **0** (confirmed
  directly; the function was replaced entirely).
- Read the current `buildChecklist`'s `CONNECTING` branch (`discovery-progress.ts:163-206`):
  `settled` is referenced nowhere inside that branch (comment at line 164 states the invariant, and
  a full read of lines 163-206 confirms it — the only use of `settled` is in the `else` branch for
  an already-settled run). `lastReceivedIndex` (the highest index among ids *actually* received,
  `-1` before any arrive) drives a `hasUnresolvedEarlierCheck` flag per step
  (`discovery-progress.ts:176-193`); `aggregateLiveStepState` (`:138-145`) returns `pending` — never
  `pass`/`running` — for a step with an unresolved earlier gap, closing exactly the invented-progress
  hole the gap named.
- E2E, real component render, both passing in this run: `tests/e2e/discovery.spec.ts:168` "@discovery
  a mid-run page load shows all discovery steps pending/running... and none of the previous run" and
  `:332` "a page that joins mid-run never shows an unreceived earlier check as resolved, and excludes
  it from its step" — both `✓` in `e2e.log` (lines 21, 25).
- `liveChecks` clearing: `apps/web/src/app/(shell)/servers/[id]/page.tsx:136-143`'s shared
  `applyServer` clears `liveChecks` on **any** transition into *or* out of `CONNECTING`, from **either**
  source (`'snapshot'` or `'event'`) — the exact fix the gap's `missing:` list asked for (05-19's
  original code only cleared on the SSE-observed transition). E2E `discovery.spec.ts:382` "a finished
  run leaves no checks behind for the next run to inherit" passes (`e2e.log` line 26).

Real vs stub: both proving tests are component/browser-level assertions against the app's real
reducer and real page code, not a stubbed backend (the SSE frames are synthesized by the test
harness, which is the correct level for a pure-reducer/state-accumulation proof).

### Gap 2 — SC2 / DETL-01 / DETL-02: server detail is reliable; "not discovered" vs "discovery failed" each get one action

**Verdict: CLOSED.**

- **Frontend race (WR-B-01/02).** `apps/web/src/lib/detail-sync.ts`'s `reconcileDetailSnapshot`
  (read in full) rejects a snapshot once `isDeleted`, rejects a superseded `requestSequence`, and
  rejects a snapshot strictly older (`Date.parse`) than the currently held server's `updatedAt` —
  exactly `servers/page.tsx`'s sibling `reconcileSnapshot` precedent, applied to the single-entity
  detail page. `servers/[id]/page.tsx:122-150`'s `applyServer` is the **single write path** onto
  `state: {kind:'ready'}` (confirmed: `grep -c "setState({ kind: 'ready'" "apps/web/src/app/(shell)/servers/[id]/page.tsx"` → **1**, inside `applyServer` only). E2E, real races proven in-browser:
  `server-detail.spec.ts:327` "a GET resolved after a live server.updated event does not roll the
  screen back" and `:363` "a server.deleted event followed by a late-resolving GET leaves the
  not-found state, not a resurrected server" — both `✓` (`e2e.log` lines 44, 45).
- **Backend wedge (WR-A-01).** `grep -c "failInFlightConnection" apps/control-plane/src/services/connect-and-discover.ts` → **1** (used), and reading the function (`connect-and-discover.ts:300-378`)
  confirms the `try` starts immediately after TX1 commits `CONNECTING` and publishes the event
  (`:299-303`), wraps `decodeCredential`, `parseFingerprint`, the whole SSH+discovery phase and TX2,
  and the `catch` (`:375-383`) calls `failInFlightConnection({..., reason: 'connect_service_threw'})`
  then rethrows. `grep -c "worker_job_failed" apps/control-plane/src/queue/connect-server-worker.ts`
  → **1**: the worker's `'failed'` listener (`:98-129`) now also calls
  `services.failInFlightConnection({..., reason: 'worker_job_failed'})` as a second line of defense.
  Integration test, real Postgres, a genuinely corrupted credential (one-byte AES-GCM tag flip, not
  a mock): `tests/integration/servers/connect-wedge.test.ts:121` "a post-TX1 throw (corrupted
  credential) resolves the row out of CONNECTING instead of wedging it" and `:140` "recovery is
  idempotent" — both counted in the 505-passed integration total (file present, ran green this
  session).
- `deriveDetailState` (`apps/web/src/lib/detail-state.ts:28-38`, read in full) still branches purely
  on `lastErrorCode`/`hostname`, producing exactly `failed-no-history` or `failed-with-history` for
  any blocking error — since the wedge no longer exists, a real connection failure now always lands
  on one of DETL-02's two named states with its one action, never an unresolvable `CONNECTING` with
  every mutation refused as `SERVER_BUSY`.

Real vs stub: the backend fix is proven by a real Postgres + real AES-GCM-tampered row (not a mock);
the frontend fix is proven by real-browser Playwright races, not `page.route` stubs.

### Gap 3 — SC5 / QA-04 / QA-05: E2E covers the critical flow; nightly repeats 20/20 with the canary in the same run

**Verdict: OPEN — by design, and correctly still `Pending` in REQUIREMENTS.md.**

- `git remote -v` → empty (confirmed again in this session).
- `docs/ci-readiness.md` (read in full) states plainly: no GitHub Actions run — CI or nightly — has
  ever executed for this repository; every "pass" on record is a local shell simulation of the
  command a workflow step would run, never the same thing as the workflow's own runner, permissions,
  concurrency and scheduling behaviour. The document does not claim completion anywhere.
- What **is** now locally fixed and verified in this session (05-36, confirmed by direct reads):
  `ci.yml`'s `security` job and `nightly.yml`'s `canary` job both now run
  `pnpm exec playwright install --with-deps chromium` before the canary script (`awk` extraction,
  confirmed present in both files); every job in both workflows has an explicit `permissions:` block
  and a `timeout-minutes:`; every third-party `uses:` is pinned to a 40-char commit SHA (`grep -c
  "uses:.*@[0-9a-f]\{40\}"` → 27 in `ci.yml`, 9 in `nightly.yml`; `grep -n "uses:.*@v[0-9]"` on both
  → empty); the gitleaks binary download is now checksum-verified (`sha256sum -c`) before
  extraction. None of this constitutes an observed CI run.
- This verdict **must remain OPEN** per the plan's own instruction, and does: QA-04/QA-05 stay
  `Pending` in `.planning/REQUIREMENTS.md` (unedited by this plan — see `git status` check below),
  and the exact human observation required is restated in section 3 below.

### Gap 4 — CLAUDE.md §2.2/§2.3 Definition of Done bar

**Verdict: PARTIAL — the four named blockers are closed; two residuals remain, one of them explicitly out of this wave's authorised scope, one only partially closed.**

- **Timeout (api-client.ts).** `grep -v '^\s*[/*]' apps/web/src/lib/api-client.ts | grep -cE
  "AbortSignal|AbortController"` → **3** matches (`composeSignal`, `AbortSignal.timeout`,
  `AbortSignal.any`, `api-client.ts:238-245`, read in full). E2E proof against a real hung request is
  indirect (unit-level `api-client.test.ts`, part of the 1491 unit total) — acceptable, a real network
  hang is not practically reproducible in Playwright without a proxy the plan does not authorise.
- **CopyButton.** `grep -c "navigator\.clipboard\.writeText" packages/ui/src/CopyButton.tsx` → **1**
  match, but it is now behind `typeof clipboard?.writeText !== 'function'` feature-detection
  (`CopyButton.tsx:37-45`, read in full) — the doc comment's prior false claim is corrected in place
  (lines 22-27). Real-browser proof: `tests/e2e/dod-hardening.spec.ts:18` "clicking a copy button
  with navigator.clipboard removed leaves the page functional and shows no confirmation" — `✓`
  (`e2e.log` line 28), with a `page.on('pageerror', ...)` assertion of zero errors, not a stub.
- **error.tsx / localStorage.** `find apps/web/src/app -iname "error.tsx"` →
  `apps/web/src/app/(shell)/error.tsx` exists. `servers/[id]/page.tsx` now imports and calls
  `safeLocalStorage()` (`:43, 272, 277`) instead of dereferencing `window.localStorage` directly.
  Real-browser proof: `dod-hardening.spec.ts:56` "the server detail screen still renders its facts
  when localStorage access throws" — `✓` (`e2e.log` line 29).
- **Contrast gate ≥4.5:1 in both themes.** `packages/ui/src/contrast.test.ts` (part of the 1491-test
  unit run, green) audits 76 pairs; 67/76 pass, and every one of the 9 documented failures is in a
  named, justified allowlist (`KNOWN_UNRENDERED_OR_DEFERRED_FAILURES`, `contrast.test.ts:248-269`,
  read in full) that a **second test** (`:296-306`) forces to stay non-stale (fails the suite if an
  allowed pair ever starts passing, so the allowlist cannot silently rot). Two of the nine are real,
  currently-shipping, **explicitly out-of-scope-for-this-wave** residuals per the user's own D2
  decision (`docs/contrast-decision-05.md` §3, "Nueva brecha descubierta"): `--accent` as link text
  on `--canvas` (4.31:1) and `--surface-3` (4.12:1) in light mode — both pass the 3:1 non-text
  threshold, fail the 4.5:1 text threshold, and D2 explicitly forbids darkening `--accent` to fix
  this (it would break the deliberately-preserved link/outline colour). This is a genuine,
  user-accepted trade-off, not an oversight — but it is a real DoD §2.2 gap (AA text contrast) that
  remains open. Separately (not part of the 76-pair gate, measured "by curiosity" per
  `deferred-items.md`): `Button.tsx`'s `destructive`+`filled` variant (white on `--status-error`) is
  3.54:1 light / 3.40:1 dark — **fails AA in both themes**, was never in `files_modified` for any
  gap-closure plan, and remains unfixed.
- **Trust-fingerprint TOCTOU** ("altas [vulnerabilidades] solo con mitigación documentada"): **now
  closed**, see Gap 6 below — this sub-item of gap 4 is resolved by gap 6's fix, not merely
  documented.
- **Residual not named by the gap but found in this session: WR-A-04 (err serializer) is only
  partially closed.** `apps/control-plane/src/logger.ts` (read in full) still has only the original
  `serializers.err` config (`:40-44`) — the systemic fix the code review recommended (a
  `hooks.logMethod` interceptor in `createLogger` that reshapes *any* bare-`Error`-as-first-argument
  call site, closing the hole for every future call site, not just the one found) was **not**
  implemented. What *was* fixed: the one call site the review found (`server.ts:29`, now `:34`) was
  changed to the safe `app.log.error({ err }, 'listen failed')` form (confirmed: `grep -n "listen
  failed\|app.log.error" apps/control-plane/src/server.ts` → line 34, object form). `grep -rn
  "\.error(err)\|\.error(new Error\|\.warn(err)\|\.fatal(err)" apps/control-plane/src --include="*.ts"`
  (excluding tests) → **0** matches repo-wide today, so nothing is *currently* bypassing the
  serializer — but `logger.test.ts` (read in full) has no test case for the bare-`Error`-as-
  first-argument shape, so a future call site written as `logger.error(err)` would reintroduce
  exactly WR-A-04's leak with no test or lint rule to catch it. **PARTIAL, not CLOSED**, for this one
  sub-item.

Real vs stub: CopyButton and localStorage fixes are proven against a real browser with a real
`pageerror` listener, not a route stub — the strongest evidence class available for a client-only
defect.

### Gap 5 — SC1 / UI-02: every screen's error state works; a server-rejected field is highlighted

**Verdict: PARTIAL — the named defect is fixed; a related, adjacent residual was found live in current source.**

- `grep -c "normalizeFieldPath" apps/web/src/lib/error-copy.ts` → **4** (definition + 3 comment/call
  references). Reading the function (`error-copy.ts:106-113`) confirms it strips the leading `/`,
  keeps only a single-segment path or normalizes any `/credential/*` nested path (including the bare
  `/credential` root) onto one `'credential'` form key — matching the real backend's AJV
  `instancePath` shape, pinned independently by `apps/control-plane/src/routes/http-errors.test.ts:95-111`'s own fixtures (`{ instancePath: '/name', ... }`, etc.).
- E2E, `page.route`-stubbed **request/response contract only** (the backend shape itself is proven
  by the unit test above, not this E2E — a real contract seam, disclosed below):
  `tests/e2e/server-sheet.spec.ts:193` "a real-shaped server-rejected VALIDATION_FAILED issue
  highlights its field inline, with no orphan 'Check the highlighted fields' banner" — `✓`
  (`e2e.log` line 52).
- `apps/web/src/app/setup/page.tsx` (read in full): the blanket-fallthrough bug is gone —
  `NETWORK_ERROR` gets its own message (`:102-105`), everything else falls to a generic
  `INTERNAL_ERROR`-shaped copy (`:107-108`) rather than the false "link no longer valid" banner.
  E2E: `setup.spec.ts:49` "a stubbed 500... never renders the invalid-link banner" and `:65` "a
  network failure... renders the reachability message, never the invalid-link banner" — both `✓`
  (`e2e.log` lines 73, 74).
- **Contract seam (F4, confirmed):** no single test proves the *real* backend producing a
  `VALIDATION_FAILED` body over *real HTTP* is then correctly rendered by the *real* frontend in the
  *same* test — `http-errors.test.ts` pins the backend shape (unit), `server-sheet.spec.ts:193`
  proves the frontend consumes that shape (E2E, but with the body supplied by `page.route`, not a
  real control-plane response). This is a genuine seam, not a failure — the two ends are each
  independently, directly proven — but it should not be described as "closed end-to-end".
- **New residual found live in current source, not previously named by any gap or review finding:**
  `apps/web/src/components/ServerSheet.tsx`'s `handleApiFailure` (`:111-142`, read in full) maps
  *any* `VALIDATION_FAILED` issue through `fieldErrorsFromIssues` and, if the resulting map is
  non-empty, calls `setFieldErrors(mapped)` and returns *before* the toast fallback
  (`:118-124`). `normalizeFieldPath`'s `KNOWN_FORM_FIELD_PATHS` (`error-copy.ts:77-85`) includes
  `'sshUser'`, so a server-side `/sshUser` validation error **does** get mapped into `fieldErrors`.
  But `ServerSheet.tsx`'s JSX (`:303-316`) renders the "SSH user" `Field` with **no `error` prop**
  at all (confirmed: `grep -n "error=\|fieldErrors\." apps/web/src/components/ServerSheet.tsx` lists
  `fieldErrors.name`, `.host`, `.sshPort`, `.credential` — never `.sshUser`). The practical effect: a
  server-side rejection of the SSH user field now produces **zero** visible feedback — not the old
  generic toast (suppressed because `mapped` is non-empty), not a highlighted field (no `error` prop
  wired) — silently worse than the pre-gap-closure behaviour for this one field. This is exactly the
  "latent second bug" `05-REVIEW.md` WR-B-07 warned about ("even with matching paths, sshUser...
  would be put in fieldErrors and return early, but ServerSheet only renders name|host|sshPort|
  credential — the user would see nothing at all") and it is **still present**, confirmed by direct
  source read in this session, not by re-running any test (no test exercises a `/sshUser` server
  rejection).

Real vs stub: the backend shape is proven by a real unit test against real AJV/Zod output; the
frontend consumption is proven by a real-browser E2E whose *stimulus* (the response body) is a
stub — disclosed above as a seam, not a failure of either individual proof.

### Gap 6 — Host-key trust is bound to what the admin saw (TOFU, CLAUDE.md §2.3 non-negotiable)

**Verdict: CLOSED.** All three linked defects are fixed, with a real atomic-database enforcement,
not merely a client-side narrowing.

- `grep -rn "TrustFingerprintBodySchema" apps/control-plane/src/routes/` → declared in
  `server-schemas.ts:77` (`z.object({ fingerprint: z.string().min(1) }).strict()`), wired as the
  route's `body` schema in `servers.ts:269`. The route no longer accepts an empty body.
- `grep -c "and(eq(servers.id" apps/control-plane/src/services/trust-fingerprint.ts` → **1**. Reading
  `trust-fingerprint.ts` in full confirms the promotion is a single atomic `UPDATE ... WHERE id = ...
  AND pending_fingerprint = input.fingerprint` (`:101-112`) inside a row-locked transaction — a value
  that changed underneath the admin between "saw" and "click" fails closed as `FINGERPRINT_MISMATCH`
  (`:113-119`) with **no** status change, activity event or published event, proven by
  `.returning()` yielding no row. The service also now rejects `SERVER_NOT_TRUSTABLE` via the
  domain's `canTrustFingerprint(row.status)` (`:81-87`, `packages/domain/src/server/server-state.ts:97`,
  property-tested against `transition()` itself in `server-state.test.ts:149-160` so it cannot drift).
- `grep -c "apiGet" apps/web/src/components/TrustFingerprintDialog.tsx` → **0**. Reading the file in
  full (header comment `:1-30` plus the snapshot effect `:75-87`) confirms the former client-side
  re-GET-and-compare is removed entirely and replaced by a `useEffect` keyed **only** on `open` that
  snapshots `server.pendingFingerprint`/`pendingFingerprintSeenAt` the instant the dialog opens; a
  live `server.updated` prop swap while the dialog stays open no longer changes what is displayed or
  POSTed (`handleConfirm` at `:93-111` sends `snapshot.fingerprint`, never `server.pendingFingerprint`
  directly).
- `grep -c "row.status === 'ERROR' && row.pendingFingerprint !== null" apps/control-plane/src/services/edit-server.ts` → **0** (the old status-keyed comment/condition is gone). Reading
  `edit-server.ts:156-250` in full confirms `identityChanged` (host/port/**and sshUser**) now clears
  `pendingFingerprint`/`pendingFingerprintSeenAt` unconditionally, composed with (not replacing) the
  pre-existing `CONNECTED`-only `hostFingerprint`-clearing branch — status-independent, exactly as
  WR-A-02's fix required, including the `sshUser` case the domain's own `classifyServerEdit`
  deliberately excludes (documented reasoning at `:150-156`).
- Real-backend E2E proof (not a stub): `host-key.spec.ts:520` "the real trust-fingerprint POST
  succeeds end to end against the real backend" — `✓`, 9.3s (`e2e.log` line 37). The mid-review-swap
  regression E2E (`host-key.spec.ts:351`) uses a stubbed 409 for the *response* but asserts the
  real *request contract* (`trustRequests[0]?.postDataJSON()).toEqual({ fingerprint:
  OBSERVED_FINGERPRINT })` at `:280` case, `✓` in `e2e.log` line 34) and explicitly cites the
  real-backend integration test (`tests/integration/http/trust-fingerprint.test.ts`, part of the
  505-passed integration total) as the primary proof of the atomic UPDATE itself — a deliberate,
  disclosed split between client-contract and server-behaviour proof, not a gap.
- **F9 confirmed, unfixed (expected — not part of this gate's scope):** `host-key.spec.ts:21`
  still binds a literal fixed port (`FIXED_HOST_PORT = 42_544`) for its real-sshd fixture, plus a
  second fixed port for the 05-31 real-backend case — a theoretical collision risk on a shared CI
  runner, not touched by any gap-closure plan.

Real vs stub: the backend atomicity is proven by a real Postgres transaction (integration test) and
a real end-to-end E2E POST; only the *swap-mid-review* regression's HTTP response is stubbed, and
that test explicitly says so and points to the real-backend proof elsewhere.

### Gap 7 — SC4 / ACT-02: activity log stays correct while it refreshes

**Verdict: CLOSED.**

- `grep -n "groupByDay(" apps/web/src/components/ActivityList.tsx` → `groupByDay(state.items, now,
  viewerTimeZone)` — **three arguments**, confirmed. `viewerTimeZone` defaults to
  `Intl.DateTimeFormat().resolvedOptions().timeZone` at the component layer (not inside the pure
  `activity-groups.ts` module), closing WR-B-06.
- WR-B-04 (failed background refresh wiping the list): `apps/web/src/app/(shell)/activity/page.tsx:130-138` (read in full) — the failure branch is now `setState((prev) => prev.kind === 'ready' ? prev
  : {kind:'error', ...})`, mirroring the pre-existing `loadOlder` precedent. E2E, real SSE-triggered
  refresh against a real `PATCH /api/servers/:id`: `activity.spec.ts:163` "a failed background
  refresh keeps every already-loaded row on screen (WR-B-04)" — `✓` (`e2e.log` line 3).
- WR-B-05 (silent gap on a full non-overlapping refresh page): `activity/page.tsx:142-168` (read in
  full) — `mergePage`'s `'refresh'` overload now returns `{items, contiguous}`; when `contiguous` is
  `false` (a full `PAGE_LIMIT` page sharing no id with what's loaded), the page resets to the fresh
  page rather than silently splicing. E2E: `activity.spec.ts:257` "a background refresh that returns
  a full page with no overlap resets to the fresh page instead of showing an unmarked gap (WR-B-05)"
  — `✓` (`e2e.log` line 4).

Real vs stub: both fixes are proven via real SSE-triggered refreshes against the real backend
(`PATCH /api/servers/:id` produces a genuine `server.updated` event that triggers the refresh path
under test), not synthetic events.

### Gap 8 — Triage batch (WR-B-15, WR-C-01, WR-A-03, WR-A-04, WR-B-10, setup-token + Referrer-Policy, UF-02, WR-C-14)

| Item | Verdict | Evidence |
|---|---|---|
| **WR-B-15** (no `/` route) | **CLOSED** | `apps/web/src/app/page.tsx` exists, `redirect('/servers')` (read in full). `pnpm build`'s route table lists `┌ ○ /` (build.log). E2E real-browser: `shell.spec.ts:165` "an authenticated visit to the bare origin lands on /servers" and `:172` "unauthenticated... lands on /login" — both `✓` (e2e.log lines 82, 83). |
| **WR-C-01** (ThemeToggle hydration mismatch) | **CLOSED** | `ThemeToggle.tsx:70-73` (read in full): `useState<Mode>('system')` — fixed, environment-independent initial value, identical server/first-client-render; the real stored value is adopted in a mount `useEffect` (`:82-88`), guarded by `settledRef` against a one-frame clobber of the pre-hydration bootstrap value. Unit-level `hydrateRoot`/`onRecoverableError` proof (05-35-SUMMARY, part of the 1491 unit total) — no browser-console-based proxy used. |
| **WR-A-03** (SSE writes unchecked / no backpressure) | **CLOSED** | `apps/control-plane/src/routes/events.ts:36,43,105,107-124,153` (read): `SSE_MAX_BUFFERED_BYTES = 1_048_576`, `reply.raw.on('error', evict)`, a `safeWrite` wrapper used for both the heartbeat and stream writes, checking `writableLength` against the budget. Real-TCP-socket integration test `tests/integration/events/sse-backpressure.test.ts` (part of the 505-passed total, shrinks real socket buffers to converge deterministically). |
| **WR-A-04** (err serializer bypassable) | **PARTIAL** | See gap 4 above — the one found call site is fixed; the systemic `hooks.logMethod` closure was not implemented, and no regression test covers the bare-`Error`-as-first-arg bypass shape, so a future call site can reintroduce it undetected. |
| **WR-B-10** (revoked session never redirects) | **CLOSED** | `apps/web/src/app/(shell)/layout.tsx` (read: `:28,49`) re-runs `requireSession()` on the shared SSE stream's `connected: true→false` transition. Real-backend E2E: `shell.spec.ts:190` "a session revoked server-side redirects the open tab to /login without a manual reload" — uses `page.request.delete('/api/sessions/:id')` against the real route, not a stub (`shell.spec.ts:203`), no `page.reload()` call anywhere in the test — `✓`, 16.4s (`e2e.log` line 84). |
| **setup-token URL + Referrer-Policy** | **CLOSED** | `apps/web/src/app/setup/page.tsx:48-51` strips `?token=` via `history.replaceState` after mount; `apps/web/next.config.ts:55` sets `Referrer-Policy: no-referrer`. E2E: `setup.spec.ts:17` "every response carries Referrer-Policy: no-referrer" and `:31` "strips the token from the URL after mount while the field stays pre-filled" — both `✓` (e2e.log lines 71, 72). Both source todos moved to `.planning/todos/completed/` — see disposition below. |
| **UF-02** (`worker.ts main()` uncaught) | **CLOSED for worker.ts; server.ts's equivalent explicitly and knowingly left open** | `apps/control-plane/src/worker.ts:122-125` (read in full): `main().catch((err) => { logger.error({err}, 'worker boot failed'); process.exit(1); })`. The file's own comment (`:113-120`) discloses that `server.ts`'s equivalent bare `void main();` (confirmed present, `server.ts` tail, read in full) was **deliberately not touched**, citing it as out of this specific plan's scope and noting `05-REVIEW.md`'s own "out-of-scope observation" already flags it. This is an honest, disclosed residual, not a hidden one. |
| **WR-C-14** (provenance gate coverage) | **CLOSED** | `node scripts/check-package-provenance.mjs` → **"Coverage: 52/52 locked direct dependencies verified"** (provenance.log), enumerated from `pnpm list -r --depth 0 --json` (the real locked tree) rather than a hardcoded list, closing all seven previously-unchecked production packages named by WR-C-14 (`ssh2`, `argon2`, `better-auth`, `pg`, `fastify`, `pino`, `zod`). The registry-metadata-trust limitation (a `repository.url` is publisher-asserted, not registry-verified) is disclosed in the script's own header and in `docs/ci-readiness.md`, not silently accepted as fully closed. |

### Requirements reconciliation

| Requirement | REQUIREMENTS.md status | This audit's evidence-based verdict | Agrees? |
|---|---|---|---|
| SERV-04 | Complete | Complete — no defect ever found against this requirement in any review pass or this session | Yes |
| DETL-01 | Complete | Complete — gap 2's frontend race and backend wedge are both closed with real-Postgres/real-browser proof; the 05-VERIFICATION "BLOCKED" classification predates these fixes and no longer applies | Yes (now genuinely earned) |
| DETL-02 | Complete | Complete — same gap-2 fix; `deriveDetailState` always lands on one of the two named states now that the wedge cannot occur | Yes (now genuinely earned) |
| ACT-02 | Complete | Complete — gap 7's WR-B-04/05/06 fixes are all proven against real SSE-triggered refreshes | Yes (now genuinely earned) |
| SET-01 | Complete | Complete — no defect ever found | Yes |
| UI-01 | Complete | Complete, **with two disclosed residuals that do not block the literal requirement text** (dark/light shell + keyboard nav): the `--accent`-as-link-text contrast gap (2 pairs, user-accepted D2 trade-off) and the destructive-filled-button contrast gap (never in any gap-closure plan's scope) | Yes, with residuals noted |
| UI-02 | Complete | **Should be flagged, not silently left Complete** — the field-error mismatch (WR-B-07's primary defect) is fixed, but a live, first-hand-confirmed residual remains: a server-side `sshUser` validation error is silently swallowed (mapped into `fieldErrors`, never rendered, toast fallback suppressed) — see gap 5 above. Narrow (one field, one error path) but real and currently shipping. | **Partially — recommend the status stay Complete only if this residual is explicitly logged as a follow-up todo (not done automatically by this plan)** |
| DISC-02 | Complete | Complete — gap 1's fix is thorough and test-proven at both the reducer and E2E level | Yes (now genuinely earned) |
| QA-04 | Pending | Pending — correctly so; no real CI run has ever occurred (`docs/ci-readiness.md`, `git remote -v` empty) | Yes |
| QA-05 | Pending | Pending — correctly so, same reason; the local security:scan-leaks fix (playwright install step) is a necessary but not sufficient condition, unobserved on real CI | Yes |

`git status` confirms no edit to `.planning/REQUIREMENTS.md`, `.planning/STATE.md` or
`.planning/ROADMAP.md` by this plan (checked above, clean).

### Todo dispositions

Both todos were found already moved to `.planning/todos/completed/` (not in `pending/`) at the start
of this session:

- **`2026-09-19-trust-fingerprint-toctou.md`** — **closable, disposition confirmed correct.** Its own
  "Solution" section's four numbered steps match, item for item, what gap 6's source-read confirmed
  above (atomic conditional UPDATE, `FINGERPRINT_MISMATCH` code, dialog sends the exact displayed
  fingerprint, integration + concurrency test coverage).
- **`2026-09-19-setup-token-url-hardening.md`** — **closable, disposition confirmed correct.** Its
  three numbered steps (strip the token from the URL, `Referrer-Policy: no-referrer`, confirm no
  web-side log line includes the query string) match the gap-8 evidence above; the third item
  (log-line check) was not independently re-verified by grepping web-side logs in this session, but
  the header/URL-stripping fixes are directly confirmed.

---

## 3. Human verification

The user's verbatim answer to the Task 3 checkpoint (2026-09-20, in Spanish):

> Approve y haz un gsd quick del sshUser bug

**Recorded honestly, without embellishment:**

- The user **approved** closing the gap-closure wave.
- The user did **not** state which of the six human-verification items (listed in the checkpoint's
  `how-to-verify`) they actually checked versus deferred. Therefore **none** of the six may be
  recorded as "verified by the user". All six are recorded below as **pendiente — no confirmado por
  el usuario**, so they keep surfacing as UAT items in the orchestrator's own verification step. No
  item is inferred as checked, and none is softened to "implicitly approved":

  1. The contrast change on a real display, both themes — **pendiente — no confirmado por el usuario**.
  2. A real CI run (QA-04/QA-05) — **pendiente — no confirmado por el usuario**.
  3. A live walkthrough with SSE actually visible (not through a buffering tunnel) — **pendiente — no
     confirmado por el usuario**.
  4. Sheet/Dialog/RowMenu elevation (flat + hairline + backdrop-blur vs. floating shadow) —
     **pendiente — no confirmado por el usuario**.
  5. RowMenu with a real screen reader (VoiceOver/NVDA) — **pendiente — no confirmado por el
     usuario**.
  6. Responsive behaviour below 1280px on real touch hardware, and `prefers-reduced-motion`'s felt
     effect — **pendiente — no confirmado por el usuario**.

- **New bug found live in this session (gap 5, still PARTIAL — see section 2):** `ServerSheet.tsx`
  passes no `error` prop to the SSH user `Field`, so a server-side `sshUser` validation error is
  silently swallowed. The user instructed that this be fixed via a **separate `/gsd-quick` task**,
  run by the orchestrator immediately after this plan closes — **not** by this executor. Disposition:
  **fix en curso vía `/gsd-quick` (fuera de este plan)**. Gap 5 stays **PARTIAL** in this document;
  it is not pre-emptively flipped to CLOSED.
- QA-04 / QA-05 remain `Pending` in `.planning/REQUIREMENTS.md` (no git remote, no observed CI/nightly
  run). This plan does not change them — see the requirements reconciliation table in section 2.

### Orchestrator findings (post-checkpoint)

**F13 — SSE broadcaster boot-window warning, deterministic, pre-existing, not a leak.** The
integration log contains **125** occurrences of the `warn` "sse broadcaster failed to start within
the boot window" (`apps/control-plane/src/app.ts:261`, the D-27 degraded-mode catch when Redis is
unreachable at boot). The count is **identical (125)** in the orchestrator's own wave-1 integration
run and in the final gate run recorded in section 1 — confirmed by grepping both raw logs in this
session — so it is deterministic and pre-existing, not introduced by this gap-closure wave. Only
`app.log.warn({ err }, ...)`'s object form is logged (confirmed by reading `app.ts:255-263`); no bare
error and no leak. **Disposition: low priority** — confirm the suites that trigger this intentionally
boot without Redis reachable, and consider silencing/asserting on it explicitly so that a *real*
broadcaster startup failure is not lost in 125 lines of expected noise — this exact code path (an
SSE subscriber not yet ready) hid a genuine product bug once before (see STATE.md's 05-20 SSE
lost-event-race entry).

**Correction to WR-A-04's wording in section 2 above (Gap 4 / Gap 8).** A direct grep in this session
— `grep -rn '\.error(err)\|\.error(new Error\|\.warn(err)\|\.fatal(err)' apps/control-plane/src
--include="*.ts"` (excluding `*.test.ts`) — returns **zero** matches repository-wide today, confirming
what section 2 already stated: nothing currently bypasses the `err` serializer. The prior wording of
this residual ("a hole") overstates the present state. Corrected wording: **nothing prevents a future
call site from bypassing the serializer** (no lint rule, no `hooks.logMethod` interceptor, and no
regression test asserts the bare-`Error`-as-first-argument shape is caught) — this is an absent
guardrail against a *future* regression, not a currently-exploitable hole. The verdict for this
sub-item stays **PARTIAL**, only the wording is corrected here.
