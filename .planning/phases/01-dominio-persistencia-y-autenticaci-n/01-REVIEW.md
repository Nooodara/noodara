---
phase: 01-dominio-persistencia-y-autenticacion
reviewed: 2026-09-12T04:00:58Z
depth: standard
files_reviewed: 68
files_reviewed_list:
  - apps/control-plane/src/activity/index.ts
  - apps/control-plane/src/activity/redaction.ts
  - apps/control-plane/src/activity/write-activity-event.ts
  - apps/control-plane/src/activity/write-activity-event.test.ts
  - apps/control-plane/src/app.ts
  - apps/control-plane/src/auth/auth.ts
  - apps/control-plane/src/auth/bootstrap-context.ts
  - apps/control-plane/src/auth/hooks.ts
  - apps/control-plane/src/auth/login-guard.ts
  - apps/control-plane/src/auth/password-hasher.ts
  - apps/control-plane/src/auth/password-hasher.test.ts
  - apps/control-plane/src/auth/session-policy.ts
  - apps/control-plane/src/auth/signup-gate.ts
  - apps/control-plane/src/boot/bootstrap-admin.ts
  - apps/control-plane/src/boot/bootstrap-admin.test.ts
  - apps/control-plane/src/boot/master-key.ts
  - apps/control-plane/src/cli/admin-reset.ts
  - apps/control-plane/src/cli/index.ts
  - apps/control-plane/src/cli/secrets-rotate.ts
  - apps/control-plane/src/db/client.ts
  - apps/control-plane/src/db/migrate.ts
  - apps/control-plane/src/db/migrations/0000_shiny_franklin_storm.sql
  - apps/control-plane/src/db/migrations/0001_silky_lethal_legion.sql
  - apps/control-plane/src/db/schema/activity-events.ts
  - apps/control-plane/src/db/schema/auth.ts
  - apps/control-plane/src/db/schema/credentials.ts
  - apps/control-plane/src/db/schema/index.ts
  - apps/control-plane/src/db/schema/login-attempts.ts
  - apps/control-plane/src/db/schema/servers.ts
  - apps/control-plane/src/db/schema/setup-tokens.ts
  - apps/control-plane/src/env.ts
  - apps/control-plane/src/env.test.ts
  - apps/control-plane/src/logger.ts
  - apps/control-plane/src/logger.test.ts
  - apps/control-plane/src/routes/auth.ts
  - apps/control-plane/src/routes/health.ts
  - apps/control-plane/src/routes/sessions.ts
  - apps/control-plane/src/routes/setup.ts
  - apps/control-plane/src/server.ts
  - apps/control-plane/src/services/login-attempt-repository.ts
  - apps/control-plane/src/services/session-service.ts
  - apps/control-plane/src/services/setup-service.ts
  - apps/control-plane/src/services/setup-token-repository.ts
  - packages/domain/src/activity/activity-event.ts
  - packages/domain/src/index.ts
  - packages/domain/src/security/envelope.ts
  - packages/domain/src/security/index.ts
  - packages/domain/src/security/login-backoff.ts
  - packages/domain/src/security/redactor.ts
  - packages/domain/src/security/redactor.test.ts
  - packages/domain/src/security/secret-value.ts
  - packages/domain/src/security/setup-token.ts
  - packages/domain/src/server/connection-result.ts
  - packages/domain/src/server/index.ts
  - packages/domain/src/server/server-state.ts
  - packages/domain/src/validators/common-passwords.ts
  - packages/domain/src/validators/identity.ts
  - packages/domain/src/validators/index.ts
  - packages/domain/src/validators/network.ts
  - packages/domain/src/validators/password.ts
  - .github/workflows/ci.yml
  - scripts/check-package-provenance.mjs
  - tests/integration/helpers/app.ts
  - tests/integration/helpers/postgres.ts
  - tests/integration/helpers/migrations.ts
  - tests/integration/fixtures/representative-data.ts
  - tests/integration/auth/rate-limit.test.ts
  - tests/integration/auth/login.test.ts
findings:
  critical: 0
  warning: 4
  info: 2
  total: 6
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-09-12T04:00:58Z
**Depth:** standard
**Files Reviewed:** 68
**Status:** issues_found

## Summary

Reviewed the domain/persistence/auth phase (auth wiring, login-lockout guard, setup/recovery
tokens, session policy, boot bootstrap, CLI secrets-rotate/admin-reset, schema/migrations, and the
`packages/domain` security/validator primitives) at standard depth, with extra scrutiny on the six
areas called out in the review brief.

None of those six areas turned up a provable BLOCKER. Specifically verified, with evidence:

- **`x-noodara-client-ip` header bridge** (`routes/auth.ts:40`): the header is unconditionally
  overwritten server-side from Fastify's own `request.ip` right before the request reaches
  Better Auth's handler, so a client-supplied value of the same header can never survive — Node's
  `IncomingMessage.headers` are already lowercased, so the assignment always replaces any
  attacker-supplied value. `login-guard.ts` never reads a raw forwarded-for header itself. Cross-
  checked against `NOODARA_TRUST_PROXY`'s own test coverage (`rate-limit.test.ts`, last two cases).
