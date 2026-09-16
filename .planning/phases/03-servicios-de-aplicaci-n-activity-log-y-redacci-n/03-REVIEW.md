---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
reviewed: 2026-09-16T21:22:01Z
depth: standard
files_reviewed: 39
files_reviewed_list:
  - .github/workflows/ci.yml
  - apps/control-plane/package.json
  - apps/control-plane/src/activity/boundary.test.ts
  - apps/control-plane/src/db/migrations/0003_phase3_discovery_snapshots.sql
  - apps/control-plane/src/db/migrations/meta/0003_snapshot.json
  - apps/control-plane/src/db/migrations/meta/_journal.json
  - apps/control-plane/src/db/schema/discovery-snapshots.ts
  - apps/control-plane/src/db/schema/index.ts
  - apps/control-plane/src/db/schema/servers.ts
  - apps/control-plane/src/services/connect-and-discover.ts
  - apps/control-plane/src/services/credential-store.test.ts
  - apps/control-plane/src/services/credential-store.ts
  - apps/control-plane/src/services/delete-server.ts
  - apps/control-plane/src/services/edit-server.ts
  - apps/control-plane/src/services/register-server.ts
  - apps/control-plane/src/services/server-service-deps.test.ts
  - apps/control-plane/src/services/server-service-deps.ts
  - apps/control-plane/src/services/server-services.ts
  - apps/control-plane/src/services/server-view.test.ts
  - apps/control-plane/src/services/server-view.ts
  - apps/control-plane/src/services/trust-fingerprint.ts
  - docs/domain/server-state-transitions.md
  - packages/domain/src/activity/activity-event.test.ts
  - packages/domain/src/activity/activity-event.ts
  - packages/domain/src/discovery/index.ts
  - packages/domain/src/discovery/merge-facts.test.ts
  - packages/domain/src/discovery/merge-facts.ts
  - packages/domain/src/server/classify-edit.test.ts
  - packages/domain/src/server/classify-edit.ts
  - packages/domain/src/server/index.ts
  - packages/ssh/src/index.ts
  - packages/ssh/src/run-discovery.test.ts
  - tests/integration/activity/canary-full-flow.test.ts
  - tests/integration/db/migrations.test.ts
  - tests/integration/db/schema.test.ts
  - tests/integration/fixtures/representative-data.ts
  - tests/integration/services/connect-and-discover.test.ts
  - tests/integration/services/delete-server.test.ts
  - tests/integration/services/helpers/service-fixture.ts
  - tests/integration/services/register-server.test.ts
  - tests/integration/services/trust-fingerprint.test.ts
