---
gsd_state_version: 1.0
milestone: v0.1
milestone_name: milestone
status: executing
stopped_at: "Phase 05 (ui-web) gap closure EXECUTED (12/12 plans, 37/37 summaries) + quick task 260920-ly9 (sshUser field error). Re-verification = gaps_found: 7 of the 8 previous gaps closed; gap 6 (host-key trust) was wrongly marked CLOSED by 05-GAP-CLOSURE-AUDIT.md and is still OPEN as a blocker (05-REVIEW.md GR-01/GR-02: trust-fingerprint.ts never checks lastErrorCode; applyConnectionResult never clears pendingFingerprint; edit-server clears hostFingerprint only while CONNECTED). QA-04/QA-05 stay Pending (no git remote). 7 human items pending in 05-HUMAN-UAT.md. Phase 05 is NOT complete. Next: /gsd-plan-phase 5 --gaps"
last_updated: "2026-09-20T21:46:08Z"
last_activity: 2026-09-20
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 85
  completed_plans: 85
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-10)

**Core value:** Noodara puede conocer, registrar y comunicarse con infraestructura real de forma segura y consistente: sin fugas de credenciales, sin estados falsos, sin caídas por fallos del servidor remoto.
**Current focus:** Phase 05 — ui-web

## Current Position