- **HMAC-derived setup token** (`boot/bootstrap-admin.ts`): never logged in derived (only
  `revealSecret`'d and written to stdout, matching the setup CLI's own contract); single-use is
  enforced by `usedAt`/the partial unique index; 24h TTL enforced via `isTokenUsable`. One
  cryptographic-hygiene concern below (WR-01).
- **`validateSchema: false` / `Object.assign(request.raw, { body })` bridge**: consistent with the
  documented rationale (Fastify already consumed the raw stream; Better Auth's Node adapter needs
  `.body` on the same object it receives) and does not introduce a body-smuggling path — Fastify's
  own schema validation already ran against `request.body` before this handler is reached.
- **Login lockout math** (`login-backoff.ts`, `login-guard.ts`, `login-attempt-repository.ts`):
  traced the exact boundary (5th failure triggers lockout, not the 6th), the doubling schedule
  (900s → 1800s → ... capped at 86400s), independent IP/account scoping, and — by reading the
  installed `better-call`/`better-auth` dispatch source directly
  (`node_modules/.../better-auth/dist/api/dispatch.mjs`) — confirmed that the counter increment in
  `loginGuardAfter` can only ever observe either a genuine success or an `APIError` in
  `ctx.context.returned`: any other thrown exception from the sign-in handler bypasses
  `runAfterHooks` entirely (rethrown before `context.returned` is ever set), so there is no path
  where an unrelated system error gets misrecorded as `auth.login_succeeded` or silently clears a
  lockout. This resolved an initial suspicion in this reviewer's own adversarial pass.
- **`secrets-rotate.ts`**: transactional (one `db.transaction`, no partial commit), never echoes
  the underlying error (generic message on any failure), and the "already rotated" idempotent
  re-run path is not a security bypass — it's a benign optimization that still fails loudly (whole
  transaction aborts) if a genuinely corrupt row is encountered during the real rotation pass.
- **`.default(` on security-critical env vars**: `env.ts`'s own header comment states no
  `.default()`/`??`/`||` for `NOODARA_MASTER_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`,
  `REDIS_URL`, `NOODARA_PUBLIC_URL` — verified true by reading the full parse function; only
  session/login/cookie/trust-proxy tuning knobs default.

What remains are four warnings (crypto/config hygiene, a redaction-pattern gap, and one piece of
dead security-relevant code) and two minor code-quality notes. Nothing here blocks the phase, but
WR-03 in particular should be fixed before this redaction module is relied on for a real
`postgresql://`-style `DATABASE_URL`.

## Warnings

### WR-01: HMAC key reuse — the same `BETTER_AUTH_SECRET` signs both sessions and setup tokens with no domain separation

**File:** `apps/control-plane/src/boot/bootstrap-admin.ts:72-75`
**Issue:** `deriveSetupTokenValue` computes `HMAC-SHA256(BETTER_AUTH_SECRET, rowId)` to make the
setup token deterministically reprintable. `BETTER_AUTH_SECRET` is simultaneously handed to
Better Auth itself (`auth.ts:28`, `secret: env.BETTER_AUTH_SECRET`) for its own internal signing
(session/cookie signing, CSRF-style internal tokens). Using one secret as the key for two
unrelated HMAC constructions, with no domain-separation prefix/label in the message, is a
recognized crypto-hygiene anti-pattern (cross-protocol attacks become a real concern if either
consuming library's internal construction ever becomes attacker-influenced or if a future plan
adds a third HMAC use of the same secret). Today neither side is directly attacker-controlled, so
this is not an active exploit, but it is exactly the kind of key-reuse the project's own security
skill (§1, §2) asks reviewers to catch before it compounds.
**Fix:** Derive a dedicated sub-key via HKDF (or a second `createHmac` pass with a fixed label) instead of reusing the raw secret directly, e.g.:
```ts
const SETUP_TOKEN_HMAC_KEY_LABEL = 'noodara:setup-token:v1';
function deriveSetupTokenValue(rowId: string, secret: string): SecretValue {
  const subKey = createHmac('sha256', secret).update(SETUP_TOKEN_HMAC_KEY_LABEL).digest();
  const raw = createHmac('sha256', subKey).update(rowId).digest('base64url');
  return secretValue(raw, 'setup_token');
}
```

### WR-02: `NOODARA_TRUST_PROXY` is boolean-only — trusts every hop unconditionally when enabled