findings:
  critical: 0
  warning: 5
  info: 3
  total: 8
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-09-16T21:22:01Z
**Depth:** standard
**Files Reviewed:** 39 (note: `edit-server.test.ts` was read as part of this review though not present in the `files_reviewed_list` given in the task config — it is the integration counterpart of `edit-server.ts`, which is in scope, and surfaced no additional findings beyond what's below)
**Status:** issues_found

## Summary

This phase adds the five server application services (`registerServer`, `editServer`, `deleteServer`,
`connectAndDiscover`, `trustFingerprint`), the `ActivityEvent`/`SensitiveMetadataError` guard, discovery-fact
merging, the `discovery_snapshots` table/migration, and the credential encode/decode boundary. The transactional
shape (row-lock, pre-checks, atomic write + activity event) is applied consistently across services, the
`ServerView` allowlist is genuinely allowlist-built (not spread-then-delete), and the D-07 "null never overwrites"
fact-merge semantics are exhaustively tested. The full-flow canary test (`canary-full-flow.test.ts`) is a real,
non-trivial secret-leak proof against a live SSH container, which is a strong signal for this phase's core
security goal.

No BLOCKER-level defect was found: no SQL/command injection, no hardcoded secret, no unredacted secret path
proven reachable in the reviewed code. The findings below are WARNING-level robustness/defense-in-depth gaps and
INFO-level quality nits — several map directly to the project's own `noodara-security` skill checklist and are
worth closing before this code is treated as a hardened baseline for phase 4's HTTP layer to build on.

## Warnings

### WR-01: `connectAndDiscover` has no safety net if the SSH phase throws instead of resolving an outcome

**File:** `apps/control-plane/src/services/connect-and-discover.ts:281-323`
**Issue:** `lockAndBeginConnecting` commits `status = 'CONNECTING'` in its own transaction (TX1) *before* any SSH
work happens. The SSH connect (`deps.ssh.connect(...)`) and discovery (`discover(...)`) calls that follow are not
wrapped in any try/catch beyond the `finally { await outcome.session.close(); }` around discovery, which itself
re-throws whatever `discover()` rejected with (or whatever `session.close()` itself throws, silently masking the
original error). The file's own header/JSDoc documents this as intentional ("Pitfall 3") and a test
(`connect-and-discover.test.ts`: "closes the session exactly once even when discovery rejects") proves the
promise is expected to reject in that case — but every other service in this phase (`editServer`, `deleteServer`,
`trustFingerprint`) refuses to act on a server whose `status === 'CONNECTING'`. If `deps.ssh.connect()` or
`discover()` ever throws instead of resolving an outcome (a contract violation somewhere downstream, or
`session.close()` throwing on an already-dropped connection), the row is left in `CONNECTING` permanently with
no compensating transaction and no path back to a sane status through any service reviewed in this phase — an
operator would need a raw SQL `UPDATE`, not an API call, to unstick it. This directly bears on the
`noodara-security` skill's "ningún fallo de infraestructura tumba la API" requirement in spirit: the *process*
survives, but the *resource* becomes permanently unusable through the product surface.
**Fix:** Wrap the post-TX1 SSH/discovery phase in a try/catch that, on an unexpected throw, opens a small
compensating transaction to revert `status` back to a recoverable state (e.g. back to `row.status` pre-CONNECTING,
or a dedicated `ERROR` with a new `error_code` such as `INTERNAL_ERROR`), and writes a `server.connection_attempted`
failure event so the incident is visible in the activity log instead of only in application logs.

### WR-02: Sensitive-metadata denylist is an incomplete, hardcoded key list

**File:** `packages/domain/src/activity/activity-event.ts:109-117`
**Issue:** `FORBIDDEN_METADATA_KEYS` enumerates `password`, `secret`, `token`, `credential`, `privatekey`,
`sshpassword`, `masterkey` — but not `passphrase`, even though `CredentialInput`'s private-key branch
(`credential-store.ts`) has a `passphrase` field that is exactly the kind of value this guard exists to catch.
Nothing in the current phase 3 code paths puts a raw `passphrase` into `metadata` (verified across
`register-server.ts`, `edit-server.ts`, `connect-and-discover.ts`, `trust-fingerprint.ts`, `delete-server.ts`),
so there is no active leak today — but the guard's own stated purpose ("the structural guarantee behind AUTH-04's
'sin incluir el password'") is undermined by a denylist that doesn't cover a sibling secret field with the exact
same shape as the ones it does cover. A future caller passing `metadata: { passphrase: someRawString }` would
sail through undetected (only the `SecretValue`-instance check, not the key-name check, would still catch it if
the value happens to be wrapped — but a raw string passphrase would not be).
**Fix:** Add `passphrase` to `FORBIDDEN_METADATA_KEYS` (and consider `apikey`/`clientsecret`/`accesstoken` as
forward-looking coverage for phase 5's AI provider keys), or invert the design to an allowlist of known-safe
metadata shapes per action, which is more future-proof than an ever-growing denylist.

### WR-03: Raw secret material travels as plain `string` from the service boundary into `credential-store.ts`

**File:** `apps/control-plane/src/services/credential-store.ts:29-31`, `apps/control-plane/src/services/register-server.ts:27-34`, `apps/control-plane/src/services/edit-server.ts:37-45`
**Issue:** `CredentialInput` (and therefore `RegisterServerInput.credential` / `EditServerInput.credential`)
types `password`, `privateKey` and `passphrase` as plain `string`, not `SecretValue`. Between the moment a
caller constructs a `RegisterServerInput`/`EditServerInput` and the moment `encodeCredential` finally wraps the
private-key branch in `secretValue(...)` for `loadPrivateKey`'s validation, the plaintext exists as an ordinary,
un-branded string that would `console.log`/`JSON.stringify` in the clear if any code anywhere on that path
(request logging, an error handler, a debug statement added later) touched the whole input object. This is
exactly the failure mode `noodara-security`'s checklist item #1 ("¿Algún secret viaja como string fuera del
módulo de cifrado?") is written to catch — `credential-store.ts` is "the módulo de cifrado" per its own header
comment, and the raw secret is a bare string in `register-server.ts`/`edit-server.ts`, both outside that module,
before it ever reaches it. No active leak was found in the reviewed code (nothing logs the full input objects
today), so this is a hardening gap rather than a proven leak.
**Fix:** Have the phase 4 HTTP layer (or these services themselves) wrap incoming credential fields in
`secretValue(...)` immediately at the boundary, and change `CredentialInput` to carry `SecretValue` fields,
unwrapping only at the point `encodeCredential` needs the raw bytes to encrypt.

### WR-04: `resolveServerServicesDeps`'s default `SshPort` is not cached like its other singleton defaults

**File:** `apps/control-plane/src/services/server-service-deps.ts:53-68`
**Issue:** `redactor` defaults to the module-level `appRedactor` singleton and `db` is only resolved via the
(presumably cached) `getDb()`, but `ssh` defaults to a brand-new `createSsh2Adapter()` on every call with no
memoization. `packages/ssh/src/index.ts`'s own header comment describes the adapter as owning "the per-target
connection mutex" among its internals — a concurrency guard that only does anything useful if the same adapter
instance is reused across calls for the same server. If a future caller (phase 4's routes, a background worker)
calls `resolveServerServicesDeps()` once per request instead of once at boot and reusing the result, every
request gets a fresh adapter with a fresh (empty) mutex map, silently defeating whatever protection that mutex
is meant to provide against two concurrent SSH sessions to the same target.
**Fix:** Either memoize a single default `SshPort` instance at module scope (mirroring `appRedactor`), or
document loudly on `ServerServicesDeps`/`resolveServerServicesDeps` that callers MUST resolve deps once and
reuse the same instance for the lifetime of the process, and add a boundary test enforcing that phase 4 does so
(mirroring this phase's own `activity/boundary.test.ts` pattern).

### WR-05: CI workflow has no explicit least-privilege `permissions:` block

**File:** `.github/workflows/ci.yml:1-237`
**Issue:** None of the jobs (including the ones that run on `pull_request`, potentially from external
contributors once this repo is public per its own "PaaS open-source" positioning in `CLAUDE.md`) declare a
`permissions:` block at the workflow or job level. `GITHUB_TOKEN`'s effective scope therefore falls back to
whatever the repository/organization default is, which is easy to widen by accident later and does not visibly
communicate the intended minimum scope (this workflow only needs `contents: read`; nothing here pushes tags,
comments on PRs, or writes releases, aside from the third-party `gitleaks-action` step which may need more).
**Fix:** Add `permissions: contents: read` at the top level of `ci.yml`, and elevate only the specific job/step
that needs more (e.g. the `gitleaks-action` step, if it writes PR check annotations) with a scoped `permissions:`
override on that job.

## Info

### IN-01: Fixture seeds an activity event with an action outside the domain's `ActivityAction` union

**File:** `tests/integration/fixtures/representative-data.ts:145-157`
**Issue:** `seedRepresentativeData` inserts an `activity_events` row with `action: 'server.connect'`, which is
not a member of `AUTH_ACTIONS` or `SERVER_ACTIONS` (the real action is `server.connection_attempted`). This
succeeds silently because the raw insert bypasses `buildActivityEvent` entirely and the `action` column is
plain `text`, not a DB enum — so it's harmless to the migration tests it supports, but it's misleading
"representative" data that doesn't reflect what the real domain ever writes.
**Fix:** Use one of the real `SERVER_ACTIONS`/`AUTH_ACTIONS` values (e.g. `'server.connection_attempted'`) so
the fixture stays a faithful stand-in for production data.

### IN-02: Duplicate test coverage for "runDiscovery never calls session.close()"

**File:** `packages/ssh/src/run-discovery.test.ts:100-113`, `:286-297`
**Issue:** `'opens no second connection and never calls close() itself'` and `'never calls session.close()'`
both assert the exact same thing (`closeCalls === 0`) against the exact same successful-run fixture, with no
distinguishing setup between them.
**Fix:** Fold the `closeCalls` assertion into one of the two tests and let the other focus solely on its own
distinct claim (e.g. `execCalls.length > 0`).

### IN-03: `classifyDiscoveryOutcome`'s `transition()` calls are validation-only, return value discarded

**File:** `apps/control-plane/src/services/connect-and-discover.ts:194-200`
**Issue:** `transition('CONNECTED', 'ERROR')` and `transition('CONNECTED', 'UNREACHABLE')` are called purely to
throw if the edge were ever invalid; the returned status is discarded and a literal is returned instead. This is
explained in the surrounding comment and is intentional, but reads as dead code on first pass and would trip an
`eslint no-unused-expressions`-style rule if one is ever added to this package.
**Fix:** No functional change needed; consider renaming to something like `assertTransitionAllowed(...)` (a
thin wrapper) at the call site so the intent is unambiguous without needing the comment.

---

_Reviewed: 2026-09-16T21:22:01Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
