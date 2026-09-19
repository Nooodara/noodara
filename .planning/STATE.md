---
gsd_state_version: 1.0
milestone: v0.1
milestone_name: milestone
status: planning
stopped_at: Phase 5 context gathered
last_updated: "2026-09-19T04:22:51.448Z"
last_activity: 2026-09-19
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 48
  completed_plans: 48
  percent: 67
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-10)

**Core value:** Noodara puede conocer, registrar y comunicarse con infraestructura real de forma segura y consistente: sin fugas de credenciales, sin estados falsos, sin caídas por fallos del servidor remoto.
**Current focus:** Phase 5 — ui web

## Current Position

Phase: 5
Plan: Not started
Status: Ready to plan
Last activity: 2026-09-19

Progress: [██████████] 100%

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
- events-sse.test.ts: 2 of 10 tests (server.updated publish, connect+worker E2E) intermittently fail on this shared dev machine waiting for a real Redis subscription (waitForActiveSubscriber timeout) -- diagnosed as machine-specific Docker/network flakiness (CLIENT LIST showed a public non-Docker IP sharing the container's mapped port during one failure), not a code defect; a standalone non-Vitest reproduction succeeded deterministically every run. Matches this repo's pre-existing 'shared dev machine Docker resource contention' pattern. Re-verify on a clean machine/CI.
- 04-10: a combined tests/integration/routes/+services/ run (18 files, extra-broad regression check beyond this plan's scope) showed 137 failing stray-container-count assertions concentrated in register-server.test.ts/trust-fingerprint.test.ts (files this plan did not modify); isolated re-runs of those files (28/28) and the servers-crud/connect/discover files (38/38) passed cleanly, confirming the pre-existing shared-dev-machine Docker resource contention pattern, not a regression.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none — primer milestone)* | | | |

## Session Continuity

Last session: 2026-09-19T04:22:51.437Z
Stopped at: Phase 5 context gathered
Resume file: .planning/phases/05-ui-web/05-CONTEXT.md