Phase: 05 (ui-web) — gap-closure plans complete (37/37 have a SUMMARY); phase itself NOT yet complete
Plan: 37 of 37 plans have a SUMMARY. 05-37 (the closing gate) executed: all eleven gate commands green on the final tree (unit 1491/1491, integration 505/0/1-skipped, E2E 92/92, boot 7/7, provenance 52/52, leak canaries green); each of the eight 05-VERIFICATION.md gaps re-derived first-hand (4 CLOSED: gaps 1/2/6/7; 1 OPEN by design: gap 3/QA-04/QA-05; 2 PARTIAL: gaps 4/5). At the Task 3 checkpoint the user answered "Approve y haz un gsd quick del sshUser bug" -- the wave is approved to close, but the user did NOT state which of the six human-only verification items (real-display contrast, real CI run, live SSE walkthrough, Sheet/Dialog/RowMenu elevation, screen-reader pass, sub-1280px/reduced-motion feel) they actually checked, so all six are recorded as pendiente -- no confirmado por el usuario in .planning/phases/05-ui-web/05-GAP-CLOSURE-AUDIT.md section 3, not silently marked passed. A new bug (ServerSheet.tsx's SSH user Field has no error prop, silently swallowing a server-side sshUser validation error) was found live during re-derivation and, per the user's instruction, is being fixed via a separate /gsd-quick task run by the orchestrator right after this plan -- not inside this plan.
Status: Gap closure executed and re-verified = gaps_found (1 blocker: host-key trust not enforced in the backend, GR-01/GR-02). Phase NOT complete. Final-tree evidence: unit 1497/1497, E2E 93/93, integration 505 passed / 0 failed / 1 skipped (at 3546a6d, no backend change since), boot 7/7, leak canaries green. QA-04/QA-05 Pending until a real CI + nightly run is observed. Next: /gsd-plan-phase 5 --gaps.
Last activity: 2026-09-20 -- Phase 05 re-verified (gaps_found) after gap closure + quick task 260920-ly9

Progress: [██████████] 100% of planned plans executed (phase 05 not yet verified complete)

## Performance Metrics

**Velocity:**

- Total plans completed: 48
- Average duration: - min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 17 | - | - |
| 2 | 10 | - | - |
| 03 | 10 | - | - |
| 04 | 11 | - | - |

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
| Phase 01 P14 | 34min | 3 tasks | 13 files |
| Phase 01 P15 | 45min | 2 tasks | 4 files |
| Phase 01 P16 | 38min | 3 tasks | 13 files |
| Phase 01 P17 | 22min | 2 tasks | 5 files |
| Phase 02 P01 | 55min | 4 tasks | 23 files |
| Phase 02 P02 | 65min | 3 tasks | 8 files |
| Phase 02-adaptador-ssh-aislado-y-probado-con-testcontainers P03 | 55min | 3 tasks | 9 files |
| Phase 02 P04 | 170min | 3 tasks | 8 files |
| Phase 02 P05 | 55min | 3 tasks | 14 files |
| Phase 02 P06 | 60min | 2 tasks | 7 files |
| Phase 02 P07 | 25min | 2 tasks | 5 files |
| Phase 02 P08 | 95min | 2 tasks | 6 files |
| Phase 02 P09 | 55min | 2 tasks | 5 files |
| Phase 02 P10 | 150min | 3 tasks | 11 files |
| Phase 03 P01 | 24min | 3 tasks | 5 files |
| Phase 03 P02 | 28min | 3 tasks | 8 files |
| Phase 03 P03 | 31min | 2 tasks | 9 files |
| Phase 03 P04 | 42min | 3 tasks | 6 files |
| Phase 03 P05 | 35min | 2 tasks | 3 files |
| Phase 03 P06 | 40min | 2 tasks | 2 files |
| Phase 03 P07 | 25min | 2 tasks | 2 files |
| Phase 03 P08 | 50min | 3 tasks | 2 files |
| Phase 03 P09 | 100min | 3 tasks | 4 files |
| Phase 03 P10 | 65min | 2 tasks | 3 files |
| Phase 04 P01 | 110min | 3 tasks | 14 files |
| Phase 04 P02 | 30min | 3 tasks | 8 files |
| Phase 04 P03 | 50min | 3 tasks | 10 files |
| Phase 04 P04 | 125min | 3 tasks | 14 files |
| Phase 04 P05 | 35min | 2 tasks | 4 files |
| Phase 04 P06 | 90min | 2 tasks | 7 files |
| Phase 04 P07 | 55min | 3 tasks | 15 files |
| Phase 04 P08 | 195min | 3 tasks | 14 files |
| Phase 04 P09 | 100min | 3 tasks | 10 files |
| Phase 04 P10 | 140min | 3 tasks | 16 files |
| Phase 04 P11 | 170min | 3 tasks | 9 files |
| Phase 05 P01 | 22min | 3 tasks | 8 files |
| Phase 05 P02 | 18min | 3 tasks | 5 files |
| Phase 05 P04 | 9min | 3 tasks | 7 files |
| Phase 05 P03 | 6min | 3 tasks | 4 files |
| Phase 05 P05 | 21min | 3 tasks | 11 files |
| Phase 05-ui-web P06 | 15min | 3 tasks | 17 files |
| Phase 05 P22 | 25min | 3 tasks | 11 files |
| Phase 05-ui-web P07 | 35min | 3 tasks | 19 files |
| Phase 05-ui-web P08 | 8min | 3 tasks | 11 files |
| Phase 05 P10 | 55min | 3 tasks | 10 files |
| Phase 05 P23 | 15min | 3 tasks | 11 files |
| Phase 05 P09 | 15min | 3 tasks | 11 files |
| Phase 05 P24 | 25min | 3 tasks | 12 files |
| Phase 05-ui-web P25 | 14min | 3 tasks | 9 files |
| Phase 05 P11 | 35min | 3 tasks | 9 files |
| Phase 05 P12 | 31min | 3 tasks | 13 files |
| Phase 05 P13 | 19min | 3 tasks | 11 files |
| Phase 05-ui-web P14 | 8min | 3 tasks | 9 files |
| Phase 05 P15 | 10min | 3 tasks | 9 files |
| Phase 05 P16 | 5min | 3 tasks | 9 files |
| Phase 05 P17 | 55min | 3 tasks | 15 files |
| Phase 05-ui-web P18 | 55min | 3 tasks | 9 files |
| Phase 05 P19 | 50 | 3 tasks | 13 files |
| Phase 05 P20 | ~3h + debug session (see SUMMARY) | 3 tasks | 27 files |
| Phase 05 P21 | docs-closure | 1 tasks | 9 files |
| Phase 05 P26 | 90min | 3 tasks | 5 files |
| Phase 05 P27 | 50min | 3 tasks | 13 files |
| Phase 05-ui-web P28 | 28min | 3 tasks | 8 files |
| Phase 05-ui-web P30 | 35min | 3 tasks | 6 files |
| Phase 05-ui-web P32 | 55min | 3 tasks | 6 files |
| Phase 05 P34 | 42min | 3 tasks | 7 files |
| Phase 05-ui-web P36 | 35min | 3 tasks | 5 files |
| Phase 05-ui-web P29 | ~30min | 3 tasks | 8 files |
| Phase 05-ui-web P31 | 40min | 3 tasks | 7 files |
| Phase 05-ui-web P35 | 55min | 3 tasks | 7 files |
| Phase 05 P33 | 55min | 1 tasks | 14 files |

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
- [Phase 01]: bootstrap-admin.ts derives the boot-time setup token deterministically (HMAC-SHA256 of the token row's own id, keyed by BETTER_AUTH_SECRET) instead of the shared issueToken()'s random generator, since D-01 requires reprinting the identical token on every boot while only its hash is ever persisted
- [Phase 01]: redeemRecoveryToken lives in setup-service.ts rather than inline in routes/setup.ts, preserving ARCHITECTURE.md's invariant that only application services write activity events
- [Phase 01]: noodara secrets rotate picks its target key_version by probing whether any row already decrypts under the new key at the current max version, not a blind max+1, so a second consecutive run with the same key pair is a safe no-op
- [Phase 01]: commander@15.0.0 adopted for the noodara CLI over citty (docs/adr/0002-cli-library.md); the CLI is spawned via tsx rather than plain node since packages/domain's package.json exports point directly at .ts sources
- [Phase 01]: CI's unit job uses pnpm test --coverage, not pnpm test -- --coverage — the double-dash form silently disables coverage because pnpm forwards it to Vitest as a positional filter
- [Phase 01]: gitleaks allowlist path-scoped to vitest.config.ts, tests/integration/cli/admin-reset.test.ts and packages/domain/src/security/redactor.test.ts (verified against real git history), not the plan's guessed tests/integration/fixtures/ / .env.example
- [Phase 01]: packages/domain gets a real tsc build with exports pointing at dist/*.js+.d.ts; apps/control-plane's dev moves to tsx watch and gains a plain-node start script — Production-path-weighted fix for 01-VERIFICATION.md's BLOCKER (ERR_MODULE_NOT_FOUND under plain node)
- [Phase 01]: turbo.json's dev task requires an explicit passThroughEnv allowlist naming every env.ts variable — Turborepo 2's default strict env mode silently strips undeclared environment variables before spawning a task; the literal root pnpm dev crashed INST-06 fail-fast even with a fully valid environment until this was added
- [Phase 01]: boot-smoke CI job keeps an explicit pnpm build step even though global-setup.ts also builds, so a build failure surfaces as its own red step, not an opaque test-harness crash
- [Phase 01]: ADR 0003 records the tsc-build/tsx-dev/plain-node-start runtime contract as Accepted, closing 01-VERIFICATION.md's BLOCKER for future phases
- [Phase 02]: turbo boundaries allow lists are undirected: pure-domain's own allow list had to add ssh-adapter for ssh->domain to pass, not just the reverse — Verified with the unmodified phase-1 pure-domain rule alone; domain->ssh containment stays guaranteed by purity.test.ts's independent frozen dependency list, unaffected by the tag change
- [Phase 02]: packages/ssh/src/commands/index.ts ships a minimal CommandName stub in Task 3, fully replaced by Task 4's real barrel — Reconciles Task 3's own forward reference to a type Task 4 defines while keeping pnpm build green after every task
- [Phase 02]: Docker CLI test variant uses docker-ce-cli from Docker's own apt repo (never Ubuntu's docker.io), so the WITH_DOCKER_CLI image genuinely ships no daemon binary
- [Phase 02]: startSshd always injects a fresh SSH_TEST_KEY_PASSPHRASE, so every fixture always has an ed25519_locked key appended to root/deployer authorized_keys regardless of scenario
- [Phase 02-adaptador-ssh-aislado-y-probado-con-testcontainers]: parseTuningInt takes an optional {min,max} range object rather than a parallel parser, keeping exactly one integer parser in env.ts
- [Phase 02-adaptador-ssh-aislado-y-probado-con-testcontainers]: The discovery>=command SSH timeout coherence check runs after both values are parsed, reporting against NOODARA_SSH_DISCOVERY_TIMEOUT_MS
- [Phase 02]: TOFU: use utils.parseKey(rawHostVerifierArgument).type to extract the host key algorithm name (measured to work directly against the raw wire-format Buffer)
- [Phase 02]: CONNECT_TIMEOUT: keep the accept-then-silent blackhole listener as the chosen strategy, after fixing a real bug where nc without -e/-k didn't actually blackhole
- [Phase 02]: Mid-exec transport death maps to CONNECTION_LOST via a channel closing with no exit code; ssh2 never raises an 'error' event for this path
- [Phase 02]: D-11: statusForErrorCode('UNSUPPORTED_OS') now returns CONNECTED (was ERROR) — unsupported OS is a warning recorded in last_error_code, not a failure state
- [Phase 02]: Docker CLI/daemon detection returns a four-kind discriminated union (not_installed/daemon_unreachable/installed/unparseable) keyed on the ADR-0004 exit code, never on JSON.parse success alone (D-12)
- [Phase 02]: generateTestKeys() adds a dsa key generated via openssl dsaparam/gendsa (not ssh-keygen -t dsa, which modern OpenSSH refuses) to exercise D-01's DSA-type-rejection path with a genuinely parseable key
- [Phase 02]: key-loader.ts drops a defensive Array.isArray(parsed) branch: @types/ssh2 declares utils.parseKey's return as exactly ParsedKey | Error (never an array), and Array.isArray narrowing against a non-array type widens the ternary to any
- [Phase 02]: createHostVerifier's only accepted input field is trusted; a test asserts Object.keys(input) directly so a future bypass-option addition fails a behavioural test, not just a grep
- [Phase 02]: Added TransportClosedError and UnsupportedOsError markers to packages/ssh/src/errors.ts (beyond the plan's own SshFailure/CommandTimeoutError exports) so ADR 0004's mid-exec-transport-death (ssh2 never raises an 'error' event for it) and D-11's UNSUPPORTED_OS warning are both reachable through classifySshError's single rule table
- [Phase 02]: classifySshError's ClassifyContext.phase only changes the outcome for the socket-reset rule (ECONNRESET/EPIPE -> CONNECTION_LOST regardless of connect/exec); every other rule's code does not depend on phase, since ADR 0004 measurements did not support inventing further phase-based distinctions
- [Phase 02]: execWithTimeout's client/channel parameters are narrow structural interfaces (exec/on/destroy only), never ssh2's concrete Client/ClientChannel types, so its fake-timer/fake-channel unit tests exercise real timer/stream mechanics honestly rather than mocking ssh2 itself
- [Phase 02]: Private-key credential validation failures (loadPrivateKey's validation and auth kinds) both land on ConnectOutcome's AUTH_FAILED, the closest of the seven ServerErrorCodes to an unusable credential
- [Phase 02]: Ssh2Adapter's connect-phase error/close listener pair is attached once, before connect(), and shared via a mutable SessionState with the post-ready session, so no second listener pair is ever registered for the same client
- [Phase 02]: Mutex on the outside, retry on the inside in Ssh2Adapter.connect — both attempts of a D-10 retried connect share one per-target createConnectionMutex slot
- [Phase ?]: daemon_unreachable's docker_version check reports pass (command+parse both succeeded), matching runDiscovery's pass criterion everywhere else
- [Phase ?]: commandFor stays part of @noodara/ssh's public surface because tests/integration/ssh/contracts.test.ts (plan 02-04) already depends on it through the package's single export entry
- [Phase ?]: D-08's discovery-total budget is checked once per loop iteration against an injected clock, never by racing session.exec() itself
- [Phase 02]: tests/integration/ssh/tsconfig.json (+ @types/node promoted to a root devDependency, + pnpm typecheck extended with a tsc -p invocation) added because no tsc project anywhere in the repo covered tests/integration/** — the SEC-04 @ts-expect-error assertion in connect.test.ts needed a real static check behind it, not just a comment
- [Phase 02]: The SERV-08 access-check matrix test connects to a dockerCli:true fixture, not the plain image, so the 'other nine checks still pass' assertion is genuinely about sudo/docker_group and not incidentally about Docker being absent
- [Phase 02]: The command-timeout scenario proves 'the timeout destroyed the channel, not the connection' via a second exec on the same session plus a separate fresh connection with a normal budget, since SshTimeouts.commandMs cannot be varied per exec call on one session
- [Phase 02]: The canary password in discovery.test.ts's SEC-05 test is fixture.password itself (already a fresh per-run randomUUID()), not a separately generated value, since a separately generated string cannot authenticate as the account's real password
- [Phase 03]: loadPrivateKey/InvalidCredentialError exported additively from @noodara/ssh's index.ts with zero changes to key-loader.ts itself — keeps the additive-only contract change the plan required (D-15, T-3-10, T-3-15)
- [Phase 03]: D-03 CONNECTED semantics recorded as a new doc section in docs/domain/server-state-transitions.md rather than altering the existing transition tables — no edge changed, only clarifying prose was needed
- [Phase 03]: InvalidActivityActionError message wording changed from 'Unknown auth action' to 'Unknown activity action' now that the guard spans auth.* and server.* namespaces — ACT-01/D-16 widened the action union; no caller depended on the old error text
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: Test assertions for D-10 unique violations check err.cause.code, not err.code, since drizzle-orm 0.45 wraps the raw pg error in DrizzleQueryError
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: discoveryOutcomeEnum is declared fresh in discovery-snapshots.ts rather than derived from packages/domain's SnapshotOutcome, since a TS union has no runtime array to spread into pgEnum
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: MasterKeys declared once in server-service-deps.ts and imported by credential-store.ts rather than redeclared, per D-17's declared-once-and-shared rule
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: credential-store.test.ts hand-assembles an unencrypted OpenSSH ed25519 private-key container in pure JS around node:crypto-generated raw key material (no shell-out); ssh-keygen is shelled out to only for the passphrase-protected variant, whose bcrypt-pbkdf wrapping is infeasible to reproduce by hand
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: SERVER_VIEW_KEYS has 27 entries, not 03-04-PLAN.md's stated 26 -- the plan's own field list already enumerates 26 servers columns before adding credentialType (27 total); must_haves.truths and RESEARCH.md's literal ServerView interface confirm 27 is correct
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: Service integration tests live in tests/integration/services/*.test.ts against real Postgres (never colocated unit tests) since every service in this phase opens db.transaction; registerServer/register-server.test.ts both load each other's env-sensitive dependency graph via a dynamic await import(...), never a static top-level import, since redaction.ts reads env.NOODARA_MASTER_KEY at module load time and env.ts process.exit(1)s on an invalid env
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: editServer runs currentKeyVersion/encodeCredential against the open transaction handle (tx), not deps.db, since this plan's task order places credential encoding inside the single db.transaction (a deliberate departure from registerServer's precedent of computing the key version before opening its transaction)
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: The NAME_TAKEN integration test for editServer uses an exact-duplicate name rather than a case-differing one, since validateServerName rejects uppercase input outright -- the lower() unique index still guards the exact-duplicate collision path
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: deleteServer's success result carries only { ok: true, serverId } instead of a ServerView (D-19 excludes it -- the row no longer exists after commit)
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: deleteServer has no unique-violation catch block unlike registerServer/editServer, since delete has no uniqueness pre-check that could race a 23505
- [Phase 03]: connectAndDiscover accepts an optional discover?: typeof runDiscovery on its own input, defaulting to the real runDiscovery -- scripting runDiscovery's internals through the fake SshSession's exec map was impractical for the D-02 warnings/checks matrix this plan's tests needed
- [Phase 03]: classifyDiscoveryOutcome's D-02 mapping returns a 3-arm discriminated union keyed on status rather than a flat interface, so the discovery_completed activity event's conditional errorCode spread type-checks under exactOptionalPropertyTypes with no as assertion
- [Phase 03-servicios-de-aplicaci-n-activity-log-y-redacci-n]: apps/control-plane/src/activity/boundary.test.ts's PRE_ACT01_EXCEPTIONS individually names three Phase 1 files (boot/bootstrap-admin.ts, auth/login-guard.ts, cli/admin-reset.ts) that call/reference writeActivityEvent directly and predate ACT-01's enforcement -- neither is an HTTP route nor a worker, and moving them into src/services/ is an out-of-scope Phase 1 refactor
- [Phase 03]: The plan's own must_haves text claimed exactly three discovery_snapshots rows for the D-18 full-flow canary, but its own Act sequence only names two successful discovery runs (steps 2 and 6); the test asserts the correct count of two, since connectAndDiscover never inserts a snapshot on an SSH-connect-phase failure
- [Phase 03]: appRedactor's registration is attempt-scoped, not flow-scoped -- @noodara/ssh releases every raw revealed secret the moment a connect attempt's session closes (WR-02), so the D-18 full-flow canary re-registers the password/passphrase canaries immediately before its final simulated-error capture rather than relying on a single up-front registration to survive the whole multi-connect flow
- [Phase 03]: D-18's editServer credential-replacement step also changes sshUser (pwuser -> deployer) in the same call, since the sshd fixture's password-only account never receives an authorized key at all -- this is D-14's access-change transition working as designed, required for the flow to be physically realizable against the real fixture image
- [Phase 04]: ioredis pinned to 5.11.1, never 6.0.0 (RESP3-by-default not yet validated against BullMQ's Lua reply parsing) — RESEARCH Pitfall 2 / Open Question 1
- [Phase 04]: concurrently deliberately not installed; a second Turborepo dev:worker task wires pnpm dev in Plan 04-07 instead — Keeps the zero-new-tooling-dependency posture this project has held since Phase 1
- [Phase 04]: ioredis promoted to a root devDependency at the same 5.11.1 pin so root-level integration tests can import it directly — pnpm's isolated node_modules never hoists a workspace package's own dependency to the root; same fix Phase 1 applied to drizzle-orm and @noodara/domain
- [Phase 04]: toValidationErrorBody normalizes both AJV-style instancePath and a raw Zod path array, preferring instancePath — matches the real shape @fastify/type-provider-zod's createValidationError produces
- [Phase 04]: requireSession's onRequest hook catches a getSession rejection and replies opaque 500 INTERNAL_ERROR itself — Fastify's default error handler otherwise echoes the raw exception message onto the wire before app.ts's global error handler exists
- [Phase 04]: require-session.test.ts invokes createRequireSession(deps) directly against a scope's instance instead of via instance.register(...) — a plain non-fastify-plugin-wrapped plugin creates its own child encapsulation context when registered normally, so a sibling route would never see its hook; this is the composition routes/api-scope.ts (Plan 04-04) must use
- [Phase 04]: createOriginGuard implements Fastify's synchronous done-callback onRequestHookHandler signature, short-circuiting via reply.send() plus return without calling done() — matches the literal type named in the plan and Fastify's own documented short-circuit pattern for that hook shape
- [Phase 04]: connectAndDiscover has 2 publish call sites (not 3): TX2's two success branches share one post-transaction publish call since publishing inside each branch separately would violate the never-inside-a-transaction rule
- [Phase 04]: const result: XxxResult type annotations added to register/edit/delete/trust-fingerprint's transaction assignments to stop TypeScript widening the ok discriminant to boolean once the transaction call left a bare return statement
- [Phase 04]: The no-event-before-commit truth is proven with a genuine Postgres unique-violation race between two concurrent registerServer calls rather than a synthetic forced-throw
- [Phase 04]: zod promoted to a root devDependency (same 4.6.1 pin) so root-level integration tests can build Zod-schema probe routes directly
- [Phase 04]: startTestApp() gained a buildLogger callback (not a pre-built instance) invoked after setTestEnv, since logger.ts imports env.ts which fail-fasts at import time against whatever is currently in process.env
- [Phase 04]: api-scope.ts registers the Origin guard before requireSession's onRequest hook, so a cross-origin mutating request is rejected before spending a session lookup on it
- [Phase 04]: trust-fingerprint.test.ts's pre-existing five-key facade assertion updated to seven members once failInFlightConnection/listConnectingServerIds landed on createServerServices
- [Phase 04]: fail-in-flight-connection.test.ts's activity-row-count helper filters on action = server.connection_attempted, not just entityId, since registerFixtureServer's own registerServer call already writes an unrelated server.created row for the same server
- [Phase 04]: jobIdForServer returns connect-<serverId> (hyphen), not connect:<serverId> as D-09 literally names — BullMQ 6.3.6's Job.validateOptions rejects any custom jobId containing exactly one ':'
- [Phase 04]: bullmq promoted to a root devDependency at the same 6.3.6 pin so root-level integration tests can build a raw probe Queue directly — same pnpm workspace-symlink fix already applied to ioredis/zod/drizzle-orm/@noodara-domain
- [Phase 04]: ioredis's Redis class imported by name (import { Redis } from 'ioredis'), not the default export — under this project's verbatimModuleSyntax + nodenext ESM config the default-import binding fails apps/control-plane's own tsc build with "not constructable"
- [Phase 04]: maxStalledCount:0 + a stalled listener holds against real bullmq@6.3.6/ioredis@5.11.1 (D-12 assumption A3 confirmed empirically, 3 consecutive stalled-recovery test runs, no flake, no second SSH connect)
- [Phase 04]: Root pnpm dev now runs turbo run dev dev:worker (api+worker together) with a byte-for-byte copied passThroughEnv array — zero new devDependency, the concurrently alternative flagged in 04-01 was not needed
- [Phase 04]: worker.ts pings the queue Redis connection (bounded commandTimeout/maxRetriesPerRequest:1) to fail fast at boot, never the worker connection (maxRetriesPerRequest:null would hang against a dead Redis)
- [Phase 04]: sendServiceError(reply: FastifyReply, code, message) is the one non-route-generic-typed function every service-result failure branch uses -- Fastify's own .code<Code> generic narrows to the specific route's declared response-status literals, which a runtime mapServiceCodeToStatus() number can never satisfy without this indirection
- [Phase 04]: jobId format is connect-<serverId> (hyphen), matching Plan 04-06's own recorded BullMQ jobId-cannot-contain-':' deviation, not 04-CONTEXT.md's literal 'connect:<id>' -- no new deviation, just consistent use of the already-corrected format
- [Phase 04]: closeAll()'s unsubscribe() bounded with the same Promise.race timeout as onReady's subscribe() -- an unbounded unsubscribe against a never-fully-connected subscriber would reproduce the exact preClose-vs-onClose shutdown deadlock this plan exists to prevent
- [Phase 04]: routes/events.ts is a factory (createEventsRoutes(deps)), mirroring createRequireSession's shape, so api-scope.ts builds it with the real broadcaster/getSession/heartbeatMs/maxConnections and registers the returned plugin normally inside the already-guarded scope
- [Phase 04]: listActivity joins the ServerServices facade (grown to ten members) rather than a second decorator, mirroring Plan 04-08's getServer/listServers precedent
- [Phase 04]: activity.ts's querystring schema is .strict(): an unrecognised key like ?action= is 400, never a silently-ignored no-op filter (D-20 no-filters scope)
- [Phase 04]: GET /health gets its own dedicated, lazily-built, per-app-instance-memoised Redis connection (getHealthRedis) since none of the existing queue/subscriber/publisher connections are structurally reusable for a PING+SCAN probe
- [Phase 04]: Every health check (postgres/redis/worker) is independently wrapped in a Promise.race-against-a-fixed-timer (withTimeout), the same bounded-race shape app.ts's onReady/preClose hooks already use
- [Phase 04]: BullMQ's add() silently treats a completed job's still-present jobId hash as a duplicate, never re-enqueuing — connect-server-queue.ts now removes a genuinely terminal job before re-adding under the same deterministic jobId, fixing a real DISC-05-breaking bug found by api-e2e.test.ts
- [Phase 04]: boot-command.test.ts's single-process /health case now expects status:degraded/checks.worker:fail — D-26 is correct here since no worker ever runs in that case; the pre-04-10 stale status:ok literal was the bug
- [Phase 05]: session-lookup.ts is a new file rather than added to require-session.ts or events.ts, since both call sites need to import the same helper with no circular dependency
- [Phase 05]: The SSE heartbeat's bounded-getSession regression test lives in a new apps/control-plane/src/routes/events.test.ts unit test rather than in the Testcontainers-backed events-sse.test.ts — api-scope.ts hardwires that file's getSession to the real auth.api.getSession with no injection seam, exactly the fallback the plan's own read_first anticipated for the request-guard case
- [Phase 05-02]: runWorkerShutdown's re-entry guard is a WeakSet keyed by the deps object identity, not a single module-level boolean — worker.ts keeps its own local shuttingDown flag as the primary guard, the helper's own guard is intentionally redundant defense-in-depth
- [Phase 05-04]: onCheck invocation inlined at each of runDiscovery's four checks.push sites via a local const, not an array read-back with a non-null assertion — the project's ESLint config forbids @typescript-eslint/no-non-null-assertion
- [Phase 05-03]: Reworded scripts/check-package-provenance.mjs's normaliseRepoUrl docstring to avoid the literal substring 'includes(' since the pre-existing prose tripped this plan's own acceptance-criteria grep even though the actual comparison logic was never touched or relaxed
- [Phase 05-03]: 04-SECURITY.md's Sign-Off Approval line is worded as evidence-based automated closure per Task 3, explicitly not framed as a human security review or product-owner sign-off, since none was requested or performed
- [Phase 05-03]: UF-02 (worker.ts main()'s unhandled-rejection gap) left open and unmodified: out of scope for D-17, which names only T-4-02/T-4-10/T-4-32/T-4-38 and UF-01
- [Phase 05-05]: The route handler spreads readLatestDiscovery's readonly checks/warnings arrays into plain arrays before reply.send() rather than loosening the service's own readonly return type
- [Phase 05-05]: Three pre-existing ServerServices facade key-count tests (fail-in-flight-connection.test.ts, read-servers.test.ts, trust-fingerprint.test.ts) updated from ten to eleven members after readLatestDiscovery joined the factory -- direct, expected consequence of Task 1, not scope creep
- [Phase 05-06]: ui-components boundaries tag needed ssh-adapter in its own allow list (hoisting artifact of pnpm's flat root node_modules, not a real code dependency), mirroring the pure-domain->ssh-adapter precedent from Phase 2
- [Phase 05-06]: @testing-library/user-event imported by name, not as the default -- its package.json has no type field so under moduleResolution:nodenext its .d.ts is CJS-classified and esModuleInterop's synthetic default resolves to the whole module namespace instead of the real export
- [Phase 05-06]: packages/ui declares its own @testing-library/react, @testing-library/user-event and @testing-library/jest-dom devDependencies -- pnpm boundaries requires a package to directly declare anything it imports, not merely inherit it via root hoisting
- [Phase 05-06]: pnpm 10 silently ignores package.json's pnpm.overrides field -- the react/react-dom single-resolved-version pin moved to pnpm-workspace.yaml's own overrides key instead
- [Phase 05-06]: tokens.css decomposes each of the eight type roles into size/line-height/tracking/weight sub-tokens (not a single shorthand) so theme.css's Tailwind v4 text/tracking namespaces can bind directly with zero literal values
- [Phase 05-22]: packages/ui gained a real dependencies entry on @noodara/domain (workspace:*), not just a devDependency -- pnpm boundaries requires the importing package to directly declare anything it imports, matching the packages/ssh precedent
- [Phase 05-22]: StatusPill's CONNECTING pulse uses Tailwind's built-in motion-safe: variant rather than a hand-written arbitrary keyframe, and Button's aria-busy renders as true-or-undefined (never literal false) so the attribute is genuinely absent when only disabled is set
- [Phase 05-07]: No apps/web/turbo.json and no root package.json dev script change -- Turborepo dispatches a task to every package whose package.json declares a matching script name, so apps/web's own 'dev' script automatically joins the existing shared 'dev' task; verified with 'turbo run dev dev:worker --dry-run=json' before relying on it
- [Phase 05-07]: packages/ui/tokens.css and theme.css had a literal */ substring inside prose doc comments (describing Tailwind's --text-*/--text-*--line-height namespace), prematurely terminating the CSS comment -- this plan's apps/web build is the first real Tailwind pipeline run this phase, surfacing a pre-existing Plan 05-06/05-22 bug; reworded the comments, no functional change
- [Phase 05-07]: buildValidBootEnv() and CI's workflow env both gained NOODARA_API_ORIGIN -- once apps/web's dev script joined the shared turbo dev task, the real clean-tree pnpm dev boot-smoke test and pnpm test:integration's global build setup both now build/boot apps/web too; same class of gap Plan 04-07 fixed for REDIS_URL
- [Phase 05-08]: Field's children prop is a render function (children: (controlProps) => ReactNode), not a cloned element -- lets the same component wrap a bare <input> in its own test and Input/Textarea in later screens without cloneElement typing fragility under exactOptionalPropertyTypes
- [Phase 05-08]: SegmentedControl needed no extra guard against re-firing onValueChange on the already-selected option -- Radix RadioGroup's useControllableState already only calls onChange on an actual value change, confirmed by the RED-then-GREEN cycle rather than assumed
- [Phase 05-10]: e2e:install runs playwright install chromium with no --with-deps -- the session's harness-hygiene instructions forbid sudo/apt-get on the dev machine, overriding the plan text's literal --with-deps chromium
- [Phase 05-10]: tests/e2e/tsconfig.json extends @noodara/config/tsconfig.base.json by package name (matching packages/*/tsconfig.json), requiring @noodara/config to be promoted to a root devDependency (workspace:*)
- [Phase 05-10]: apps/web's unauthenticated-redirect file is proxy.ts, not middleware.ts -- Next.js 16.3.5 deprecates middleware.ts in favor of proxy.ts (export function proxy), confirmed by a real next build warning
- [Phase 05-23]: lucide-react promoted from packages/ui devDependencies to dependencies -- Sheet.tsx is the first component to import it at runtime (the close-button icon), matching the same fix Plan 05-22 applied for @noodara/domain
- [Phase 05-23]: DestructiveConfirmDialog.onConfirm(typedValue: string) hands the typed confirmation value back to the caller (not a no-arg signal) since a later plan's delete/trust-fingerprint flow needs it for the API request body CONFIRMATION_MISMATCH validates
- [Phase 05-09]: Intl.RelativeTimeFormat('en', { numeric: 'always' }) matched the plan's literal expected relative-time strings once thresholds were ordered day>=86400s/hour>=3600s/minute>=60s else 'just now' -- only formatUptime needed hand-rolled pluralization, since Intl has no compound day+hour duration mode
- [Phase 05-09]: SkeletonRow defaults its own data-testid to 'skeleton-row' (overridable) so Plan 05-13's 5-row list-loading state can render five instances and count them via a single querySelectorAll without threading unique ids through each
- [Phase 05-24]: Tooltip's controlled open prop is additive to the primitive's own uncontrolled hover/focus/Escape logic (undefined leaves it fully untouched) -- CopyButton conditionally spreads {...(copied ? { open: true } : {})} rather than open={cond ? true : undefined}, which exactOptionalPropertyTypes rejects for an optional boolean prop
- [Phase 05-24]: renderUi mounts TooltipProvider with delayDuration=0 for test speed/determinism only -- apps/web's real root layout mounts the same TooltipProvider without that override
- [Phase 05-24]: Radix TooltipTrigger suppresses its own onFocus-driven open when a pointer-down just occurred, so a plain click never opens an uncontrolled Tooltip -- CopyButton's forced-open pattern via a controlled open prop is the precedent for any future component needing a click-triggered tooltip confirmation
- [Phase 05-25]: RowMenu is built on @radix-ui/react-dialog's non-modal usage (modal={false}) since no ADR-0000-approved primitive is a purpose-built popover/dropdown-menu -- role=menu/menuitem override the primitive's own default role=dialog (verified by reading its source), plus arrow-key roving focus, the one behaviour the primitive does not provide once that role is chosen
- [Phase 05-25]: ThemeToggle's noodara-theme storage key is declared exactly once (exported STORAGE_KEY constant) and ThemeToggle.test.tsx imports it rather than re-typing the literal, so the plan's own single-file grep acceptance criterion holds by construction
- [Phase 05-11]: error-copy.ts's ServiceErrorCode reuses api-client.ts's own hand-copied ApiErrorCode (minus NETWORK_ERROR) rather than importing http-errors.ts from apps/control-plane, and ServerErrorCode imports directly from @noodara/domain/server -- apps/web never depends on a control-plane-internal module in the browser bundle
- [Phase 05-11]: Login always redirects to /servers on success with no originally-requested-path query parameter, since proxy.ts (out of this plan's scope) does not set one and implementing an unreachable, untested redirect-target reader would add a real open-redirect surface with no way to prove it safe -- deferred to whichever plan has proxy.ts in scope
- [Phase 05-12]: ShellContext lives in its own apps/web/src/lib/shell-context.tsx module rather than defined inline in (shell)/layout.tsx, avoiding an import cycle (Sidebar -> SignOutButton -> layout -> Sidebar)
- [Phase 05-12]: GET /api/events moved off next.config.ts's generic rewrites() proxy onto its own Route Handler (apps/web/src/app/api/events/route.ts) after this plan's own security review found the generic proxy buffers a long-lived SSE response instead of streaming it -- confirmed empirically, not a design preference
- [Phase 05-12]: A minimal apps/web/src/app/(shell)/servers/page.tsx placeholder was added (outside this plan's own files_modified list) since without at least one real page inside the (shell) route group the shell never renders for a real navigation; Plan 05-13 replaces it with the real servers list screen
- [Phase 05-13]: server-store.ts's applyServerEvent/sortServers are readonly ServerView[] end to end so ServerListState's own readonly servers field needs no cast at the page.tsx call site
- [Phase 05-13]: The toolbar's Add server action hides while the servers list is empty (ServerList's EmptyState already renders the one action for that state) -- caught before Task 3's E2E to keep exactly one Add server button on screen at once
- [Phase 05-13]: Task 3's populated-rows E2E test sources its two servers from a stubbed GET /api/servers rather than the real API, since the domain only ever sets lastSeenAt after a real successful SSH connect, which this harness has no reachable sshd fixture to produce
- [Phase 05-13]: vitest.config.ts gained a top-level oxc.jsx option and apps/web gained its own vitest-matchers.d.ts + a direct @testing-library/jest-dom devDependency -- apps/web's Next.js-required tsconfig jsx:preserve was silently breaking every .tsx Vitest test under apps/web/src via this project's rolldown-powered oxc transform, latent until this plan's ServerList.test.tsx became the first such file
- [Phase 05-14]: deriveDetailState excludes lastErrorCode === 'UNSUPPORTED_OS' from the generic-failure branch -- resolves a conflict between the plan's own literal Task 1 text and 05-UI-SPEC.md SS5.1/D-11's 'never an error banner' requirement in the requirement's favor
- [Phase 05-14]: StatTile gained a backward-compatible dimmed/data-dimmed prop (default false) so DETL-02's attenuated-facts treatment applies to the stat tile row too, matching LabelValue's already-established contract
- [Phase 05]: Server-name resolution splits an injected live-lookup (ServerLookup) from activity-copy.ts's own three-tier fallback (live link -> metadata.name plain text -> id-prefix mono)
- [Phase 05]: A page-1 activity refresh merges new items but never moves nextCursor -- only Load older (append mode) advances pagination
- [Phase 05]: curatedDetailFor(item) reads the whole ActivityItem, not just metadata, since errorCode lives outside metadata per the domain's own comment
- [Phase 05-16]: LabelValue.tsx's value span gained a data-mono='true'/'false' attribute (matching Input.tsx/Textarea.tsx's own always-present convention) -- purely additive, ServerFacts.test.tsx's document-wide count assertion rescoped to its own tiles container
- [Phase 05-16]: The settings page deliberately never imports require-session.ts and treats every failure (401 included) as a generic error -- D-15's no-session-management scope made literal by the plan's own acceptance criterion forbidding session/revoke in page.tsx's non-comment source
- [Phase 05-16]: SettingsGroups.tsx composes the public URL's copy button explicitly (LabelValue + a separate CopyButton) rather than through LabelValue's own built-in copyable, so the file visibly satisfies its own contains-Disclosure-and-CopyButton acceptance criterion
- [Phase 05-17]: CredentialFields is uncontrolled (own local state, reports via onChange) so the no-leak/unmount claims hold by construction; ServerSheet stays mounted with open toggling since Sheet's own Radix Content already unmounts real fields on close
- [Phase 05-17]: Sheet.tsx needed min-h-0 on its flex-1 overflow-y-auto body, and apps/web's globals.css needed an explicit @source '../../../../packages/ui/src' directive -- both real, previously-latent bugs first exercised by this plan's Sheet usage
- [Phase 05-17]: E2E server-sheet.spec.ts generates a real throwaway ed25519 key via ssh-keygen rather than a fake string, since credential-store.ts genuinely parses/validates a private key at registration time
- [Phase 05-18]: buildChecklist collapses the domain's four DiscoveryCheckStatus values into a seven-word CheckState union (pass/warning/fail/not_applicable/skipped/pending/running), never a generic idle bucket, so every rendered word matches SS4.2's vocabulary exactly at both check and step granularity
- [Phase 05-18]: DISC-02 marked Complete on a real @ssh-live E2E test: a real sshd Testcontainers fixture, a real connect-and-discover run, eleven distinct time-separated server.discovery_progress SSE frames captured via an EventSource subclass, and a single never-reloaded browser page reaching the correct settled state
- [Phase 05-18]: the Discovery section's own Re-run discovery button carries a dedicated discovery-rerun-button testid, distinct from the toolbar's server-detail-primary-action, since both can render the identical accessible name simultaneously for a CONNECTED server
- [Phase 05-19]: The real trust-fingerprint route takes no request body -- TrustFingerprintDialog re-fetches the server immediately before the real request and refuses to send it if pendingFingerprint no longer matches what was displayed, documenting the residual race rather than hiding it
- [Phase 05-19]: DestructiveConfirmDialog gained an optional, backward-compatible children slot so the trust dialog can repeat both fingerprints in mono above the input per SS5.7
- [Phase 05-19]: HostKeyChangedBanner/TrustFingerprintDialog hide the Trust new fingerprint action entirely once pendingFingerprint is null (the UF-01 fix's own aftermath), rather than leaving an unreachable-but-visible button
- [Phase 05-20]: QA-04 stays Pending: the requirement needs the nightly workflow to actually run green on GitHub Actions, and this repo has no remote -- local e2e-repeat.mjs/pnpm test:integration evidence (20/20 across three invocations, 487/0/1) is necessary but not sufficient; first green CI e2e job + first green nightly.yml run are the missing evidence
- [Phase 05-20]: Root cause of the long-standing events-sse.test.ts/canary-http.test.ts flake found and fixed (6600f37): apps/control-plane's SSE broadcaster issued Redis SUBSCRIBE before the ioredis connection reached ready, silently running with zero live events until process restart -- not machine-specific Docker/network timing as STATE.md previously recorded
- [Phase 05-20]: Two open, unfixed hazards from the sse-lost-event-race debug session carried forward: apps/web/src/app/(shell)/servers/[id]/page.tsx has the same stale-snapshot-overwrites-a-newer-event hazard the servers list had (found by reading, not fixed; activity/page.tsx and DiscoverySection.tsx not audited), and the control-plane heartbeat never inspects its own socket-write result so a half-open peer is only evicted on TCP retransmission giveup
- [Phase 05-20]: pnpm test:integration is fragile to a single Docker hiccup at start of a long run: one Testcontainers port-bind timeout left 2 stray containers, which then cascaded into 289 misleading assertNoStrayTestContainers failures across unrelated files in one observed run -- not a code regression, but worth knowing before trusting a single red full-integration run
- [Phase 05-20]: Process lesson: no executor or wave gate ran the full pnpm test:integration suite during phase 05 until this plan's final verification pass, which is how two phase-04 tests (broken by 05-04 adding server.discovery_progress to the shared stream, fixed out-of-band in f9d1341) stayed red for roughly twenty plans undetected -- future phases should run the full integration suite at wave gates, not only the plan-scoped subset
- [Phase 05-21]: ORCHESTRATOR FINDING: the @canary spec's ~50% hang rate was misdiagnosed by the previous executor as host memory pressure; real cause was response.text() awaited on Playwright's response event never settling for a navigation-abandoned request -- fixed in c41701a (read bodies on requestfinished), verified 12/12. Second time this phase a real defect was written off as 'the machine' (first: the SSE subscription race, 05-20). Process lesson: 'flaky under load' is a hypothesis, not a finding; a bimodal pass/exact-timeout duration points at a hang.
- [Phase 05-21]: Checkpoint resolution (user, 2026-09-20): light-mode status-pill contrast (fails WCAG AA in light mode for all four statuses, fails narrowly in dark for error/idle), the missing floating-elevation shadow, and RowMenu's missing aria-expanded are NOT accepted as-is -- routed to a follow-up gap-closure plan ('Arreglar en gap-closure'), not a phase hold.
- [Phase 05-21]: Checkpoint verdict, verbatim (user, 2026-09-20): 'No me gusta la UI pero la vamos a ir mejorando con el tiempo. Por el momento le doy approve.' Approved to close the phase -- explicitly NOT a statement that the visual design is satisfactory. Never paraphrase as 'UI approved' or 'design signed off.'
- [Phase 05-21]: QA-05 stays Pending: its literal text requires a CI job AND a nightly job to actually run; this repo has no git remote so neither workflow has ever executed on GitHub Actions. Same reasoning/missing-evidence shape as QA-04 (05-20).
- [Phase 05-26]: connect-and-discover.ts's post-TX1 region wraps in try/catch calling failInFlightConnection(reason: connect_service_threw) before rethrowing — closes the CONNECTING wedge (05-VERIFICATION.md gap 2, WR-A-01); recovery failure inside the catch is swallowed defensively so the original error is never masked, with the worker's 'failed' listener as a second line of defense (reason: worker_job_failed)
- [Phase 05-27]: canTrustFingerprint(status) calls transition() itself inside a try/catch rather than re-deriving a second status table, so it can never drift from the real transition rules
- [Phase 05-27]: identityChanged for the pendingFingerprint clear stays its own local host/sshPort/sshUser comparison rather than reusing classifyServerEdit's 'identity' category, which deliberately excludes sshUser and answers a different question (D-14's CONNECTED transition)
- [Phase 05-27]: Existing trustFingerprint() call sites in service-level integration tests and canary-full-flow.test.ts updated to pass the now-required fingerprint field (Rule 3 blocking fix, not in this plan's files_modified list)
- [Phase 05-28]: AbortSignal.timeout does not respect vi.useFakeTimers() on this repo's Node 24/Vitest 5 -- both timeout tests spy on AbortSignal.timeout and drive an AbortController directly instead of advancing fake time
- [Phase 05-28]: API_REQUEST_TIMEOUT_MS = 15000, composed with any caller signal via AbortSignal.any in the one performRequest choke point
- [Phase 05-30]: normalizeFieldPath collapses every /credential/* backend issue path onto the single shared 'credential' form key — CredentialFields.tsx/ServerFormErrors render one inline error for the whole credential block, never a per-field one
- [Phase 05-30]: setup/page.tsx treats only NOT_FOUND as the token-specific known code; TOKEN_INVALID/ALREADY_USED/EXPIRED decode to INTERNAL_ERROR and render its generic copy — api-client.ts's ServiceErrorCode vocabulary and control-plane routes were out of scope this plan (owned by sibling plan 05-28 this wave); documented as a known limitation, not silently accepted
- [Phase 05-32]: mergePage's 'refresh' overload returns { items, contiguous } instead of a bare array (append overload unchanged); a full PAGE_LIMIT page sharing no id with existing resets to the fresh page rather than silently splicing non-adjacent runs — 05-UI-SPEC.md sec 2.6 defines no gap-closing affordance either way, so the simpler of the two options was taken per the plan's own fallback instruction
- [Phase 05-32]: ActivityList resolves the viewer time zone once via Intl.DateTimeFormat().resolvedOptions().timeZone behind an optional timeZone prop, kept out of the pure activity-groups.ts module — groupByDay was already correct once given a real zone (proven by new two-zone unit cases, stable under TZ=UTC and TZ=Pacific/Kiritimati) -- WR-B-06's defect was confined to the caller's two-argument call
- [Phase 05]: 05-34: SSE_MAX_BUFFERED_BYTES set to 1 MiB (matching 05-REVIEW.md's suggested fix); a stream is evicted once reply.raw.writableLength crosses it, proven with a real TCP socket since app.inject() cannot reproduce genuine backpressure
- [Phase 05]: 05-34: worker.ts's entrypoint uses main().catch((err) => { logger.error({ err }, 'worker boot failed'); process.exit(1); }) since server.ts has no guard on its own equivalent call either to mirror -- the plan's own documented fallback
- [Phase 05-ui-web]: check-package-provenance.mjs enumerates deps+devDeps via pnpm list -r --depth 0 --json instead of a hardcoded list — Matches the review's own 52-dependency denominator exactly, closing WR-C-14's 27/52 coverage gap to 52/52
- [Phase 05-ui-web]: ioredis expected repository changed from redis/ioredis (dist-tags.latest) to luin/ioredis (pinned 5.11.1's real repository) — Concrete proof the locked-version provenance check changes the result for a real installed dependency
- [Phase 05-ui-web]: nightly.yml's canary job also got the playwright-install fix beyond the plan's literal ci.yml-only text — Runs the identical security:scan-leaks command with the identical missing-browser defect; nightly.yml was already in files_modified (Rule 1)
- [Phase 05-29]: reconcileDetailSnapshot rejects on isDeleted regardless of source (event or snapshot), stricter than the plan's literal GET-only bullet -- defense in depth against any path resurrecting a deleted server
- [Phase 05-29]: detail page's use(params) mount genuinely issues two GETs for the same id (React 19 Suspense re-render, confirmed empirically) -- gateGets holds every GET seen, not just the first, in the gap-2 E2E races
- [Phase 05-29]: aggregateLiveStepState's unreceived-earlier-check exclusion is a second boolean parameter, not an eighth CheckState -- CHECK_STATES stays the documented seven words
- [Phase 05-ui-web]: Derived apps/web's known-service-error-code allowlist from a single satisfies Record<Code, true> exhaustiveness marker instead of two hand-synced lists, closing a real drift bug (a 409 FINGERPRINT_MISMATCH/SERVER_NOT_TRUSTABLE silently degraded to INTERNAL_ERROR) at compile time
- [Phase 05-ui-web]: TrustFingerprintDialog.tsx snapshots pendingFingerprint (and its seenAt) on the dialog's open transition and sends exactly that value; the client-side re-GET-and-compare is removed since the backend's atomic conditional UPDATE (plan 05-27) strictly supersedes it
- [Phase 05]: require-session.ts's 5s timeout race removed (superseded by api-client.ts's 15s AbortSignal.timeout, plan 05-28) — a hang now resolves to NETWORK_ERROR (never redirects) instead of forcing a logout, since the function is now also invoked from a background SSE-drop signal, not only once on mount
- [Phase 05]: post-mount session-revocation trigger reads useServerEvents()'s existing connected boolean inside (shell)/layout.tsx — no changes to use-server-events.ts or shell-context.tsx, no polling interval; the SSE heartbeat closing the stream server-side on a revoked session is one cause of the true->false transition and requireSession() itself fails open on anything but a real 401
- [Phase 05-33]: D1/D2/D3 (2026-09-20): status-pill text uses new --status-*-text tokens (base tokens stay vivid); --accent splits into --accent (foreground, unchanged) and --accent-fill (fills carrying on-accent text); --ink-secondary/--ink-tertiary darken, Banner.tsx errorCode moves to --ink-secondary
- [Phase 05-33]: Executor nudge (2026-09-20): D1/D3 literal hex values failed once measured against their own real render context (Banner.tsx composited bg, StatusPill real canvas/surface-2 bgs) -- darkened/adjusted the minimal step, same latitude D3 granted for ink-tertiary
- [Phase 05-33]: accent as link text on canvas/surface-3 light (4.31/4.12) stays a documented, unfixed AA gap: D2 locks accent's own value, deferred not silently dropped

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

- REQUIREMENTS.md traceability footer indicaba "40 total" pero el conteo real de IDs únicos en el documento es 42; corregido durante la creación del roadmap (ver traceability actualizada).
- Dos decisiones de stack siguen abiertas por el usuario según research/SUMMARY.md: auth (Better Auth vs. hand-rolled) y framework web (Next.js vs. TanStack Start) — PROJECT.md ya registra Better Auth y Next.js 16 como decisión tomada; confirmar que sigue vigente al planificar Phase 1 y Phase 5.
- tests/integration/ssh/contracts.test.ts's .invalid-TLD row (plan 02-04) now fails on this machine (err.level 'client-socket' instead of the ADR-0004-measured 'client-timeout') — pre-existing, resolver-dependent, unrelated to plan 02-08; see deferred-items.md
- 02-10: a cold pnpm test:integration runtime was not measured (only warm, 555.87s) — this shared dev machine's Docker host has 2000+ images from unrelated projects and there is no safe way to selectively evict this phase's four sshd image variants; a local gitleaks detect run also flags the three already-known fake-credential fixtures because this machine's actual git root sits one level above noodara/code, shifting .gitleaks.toml's anchored allowlist paths — not a real leak, a local-layout artifact
- A full pnpm test:integration run showed a cascading assertNoStrayTestContainers failure (234/311 tests) rooted in tests/integration/ssh/*.test.ts files unrelated to plan 03-10's diff; confirmed pre-existing machine-specific Docker resource contention (isolated re-run of the affected file passed cleanly 16/16). See phases/03-servicios-de-aplicaci-n-activity-log-y-redacci-n/deferred-items.md
- REQUIREMENTS.md marks SERV-06 'Complete' after Plan 04-01, but 04-01 only ships infra (deps, env knobs, job-budget function, Redis test fixture) — no worker, routes, or SSE stream yet. SERV-06's actual behavior lands across Plans 04-02..04-11; this checkbox is a plan-frontmatter artifact of 04-01-PLAN.md declaring requirements: [SERV-06] on the first wave-0 plan, not a real completion. Re-verify SERV-06 at phase-4 close, not from this checkbox alone.
- CORRECTED (05-20, see .planning/debug/sse-lost-event-race.md): events-sse.test.ts's 2-of-10 intermittent failures (server.updated publish, connect+worker E2E waiting on waitForActiveSubscriber) were previously diagnosed here as machine-specific Docker/network flakiness (the "public non-Docker IP in CLIENT LIST" was Docker Desktop's own NAT address, present on every connection including the probe -- a red herring). **That diagnosis was wrong.** The real, confirmed root cause is a product bug: apps/control-plane/src/events/sse-broadcaster.ts's `start()` issued Redis `SUBSCRIBE` before the ioredis subscriber connection reached `ready`; ioredis@5 writes a `SUBSCRIBE` sent during `connect` straight to the socket ahead of its own ready check, that check then fails on a connection already in subscriber mode, ioredis reconnects, and `autoResubscribe` replays nothing because it only remembers a connection that had reached `ready` -- `start()` had already resolved successfully, so the API process ran with zero live events until restarted. Confirmed with a standalone node+ioredis repro (subscribe on `connect`: 0/5 delivered; on `ready`: 3/3 delivered) before any product file was touched. Fixed in `6600f37`: `start()` now awaits `ready` before `SUBSCRIBE`. Before: 8 of 15 subscription-dependent test executions failed (5/5 runs red); after: 0 of 30 (10/10 runs green).
- 04-10: a combined tests/integration/routes/+services/ run (18 files, extra-broad regression check beyond this plan's scope) showed 137 failing stray-container-count assertions concentrated in register-server.test.ts/trust-fingerprint.test.ts (files this plan did not modify); isolated re-runs of those files (28/28) and the servers-crud/connect/discover files (38/38) passed cleanly, confirming the pre-existing shared-dev-machine Docker resource contention pattern, not a regression.
- 05-01-PLAN.md declares requirements: [DETL-02, QA-05] in its frontmatter, but only implements the two security-remediation items (UF-01 pendingFingerprint clear, T-4-02 bounded session lookups) -- no UI empty-state work (DETL-02) or CI canary job (QA-05) landed in this plan. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 after Plan 04-01. Re-verify DETL-02/QA-05 against the plans that actually implement them, not this checkbox.
- 05-02-PLAN.md declares requirements: [QA-05] in its frontmatter but only closes the T-4-10/T-4-38/T-4-32 threat-remediation tasks that make QA-05's canary safe against real err output -- it does not add the nightly CI job (.github/workflows/nightly.yml, still Wave 2+ per 05-PATTERNS.md). CI already runs pnpm security:scan-leaks (Phase 4's ci.yml); QA-05 also needs a nightly job before it can be marked Complete. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01) and DETL-02/QA-05 (05-01).
- 05-03-PLAN.md declares requirements: [UI-01, QA-05] in its frontmatter, but only extends the package provenance gate and closes 04-SECURITY.md's sign-off -- no design-system shell (UI-01) or nightly canary CI job (QA-05, still pending per 05-02's own note) landed in this plan. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01) and QA-05 (05-02). Re-verify UI-01/QA-05 against the plans that actually implement them.
- 05-05-PLAN.md declares requirements: [DISC-02, QA-05] in its frontmatter, but only closes DISC-02's read-endpoint surface (GET /api/servers/:id/discovery) and extends canary-http.test.ts to scan it plus the server.discovery_progress SSE frame -- CI's ci.yml security job already runs pnpm security:scan-leaks (Phase 4), but the nightly job (.github/workflows/nightly.yml) QA-05 also requires per REQUIREMENTS.md's own wording ('Un job de CI y nightly...') still has not landed (flagged pending since 05-02/05-03). QA-05 stays Pending in REQUIREMENTS.md; DISC-02 was already Complete before this plan. Re-verify QA-05 once nightly.yml exists.
- 05-06-PLAN.md declares requirements: [UI-01] in its frontmatter, but only builds the packages/ui scaffold, component-test harness and tokens.css/theme.css -- no shell, sidebar, toolbar or navigation exists (apps/web itself is not created by this plan). Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03) and DISC-02/QA-05 (05-05). Re-verify UI-01 against whichever later plan actually builds the shell (05-UI-SPEC.md section 1).
- 05-22-PLAN.md declares requirements: [UI-01] in its frontmatter, but only adds Button/StatusPill/cn/tone to packages/ui -- no shell, sidebar, toolbar or apps/web exists yet. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05) and UI-01 itself (05-06). Re-verify UI-01 against whichever later plan actually builds the shell (05-UI-SPEC.md section 1).
- 05-07-PLAN.md declares requirements: [UI-01, UI-02] in its frontmatter, but only builds apps/web's infrastructure (same-origin proxy, no-flash theme bootstrap, tested fetch client) -- no sidebar, toolbar, navigation, or any of the seven screens 05-UI-SPEC.md describes exist yet (Plan 05-12 adds the authenticated shell route-group layout this plan deliberately leaves for later). Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05), and UI-01 itself (05-06, 05-22). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens.
- 05-08-PLAN.md declares requirements: [UI-01, UI-02] in its frontmatter, but only adds Field/Input/Textarea/SegmentedControl plus the seven Radix primitive installs to packages/ui -- no shell, sidebar, toolbar or screens exist yet. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05) and UI-01/UI-02 itself (05-06, 05-22, 05-07). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens.
- 05-10-PLAN.md declares requirements: [QA-04] in its frontmatter, but only builds the Playwright harness and proves the unauthenticated-redirect + 401-guard behaviours -- the full critical-path E2E and nightly 20x repetition are Plan 05-20's job. QA-04 stays Pending in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), UI-01/UI-02 (05-06 through 05-08). Re-verify QA-04 against Plan 05-20.
- 05-23-PLAN.md declares requirements: [UI-01, UI-02] in its frontmatter, but only adds isConfirmationMatch/FileButton/Sheet/ConfirmDialog/DestructiveConfirmDialog to packages/ui -- no shell, sidebar, toolbar or screens exist yet. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05) and UI-01/UI-02 itself (05-06, 05-22, 05-07, 05-08). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens.
- 05-09-PLAN.md declares requirements: [UI-01, UI-02] in its frontmatter, but only adds format.ts plus Banner/Notice/EmptyState/Skeleton to packages/ui -- no shell, sidebar, toolbar or screens exist yet. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05) and UI-01/UI-02 itself (05-06, 05-22, 05-07, 05-08, 05-23). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens.
- 05-24-PLAN.md declares requirements: [UI-01, UI-02] in its frontmatter, but only adds Tooltip/RelativeTime/CopyButton/StatTile/LabelValue to packages/ui -- no shell, sidebar, toolbar or screens exist yet. DETL-01 (also named in this plan's must_haves) is likewise not satisfied end-to-end: StatTile/LabelValue's contracts are real and tested but no screen wires them to real discovery data yet (Plan 05-14's job). Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05) and UI-01/UI-02 itself (05-06, 05-22, 05-07, 05-08, 05-23, 05-09). Re-verify UI-01/UI-02/DETL-01 against whichever later plan actually builds the shell and screens.
- 05-25-PLAN.md declares requirements: [UI-01, UI-02] in its frontmatter, but only completes 05-UI-SPEC.md's Component Inventory (ListRow, RowMenu, Disclosure, ThemeToggle) -- no shell, sidebar, toolbar or screens exist yet. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for UI-01/UI-02 across every prior packages/ui-only plan this phase (05-06, 05-22, 05-07, 05-08, 05-23, 05-09, 05-24). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens.
- 05-11-PLAN.md declares requirements: [UI-02] in its frontmatter, but only builds 2 of the 7 screens UI-02 requires (setup, login) -- servers list, add/edit sheet, server detail, activity log and settings still need Plans 05-12 through 05-21. Not marked Complete in REQUIREMENTS.md; matches the same plan-frontmatter-artifact pattern already flagged for UI-01/UI-02 across every prior plan this phase (05-06 through 05-25). Re-verify UI-02 once the remaining screens and the authenticated shell land.
- 05-12-PLAN.md declares requirements: [UI-01, UI-02] in its frontmatter; only UI-01 is marked Complete here (the authenticated shell, proven by six passing @shell E2E behaviours). UI-02 stays Pending -- this plan's own /servers page is a minimal placeholder (no list, no empty/loading/error states), not a real screen; UI-02 needs Plans 05-13..05-21's actual servers list, add/edit sheet, server detail, activity log and settings screens. Matches the same plan-frontmatter-artifact pattern already flagged for every prior UI-01/UI-02 plan this phase.
- 05-13-PLAN.md declares requirements: [SERV-04, UI-02] in its frontmatter; only SERV-04 is marked Complete here (the servers list screen, proven by 6 passing @servers E2E behaviours). UI-02 stays Pending -- this plan builds the third of the seven screens UI-02 requires (setup, login, servers list now done; sheet, server detail, activity log, settings remain -- Plans 05-14 through 05-21). Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for every prior UI-01/UI-02 plan this phase.
- 05-14-PLAN.md declares requirements: [DETL-01, DETL-02, UI-02] in its frontmatter; only DETL-01/DETL-02 are marked Complete here. UI-02 stays Pending -- this plan builds the fourth of the seven screens UI-02 requires (setup, login, servers list, server detail now done; add/edit sheet, activity log, settings remain -- Plans 05-16/05-17/05-21). Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for every prior UI-01/UI-02 plan this phase.
- QA-04 (05-20) needs a first real green run of .github/workflows/ci.yml's e2e job and .github/workflows/nightly.yml's e2e-repeat/stress-connections/canary jobs on actual GitHub Actions -- both files are syntax-checked and their job bodies validated locally only, since this repository has no remote yet and no scheduled/workflow_dispatch run has ever executed
- [05-21, Open at phase close, routed to gap-closure] Light-mode status-pill contrast fails WCAG AA for all four status colors (1.96-2.95:1 vs 4.5:1); dark mode fails narrowly for error/idle (4.21/4.22:1). Not accepted as-is, not fixed -- a locked noodara-ux-apple token decision, user routed it to a follow-up gap-closure plan (2026-09-20, verbatim: 'Arreglar en gap-closure').
- [05-21, Open at phase close, routed to gap-closure] No floating-elevation shadow (0 8px 30px rgba(...)) implemented anywhere on Sheet/Dialog/RowMenu despite being a documented elevation level in the noodara-ux-apple skill; found by docs/ui-review-05.md, routed to gap-closure alongside the contrast gap.
- [05-21, Open at phase close, routed to gap-closure] RowMenu's trigger has aria-haspopup=menu but never aria-expanded -- the one missing WAI-ARIA Menu Button attribute in the component inventory; found by docs/ui-review-05.md, routed to gap-closure.
- [05-21, Open at phase close] Live updates (SSE list insertion, discovery progress) were never seen by a human -- the one real walkthrough went through a Cloudflare Quick Tunnel that buffers SSE; covered by E2E only (@sse-live, @ssh-live, critical-path.spec.ts). docs/ui-review-05.md's Needs-human-review items 1-6 also remain open (real visual quality, shadow gap's visual impact, contrast's real-world legibility, sub-1280px on a real device, prefers-reduced-motion's felt effect, RowMenu's real screen-reader announcement).
- [05-21, Open at phase close] QA-04 and QA-05 both stay Pending: both require a real green run on GitHub Actions (ci.yml's e2e/security jobs, nightly.yml's jobs including @canary), and this repository has no git remote, so neither has ever executed there. The 20x nightly E2E repeat (20/20) was run before @canary existed as the 73rd spec and was never re-run with it included.
- [05-21, Open at phase close, carried from prior plans] trust-fingerprint-toctou.md (priority high, .planning/todos/pending/): POST /api/servers/:id/trust-fingerprint takes no body and promotes whatever pendingFingerprint the row holds at request time, with no binding to the fingerprint the admin actually saw -- needs a backend change. setup-token-url-hardening.md: the one-time setup token lingers in the URL/browser history; no Referrer-Policy set. UF-02 (04-SECURITY.md): worker.ts's main() has no top-level try/catch, a boot failure can print DATABASE_URL/REDIS_URL to stderr. servers/[id]/page.tsx has the same stale-snapshot-overwrite hazard the servers list had before its 05-20 fix (found by reading, not fixed); activity/page.tsx and DiscoverySection.tsx not audited for it.
- 05-27: POST /api/servers/:id/trust-fingerprint now requires { fingerprint } in its body (backend-only fix for gap 6/WR-A-02); apps/web/src/components/TrustFingerprintDialog.tsx still POSTs with no body at all and will get 400 VALIDATION_FAILED on every trust attempt until Plan 05-31 sends { fingerprint } and handles FINGERPRINT_MISMATCH. Trust-fingerprint UI is non-functional end-to-end until then.
- 05-27-PLAN.md declares requirements: [DETL-02] in its frontmatter, but the plan's actual work is gap 6/WR-A-02 (trust-fingerprint TOCTOU) -- DETL-02 was already Complete before this plan (Plan 05-14). Matches the same plan-frontmatter-artifact pattern flagged repeatedly in this phase (SERV-06 04-01, UI-01/UI-02 05-06 onward, etc.); no action needed since DETL-02 is genuinely already satisfied, just noting the frontmatter/scope mismatch.
- [05-37, found live during the closing gate's gap re-derivation, NOT fixed by this plan] `apps/web/src/components/ServerSheet.tsx`'s SSH user `Field` (around `:303-316`) renders with no `error` prop wired, while `handleApiFailure` (`:111-142`) does map a server-side `/sshUser` VALIDATION_FAILED issue into `fieldErrors` and suppresses the generic toast fallback once that map is non-empty -- so a real `sshUser` rejection from the backend now produces zero visible feedback, silently worse than before gap 5's fix. This was `05-REVIEW.md` WR-B-07's warned "latent second bug", confirmed still present by direct source read. Per the user's explicit instruction (2026-09-20 checkpoint answer), this is fixed via a separate `/gsd-quick` task run immediately by the orchestrator, not inside plan 05-37. See `.planning/phases/05-ui-web/05-GAP-CLOSURE-AUDIT.md` section 2 (Gap 5) and section 3.
- [05-37, checkpoint answered 2026-09-20] The user approved closing the gap-closure wave ("Approve y haz un gsd quick del sshUser bug") but did not state which, if any, of the six human-only verification items (real-display contrast in both themes; a real CI run for QA-04/QA-05; a live SSE walkthrough not through a buffering tunnel; Sheet/Dialog/RowMenu floating-elevation shadow; a real screen-reader pass on RowMenu; sub-1280px/`prefers-reduced-motion` feel on real hardware) they actually checked. All six remain unconfirmed -- recorded honestly as such in `05-GAP-CLOSURE-AUDIT.md` section 3, not rounded up to "verified". They should surface again as UAT items in Phase 05's verification step.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260920-ly9 | Render the server-side `sshUser` field error in ServerSheet (was silently swallowed; gap 5 residual from 05-GAP-CLOSURE-AUDIT.md) + guard test over every server-sheet form field | 2026-09-20 | 8d7091a | [260920-ly9-render-server-side-sshuser-field-error-i](./quick/260920-ly9-render-server-side-sshuser-field-error-i/) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none — primer milestone)* | | | |

## Session Continuity

Last session: 2026-09-20T21:46:08Z
Stopped at: Completed 05-37-PLAN.md (closing gate: full cross-suite run all green, eight gap verdicts re-derived, user approved via checkpoint without confirming any of the six human-only items; sshUser field-error bug found and routed to a separate /gsd-quick fix run by the orchestrator next). Quick task 260920-ly9 then FIXED the sshUser bug (6319631 RED, 8d7091a GREEN; unit 1497/1497). Phase 05 is NOT complete -- pending: code review, regression gate, and phase verification.
Resume file: None