**File:** `apps/control-plane/src/env.ts:37` (flag), `apps/control-plane/src/app.ts:23` (`trustProxy: env.NOODARA_TRUST_PROXY`)
**Issue:** The per-IP login-lockout scope (`login-guard.ts`) depends entirely on Fastify's
`request.ip` being trustworthy when `NOODARA_TRUST_PROXY=true`. Fastify's `trustProxy: true`
(via `proxy-addr`) trusts *any* `X-Forwarded-For` value from *any* direct connection, not just
from a specific reverse-proxy IP/CIDR. If the control plane is ever reachable directly (bypassing
the intended reverse proxy) while this flag is on — a plausible misconfiguration in a
container/compose setup — any external client can set an arbitrary `X-Forwarded-For` and pick its
own per-IP lockout scope, defeating D-07's per-IP defense entirely (the per-account scope still
holds, so this is a defense-in-depth gap, not a full bypass).
**Fix:** Accept a specific trusted-proxy address/CIDR (or list) instead of a bare boolean, and pass that value through to Fastify's `trustProxy` option (which accepts a string/array/function, not just boolean) so only the known reverse-proxy hop is trusted.

### WR-03: Structural secret-redaction pattern misses the `postgresql://` URL scheme

**File:** `packages/domain/src/security/redactor.ts:35`
**Issue:** `POSTGRES_URL_PASSWORD_PATTERN = /(postgres:\/\/[^:@/\s]+:)[^@/\s]+@/g` only matches the
`postgres://` scheme. `DATABASE_URL` values using the equally valid `postgresql://` scheme (accepted
by both `new URL()` in `env.ts`'s own `validateDatabaseUrl` and by the `pg` driver) are not caught by
this structural backstop. `redactor.test.ts:53-58` only asserts the `postgres://` form, so this gap
has zero test coverage. This is exactly the pattern the project's own `noodara-security` skill (§3)
requires ("`postgres://user:pass@`") — the current implementation silently narrows that requirement.
**Fix:**
```ts
const POSTGRES_URL_PASSWORD_PATTERN = /(postgres(?:ql)?:\/\/[^:@/\s]+:)[^@/\s]+@/g;
```
Add a `redactor.test.ts` case asserting the same redaction for a `postgresql://` URL.

### WR-04: `verifyTokenHash` is a fully-implemented, tested, constant-time comparator that is never called by any production code path

**File:** `packages/domain/src/security/setup-token.ts:49-56`
**Issue:** The actual setup/recovery token redemption path
(`setup-token-repository.ts:findUsableByHash`) looks up a token by exact-equality `WHERE
token_hash = ?` through Drizzle/Postgres, never by calling `verifyTokenHash`. `verifyTokenHash`
itself is exported from `@noodara/domain/security`, fully unit-tested
(`setup-token.test.ts:76-96`), and grep-confirmed to have zero callers anywhere in
`apps/control-plane`. In isolation the DB-index lookup is an acceptable design (the compared
values are high-entropy SHA-256 digests of 256-bit random tokens, not low-entropy secrets, so a
B-tree equality scan's early-exit timing does not meaningfully leak exploitable information about
the underlying token) — but the presence of an unused, purpose-built constant-time comparator
strongly suggests an intended defense-in-depth layer that was built and never wired in, which is
worth resolving explicitly one way or the other rather than leaving as silent dead code.
**Fix:** Either delete `verifyTokenHash` (and its test) as intentionally-unneeded, or use it as an additional post-lookup assertion in `setup-service.ts`'s `redeemSetupToken`/`redeemRecoveryToken` before trusting `findUsableByHash`'s result, and document why.

## Info

### IN-01: `clearOnSuccess` is exported and tested but has no production caller

**File:** `packages/domain/src/security/login-backoff.ts:100-102`
**Issue:** `login-guard.ts:191-198` explicitly documents why it deletes rows instead of calling
`clearOnSuccess` (deleting achieves the identical "fresh counter" state more cheaply), so this is a
deliberate, documented choice rather than an oversight — but it still leaves a public, tested
domain function with zero real callers, which is dead surface area for a `packages/domain` module
that is supposed to be the single source of truth other services call into.
**Fix:** Either remove `clearOnSuccess` (and its describe block in `login-backoff.test.ts`) or have `login-attempt-repository.ts` route through it (e.g. an `upsertState` write of `clearOnSuccess(state)` instead of a hand-rolled delete) so the domain function is the actual mechanism, not just a parallel spec of one.

### IN-02: `assertDefined`/`assertFound` narrowing helper is copy-pasted across three modules

**File:** `packages/domain/src/security/envelope.ts:96-98`, `packages/domain/src/validators/network.ts:35-37`, `packages/domain/src/security/redactor.ts:53-55`
**Issue:** The same one-line "cast `T | undefined` to `T` after the caller already checked" helper
is independently reimplemented three times (`assertDefined` twice, `assertFound` once) with
near-identical doc comments cross-referencing each other. Harmless today, but any future change to
this narrowing idiom (e.g. adding a runtime assertion for extra safety) would need to be applied
in three places and could easily drift.
**Fix:** Extract one shared `assertPresent<T>(value: T | undefined): T` helper into a small internal util module within `packages/domain` (still zero-I/O, so it doesn't violate the purity boundary) and import it from all three call sites.

---

_Reviewed: 2026-09-12T04:00:58Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
