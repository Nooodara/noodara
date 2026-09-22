---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 04
subsystem: api
tags: [credentials, encryption, server-view, dependency-injection, tdd, security]

# Dependency graph
requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: "03-01's loadPrivateKey/InvalidCredentialError export from @noodara/ssh; 03-03's dockerComposeVersion column and discovery_snapshots table"
provides:
  - "ServiceActor ({type:'user',id}|{type:'system'}) and resolveServerServicesDeps({db,ssh,timeouts,redactor,masterKeys,now}), declared once for every later service"
  - "credential-store.ts: encodeCredential/decodeCredential/currentKeyVersion, the single envelope <-> SshCredential boundary"
  - "server-view.ts: toServerView/SERVER_VIEW_KEYS/ServerView, the single public server projection"
affects: [03-05-registerServer, 03-06-editServer, 03-07-deleteServer, 03-08-connectAndDiscover, 03-09-trustFingerprint]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "resolveServerServicesDeps resolves each field lazily (db ?? getDb(), ssh ?? createSsh2Adapter(), ...) so a test-supplied override never triggers the real side effect (a Postgres pool, a live SSH adapter) it replaces"
    - "toServerView is an explicit field-by-field allowlist construction, never `{ ...row }` with deletes -- a polluted/extended input row cannot leak a new field just by existing"
    - "Hand-assembling the OpenSSH openssh-key-v1 private-key wire format around node:crypto-generated raw key material, for a unit test that needs a real ssh2-parseable ed25519 key without ssh-keygen and without a committed literal"

key-files:
  created:
    - apps/control-plane/src/services/server-service-deps.ts
    - apps/control-plane/src/services/server-service-deps.test.ts
    - apps/control-plane/src/services/credential-store.ts
    - apps/control-plane/src/services/credential-store.test.ts
    - apps/control-plane/src/services/server-view.ts
    - apps/control-plane/src/services/server-view.test.ts
  modified: []

key-decisions:
  - "credential-store.ts's decodePrivateKey validation credential reuses SecretKind 'ssh_private_key' for the passphrase field too (no dedicated passphrase kind exists in the closed SecretKind union) -- matches 03-RESEARCH.md's Pattern 4 exactly"
  - "MasterKeys is declared once in server-service-deps.ts (Task 1) and imported by credential-store.ts (Task 2), rather than redeclared, following D-17's 'declared once and shared' rule for actor/dependency shapes"
  - "credential-store.test.ts generates RSA-2048/1024 via node:crypto.generateKeyPairSync (PKCS#1 PEM) as the plan specified, hand-assembles an unencrypted ed25519 OpenSSH container in pure JS (no shell-out) since node:crypto has no OpenSSH export format, and shells out to ssh-keygen only for the passphrase-protected ed25519 key (bcrypt-pbkdf wrapping is infeasible to reproduce by hand in a unit test) -- see Deviations"
  - "SERVER_VIEW_KEYS has 27 entries, not the plan's stated 26 -- see Deviations"

requirements-completed: [SERV-01, SERV-02, SEC-02]

# Metrics
duration: 42min
completed: 2026-09-16
---

# Phase 3 Plan 4: Shared Service Building Blocks Summary

**The three building blocks every wave-3-5 service depends on: the ServiceActor/injected-dependency contract (D-17), the single credential envelope boundary (D-15/SEC-02), and the ServerView allowlist projection (D-19) -- all TDD RED->GREEN, zero database transactions opened.**

## Performance

- **Duration:** 42 min
- **Started:** 2026-09-16T20:37:00Z (approx)
- **Completed:** 2026-09-16T20:55:00Z (approx)
- **Tasks:** 3 completed
- **Files modified:** 6 (all new)

## Accomplishments

- `ServiceActor` (`{type:'user',id}|{type:'system'}`) and `resolveServerServicesDeps` (D-17) are declared once in `server-service-deps.ts`; every default (`db`, `ssh`, `timeouts`, `redactor`, `masterKeys`, `now`) resolves lazily from `env`/process singletons so that a test-supplied override never triggers the real side effect it stands in for -- proven by 12 unit tests, including one asserting `'previous' in deps.masterKeys` is `false` when `NOODARA_MASTER_KEY_PREVIOUS` is unset.
- `credential-store.ts` is now the only file in `apps/control-plane` that imports both `envelope.ts`'s crypto primitives and the `credentials` schema. `encodeCredential` validates a private key with `@noodara/ssh`'s own `loadPrivateKey` (grep-verified: zero local `ACCEPTED_KEY_TYPES`/`2048` duplication) before ever encrypting, stores the optional passphrase inside the same JSON envelope with the key omitted entirely when absent (D-15), and `decodeCredential` yields an `SshCredential` whose fields are `SecretValue` only, retrying under `masterKeys.previous` on a `SecretTamperError` for the D-11 rotation window. 16 unit tests cover both directions plus a tamper case and two no-plaintext-leak assertions.
- `server-view.ts`'s `toServerView` is an explicit field-by-field allowlist (`SERVER_VIEW_KEYS` as the single source of truth) that structurally cannot leak a credential-shaped field, proven against a row deliberately polluted with `credentialId`/`encryptedValue`/`password`/`privateKey`/`passphrase`/`secret`/`token`.
- `pnpm test` (735 tests), `pnpm typecheck`, `pnpm lint`, and `pnpm boundaries` are all green; `packages/ssh/src/boundary.test.ts` stays green (no `ssh2` leaked into `apps`); no plan file opens a `db.transaction`.

