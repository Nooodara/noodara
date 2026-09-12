---
gsd_state_version: 1.0
milestone: v0.1
milestone_name: milestone
status: executing
stopped_at: Completed 01-13-PLAN.md
last_updated: "2026-09-12T01:16:43.897Z"
last_activity: 2026-09-12
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 15
  completed_plans: 13
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-10)

**Core value:** Noodara puede conocer, registrar y comunicarse con infraestructura real de forma segura y consistente: sin fugas de credenciales, sin estados falsos, sin caídas por fallos del servidor remoto.
**Current focus:** Phase 1 — Dominio, persistencia y autenticación

## Current Position

Phase: 1 (Dominio, persistencia y autenticación) — EXECUTING
Plan: 14 of 15
Status: Ready to execute
Last activity: 2026-09-12

Progress: [█████████░] 87%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: - min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
| Phase 1 P01 | 13min | 1 tasks | 2 files |
| Phase 01 P02 | 14min | 3 tasks | 31 files |
| Phase 01 P03 | 38min | 3 tasks | 16 files |
| Phase 01 P04 | 14min | 2 tasks | 5 files |
| Phase 01 P05 | 28min | 2 tasks | 6 files |
| Phase 01 P06 | 40min | 2 tasks | 9 files |
| Phase 01 P07 | 65min | 3 tasks | 23 files |
| Phase 01 P08 | 21min | 2 tasks | 4 files |
| Phase 01 P09 | 41min | 2 tasks | 8 files |
| Phase 01 P10 | 70min | 2 tasks | 20 files |
| Phase 01 P11 | 100min | 2 tasks | 6 files |
| Phase 01 P12 | 68min | 2 tasks | 18 files |
| Phase 01-dominio-persistencia-y-autenticacion P13 | 60min | 2 tasks | 15 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: v0.1 Foundation se ejecuta en capas horizontales (dominio → SSH → servicios de aplicación → HTTP/worker/SSE → UI → instalador), siguiendo el build order de research/ARCHITECTURE.md para de-riesgar el adaptador SSH temprano.
- [Roadmap]: El instalador (INST-01..05) se planifica último a propósito, para reflejar env vars/healthchecks/entrypoints reales en vez de una suposición.
- [Phase 1]: vitest, commander y @fastify/type-provider-zod verificados via scripts/check-package-provenance.mjs: repository.url normaliza al owner/repo esperado, confirmando los falsos positivos de slopcheck y la asuncion A1 de 01-RESEARCH.md
- [Phase 01]: typescript-eslint pinned to 8.70.0 instead of the planned 10.x: version 10 is not yet published on npm; verified its peer range still satisfies typescript@6.0.3 and eslint@9
- [Phase 01]: Turborepo boundaries tags live in a package-level turbo.json file, not a package.json turbo.tags field as the plan stated; implemented the functional turbo.json tag plus a redundant package.json field
- [Phase 01]: packages/domain's Turborepo boundaries allow-list permits @noodara/config by name (shared tsconfig only) alongside the pure-domain tag; every other workspace package/app remains denied
- [Phase 01]: Pinned @fastify/type-provider-zod (official fastify-org scope, v1.0.0) over the unscoped fastify-type-provider-zod (v7.0.0, turkerdev): identical exported surface, both require Zod >=4.2 (see docs/adr/0001-fastify-zod-type-provider.md)
- [Phase 01]: apps/control-plane/src/env.ts is hand-rolled validation instead of the Zod-schema sketch in RESEARCH.md: the D-04 admin-pair cross-field rule and never-echo-received-value requirement were simpler to guarantee correctly with plain functions than with Zod's error-customization API
- [Phase 01]: Server state machine (SERV-05): frozen TRANSITIONS table with satisfies for literal narrowing; D-13/D-14/D-15 reason-gated edges enforced via a separate Partial<Record> checked after canTransition
- [Phase 01]: applyConnectionResult only accepts a result while status is CONNECTING via an explicit guard, since CONNECTED->ERROR is a generally valid edge but not a valid landing point for a stray connection result
- [Phase 01]: Domain functions needing wall-clock time (applyConnectionResult) take now: Date as an explicit parameter instead of calling Date.now(), keeping packages/domain pure
- [Phase 01]: SecretValue implemented as a class with a true private field (#raw), not a branded primitive string — a primitive cannot carry custom toString/toJSON/util.inspect.custom overrides needed to close all three leak paths
- [Phase 01]: revealSecret(secret, registry?) uses a narrow structural SecretRegistry interface instead of importing Redactor directly, keeping createRedactor() a genuine per-call factory with no singleton coupling
- [Phase 01]: envelope.ts's parseBlob validates segment count, v<n> prefix, base64 shape and decoded nonce/tag byte lengths before any crypto call, raising MalformedBlobError; any GCM auth failure (tamper or wrong key) is caught once and rethrown uniformly as SecretTamperError by design
- [Phase 01]: Adopted a generic assertDefined<T>(value: T | undefined): T cast-helper (matching apps/control-plane/src/env.ts precedent) to narrow already-guaranteed-defined values without tripping either of two mutually-exclusive typescript-eslint rules banning 'as ConcreteType' and non-null assertions, and without leaving a dead branch that fails the 95% branch-coverage gate
- [Phase 01]: Domain validators (SERV-05, AUTH-02): shared ValidationResult<T> in network.ts reused by identity.ts/password.ts; validateHost branches explicitly on shell-metacharacter/scheme/whitespace, IPv6, IPv4, host:port, then RFC1123 label rules (no catch-all regex), since node:net is banned in packages/domain
- [Phase 01]: Password policy (AUTH-02): 12-128 char bound, no composition rule, identifier-equality check, 270-entry offline common-password denylist kept in its own data file to keep policy-logic branch coverage clean
- [Phase 01]: ActivityEvent (AUTH-04): buildActivityEvent recursively rejects metadata with a forbidden key (password/secret/token/credential/privateKey/sshPassword/masterKey, case-insensitive, nested through objects/arrays) or a SecretValue instance via SensitiveMetadataError; occurredAt always caller-supplied, never a platform wall-clock read
- [Phase 01]: setup_tokens' anti-race unique index is WHERE used_at IS NULL, not '...and unexpired' -- Postgres partial-index predicates must be IMMUTABLE and now() is only STABLE — Expiry is still checked at redemption time in the application layer (Plan 01-12); the index guarantees at most one live, un-redeemed token per purpose at the DB level
- [Phase 01]: db:migrate runs via tsx src/db/migrate.ts, not raw node --experimental-strip-types — Confirmed Node 24's native type-stripping does not remap .js specifiers to sibling .ts files (the nodenext convention this codebase uses everywhere); tsx is the same tool Drizzle's own docs recommend
- [Phase 01]: env.ts is imported lazily inside migrate.ts's main() and client.ts's getDb(), never at module top level — A static top-level import made merely importing runMigrations/createDb (as the Testcontainers harness does) trigger INST-06's fail-fast env validation and process.exit(1) before any test could run
- [Phase 01]: applyMigrationsUpTo manually writes the drizzle.__drizzle_migrations bookkeeping row (matching drizzle-orm's own hash/created_at shape) rather than only executing raw SQL, since drizzle's real migrate() decides what remains to apply solely by comparing each migration's journal 'when' against the most recent bookkeeping row's created_at
- [Phase 01]: drizzle-orm promoted to a root devDependency (previously only apps/control-plane) because pnpm's isolated node_modules never symlinks a workspace dependency up to the root, and tests/integration/db files need to import sql/eq directly
- [Phase 01]: representative-data.ts seeds all nine previous-snapshot tables including verifications, not just the eight named by example in 01-08-PLAN.md, since the plan's governing clause is 'every table that exists at the previous-snapshot point'
- [Phase 01]: writeActivityEvent.ts is the single insert path into activity_events (ARCHITECTURE.md sec 6); handle is typed as the shared drizzle-orm/pg-core PgDatabase<NodePgQueryResultHKT, typeof schema> base class so it composes into a caller's transaction without special-casing
- [Phase 01]: toLogSafe recognises a credentials row structurally (encryptedValue+keyVersion+type present) rather than importing the Drizzle table type, allowlisting it to {id, type, keyVersion}; every other entity is denylisted (credentialId, forbidden key names, SecretValue instances)
- [Phase 01]: The canary test's HTTP-error channel wires app.setErrorHandler with appRedactor.redact(error.message) onto the test's own Fastify instance rather than modifying apps/control-plane/src/app.ts (fixed since Plan 01-03), proving the pattern phase 3/4's real routes must follow
- [Phase 01]: @noodara/domain promoted to a root devDependency (same pnpm workspace-symlink fix Plan 01-08 applied for drizzle-orm) so root-level tests/integration files can import its subpath exports directly
- [Phase 01]: auth.ts: drizzleAdapter needs an explicit plural-to-singular schema remap (usePlural does not cover this); validateSchema:false since accounts is deliberately email/password-only
- [Phase 01]: routes/auth.ts bridges Fastify's already-parsed body onto request.raw before calling toNodeHandler, since Fastify keeps parsed output on the FastifyRequest wrapper, not on request.raw
- [Phase 01]: session-policy.ts's config carries a 30-day additionalFields.absoluteExpiresAt default (hooks stays empty) so the NOT NULL sessions.absolute_expires_at column is populated until Plan 01-11's real D-05 clamp
- [Phase 01]: expiresIn/updateAge map directly to D-05's 7-day sliding window; the 30-day ceiling is a separate absolute_expires_at column clamped on every refresh, not a second expiresIn/updateAge pair
- [Phase 01]: session-service.ts queries the sessions table directly instead of auth.api.listSessions/revokeSession/revokeOtherSessions, since Better Auth's own revoke silently no-ops for a session it doesn't own and its listSessions output strips lastSeenAt
- [Phase 01]: redeemSetupToken accepts non-atomic cross-pool user creation (Better Auth's own pool) rather than editing auth.ts; pg_advisory_xact_lock is server-side/database-scoped so the exactly-one-admin race guarantee still holds. — auth.ts and app.ts must not be touched by any plan since 01-10; the advisory lock's correctness does not depend on which connection pool acquires it.
- [Phase 01]: signup-gate.ts returns 404 (not 403) unconditionally for /sign-up/email outside the bootstrap window, matching D-02's stance that the route's existence is never confirmed to an unauthenticated caller.
- [Phase 01]: AUTH-01's single-admin invariant makes a second real sign-up unreachable through any public path; session-management.test.ts's not-my-session test now inserts its second user row directly via Drizzle instead of through /sign-up/email.
- [Phase 01]: Reject a locked-out login by throwing a TOO_MANY_REQUESTS APIError from the before-hook, since better-call's dispatch pipeline cannot carry a non-200 status out of a before-hook's returned value
- [Phase 01]: The per-IP scope key is bridged through an x-noodara-client-ip request header set server-side in routes/auth.ts from Fastify's own request.ip, since the reconstructed Fetch Request a Better Auth hook receives has no socket-level IP of its own
- [Phase 01]: login_attempts gained a lockout_count column (migration 0001) to persist D-07's doubling schedule across lockouts, since deriving it from existing columns (locked_until/last_failure_at) is unrecoverable once a later window starts overwriting last_failure_at

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

- REQUIREMENTS.md traceability footer indicaba "40 total" pero el conteo real de IDs únicos en el documento es 42; corregido durante la creación del roadmap (ver traceability actualizada).
- Dos decisiones de stack siguen abiertas por el usuario según research/SUMMARY.md: auth (Better Auth vs. hand-rolled) y framework web (Next.js vs. TanStack Start) — PROJECT.md ya registra Better Auth y Next.js 16 como decisión tomada; confirmar que sigue vigente al planificar Phase 1 y Phase 5.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none — primer milestone)* | | | |

## Session Continuity

Last session: 2026-09-12T01:16:43.891Z
Stopped at: Completed 01-13-PLAN.md
Resume file: None