## Task Commits

Each task was committed atomically (TDD: test -> feat per task):

1. **Task 1: ServiceActor + injected dependencies (D-17)**
   - RED: `6b2404b` (test)
   - GREEN: `030edcd` (feat, includes a lint fix: fake `SshPort.connect` returns a resolved Promise directly instead of an unnecessary `async` arrow)
2. **Task 2: credential-store -- the single envelope boundary (D-15, SEC-02)**
   - RED: `6031864` (test)
   - GREEN: `96122b0` (feat, includes four lint fixes in the test file -- see Deviations)
3. **Task 3: ServerView projection and its key-list guard (D-19)**
   - RED: `7a31acb` (test)
   - GREEN: `925823f` (feat, includes the SERVER_VIEW_KEYS count correction and two typecheck/lint fixes -- see Deviations)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified

- `apps/control-plane/src/services/server-service-deps.ts` - `ServiceActor`, `MasterKeys`, `ServerServicesDeps`, `resolveServerServicesDeps`
- `apps/control-plane/src/services/server-service-deps.test.ts` - 12 tests: actor shape, override-wins-over-default for every field, timeouts derivation, `appRedactor` singleton identity, `masterKeys.previous` omission
- `apps/control-plane/src/services/credential-store.ts` - `CredentialInput`, `EncodedCredential`, `EncodeCredentialResult`, `CredentialRow`, `encodeCredential`, `decodeCredential`, `currentKeyVersion`
- `apps/control-plane/src/services/credential-store.test.ts` - 16 tests: password/private-key encode (with/without passphrase), malformed/undersized-RSA/wrong-passphrase/empty-password rejection, decode round-trips, previous-key rotation fallback, tamper detection, no-leak assertions; includes `buildOpenSshEd25519Key` (pure-JS OpenSSH container assembly) and `buildLockedEd25519Key` (ssh-keygen shell-out for the passphrase-protected case)
- `apps/control-plane/src/services/server-view.ts` - `ServerView`, `SERVER_VIEW_KEYS`, `CredentialType`, `toServerView`
- `apps/control-plane/src/services/server-view.test.ts` - 6 tests: key-list guard, credentialType round-trip, 1:1 column mapping, pollution resistance, allowlist-not-delete-list

## Decisions Made

- `MasterKeys` is declared once in `server-service-deps.ts` (Task 1) and imported into `credential-store.ts` (Task 2) rather than redeclared, mirroring D-17's "declared once and shared" rule for the `ServiceActor`/dependency contract.
- `credential-store.ts`'s validation-only `SshCredential` built for `loadPrivateKey` reuses `'ssh_private_key'` as the `SecretKind` for both the key and its passphrase, matching 03-RESEARCH.md's Pattern 4 verbatim (no dedicated passphrase kind exists in the closed `SecretKind` union this phase).
- `currentKeyVersion` is implemented and exported but has no runtime unit test in this plan (per the plan's own instruction) -- it needs Postgres and is integration-tested in plan 03-05.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fake `SshPort.connect` rewritten to avoid an unnecessary `async` arrow**
- **Found during:** Task 1 GREEN verification (`pnpm lint`)
- **Issue:** `@typescript-eslint/require-await` flagged `connect: async () => ({...})` since the arrow body has no `await` expression.
- **Fix:** Changed to `connect: () => Promise.resolve({...})`.
- **Files modified:** `apps/control-plane/src/services/server-service-deps.test.ts`
- **Committed in:** `030edcd`

**2. [Rule 3 - Blocking] Four ESLint errors in `credential-store.test.ts`'s test helpers and assertions**
- **Found during:** Task 2 GREEN verification (`pnpm lint`)
- **Issue:** (a) a shorthand arrow (`cleanup: () => rmSync(...)`) returning a void expression tripped `no-confusing-void-expression`; (b) `'passphrase' in decoded && decoded.passphrase !== undefined` tripped `no-unnecessary-condition` since `exactOptionalPropertyTypes` makes the property's type `SecretValue` (never `| undefined`) once narrowed by `in`; (c) building the tampered blob with `segments[2]!`/uninitialized `segments[n]` (possibly `undefined` under `noUncheckedIndexedAccess`) tripped `no-non-null-assertion` and `restrict-template-expressions`; (d) `String(decoded)` on the `SshCredential` union tripped `no-base-to-string`.
- **Fix:** (a) braced the arrow body; (b) dropped the redundant `!== undefined` check; (c) defaulted each segment to `''` before use in the template literal; (d) narrowed to `String(decoded.password)` after a `decoded.kind !== 'password'` guard, since `SecretValue` itself overrides `toString`.
- **Files modified:** `apps/control-plane/src/services/credential-store.test.ts`
- **Committed in:** `96122b0`

**3. [Rule 3 - Blocking] `pnpm typecheck`/`pnpm lint` fixes in `server-view.test.ts`**
- **Found during:** Task 3 GREEN verification
- **Issue:** (a) `(view as Record<string, unknown>)[field]` failed `tsc` (`ServerView` and `Record<string, unknown>` don't sufficiently overlap without going through `unknown` first); (b) `polluted as unknown as ServerRow` tripped `no-unnecessary-type-assertion` since `polluted` (a variable, not an object literal) is already structurally assignable to `ServerRow` without excess-property checking.
- **Fix:** (a) cast through `unknown` first on both sides of the field-mapping assertion; (b) removed the assertion and passed `polluted` directly.
- **Files modified:** `apps/control-plane/src/services/server-view.test.ts`
- **Committed in:** `925823f`

### Documented Plan-Text Correction

**4. [Rule 1 - Bug in the plan's own arithmetic] `SERVER_VIEW_KEYS` has 27 entries, not the plan's stated 26**
- **Found during:** Task 3 GREEN (first test run failed: `expected length 26, got 27`)
- **Issue:** 03-04-PLAN.md's Task 3 `<behavior>` section literally lists 26 field names ("id, name, host, ... createdAt, updatedAt") and then says "plus credentialType" -- 26 base columns + 1 = 27 total. Its own `<acceptance_criteria>` then states "`SERVER_VIEW_KEYS` has exactly 26 entries", undercounting its own listed fields by one. 03-RESEARCH.md's literal `ServerView` interface (the plan's own quoted source of truth) also has 27 fields, and `must_haves.truths` requires "every `servers` column plus `credentialType`" -- the real `servers` table has 26 columns (verified against `apps/control-plane/src/db/schema/servers.ts`), so 26 + `credentialType` = 27 is the only internally-consistent total.
- **Fix:** Implemented and tested all 27 real fields (every `servers` column plus `credentialType`); corrected the test assertion to `toHaveLength(27)` with an inline comment recording the plan's inconsistency for the record.
- **Files modified:** `apps/control-plane/src/services/server-view.ts`, `apps/control-plane/src/services/server-view.test.ts`
- **Verification:** `Object.keys(toServerView(row, 'ssh_password')).sort()` equals `[...SERVER_VIEW_KEYS].sort()`; every `servers` column round-trips 1:1; no credential-shaped field appears even under a polluted input row.
- **Committed in:** `925823f`

**Total deviations:** 3 auto-fixed lint/typecheck corrections (Rule 3, no behavior change), 1 documented plan-arithmetic correction (Rule 1, kept the code correct against the schema and the plan's own more-authoritative truths/RESEARCH source rather than matching an inconsistent numeric acceptance criterion).
**Impact on plan:** None of the four items change SERV-01/SERV-02/SEC-02 behavior or scope -- all are corrections to test-file lint compliance or to an internally-inconsistent number in the plan text itself.

## Issues Encountered

None beyond the four auto-fixed/documented items above.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `resolveServerServicesDeps`, `encodeCredential`/`decodeCredential`/`currentKeyVersion`, and `toServerView`/`SERVER_VIEW_KEYS` are all in place under `apps/control-plane/src/services/` for plans 03-05 through 03-09 (`registerServer`, `editServer`, `deleteServer`, `connectAndDiscover`, `trustFingerprint`) to import directly.
- `pnpm test` (735 passing), `pnpm typecheck`, `pnpm lint`, and `pnpm boundaries` are all green; `packages/ssh/src/boundary.test.ts` remains green; no `db.transaction` was opened by this plan, exactly as its own verification required.
- No blockers for plan 03-05.

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-16*

## Self-Check: PASSED

All six created source/test files and this SUMMARY are present on disk; all seven commits
(6b2404b, 030edcd, 6031864, 96122b0, 7a31acb, 925823f, 946c673) are present in git history.
