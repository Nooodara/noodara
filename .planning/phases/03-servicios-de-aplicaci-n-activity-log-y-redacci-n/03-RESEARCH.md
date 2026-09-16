# Phase 3: Servicios de aplicación, activity log y redacción - Research

**Researched:** 2026-09-15
**Domain:** Internal application services (TypeScript, Drizzle/PostgreSQL, Fastify-adjacent), orchestrating `@noodara/ssh` + `@noodara/domain` — no new external technology.
**Confidence:** HIGH (every claim below is grounded in the actual committed source, read in full during this research pass; no web search was needed — the domain is 100% this repo's own prior-phase contracts).

## Summary

Phase 3 builds four application services (`registerServer`, `editServer`, `deleteServer`, `connectAndDiscover`, `trustFingerprint`) plus a `ServerView` projection, all living in `apps/control-plane/src/services/`, following the exact transactional pattern already proven twice in this codebase (`setup-service.ts`, `session-service.ts`): open `db.transaction`, do the work, call `writeActivityEvent(tx, ...)` inside the same transaction, return a `{ ok: true, ... } | { ok: false, code, message }` result. Nothing here is a new pattern — it is disciplined reuse of Phase 1/2 contracts.

Three concrete gaps were found that the planner must resolve explicitly (they are not re-decisions of anything locked in 03-CONTEXT.md, they are implementation facts CONTEXT.md's decisions did not anticipate):

1. **`loadPrivateKey` (the function D-15 requires the service to reuse for pre-persist key validation) is not exported from `@noodara/ssh`'s public surface.** It lives in `packages/ssh/src/key-loader.ts` but `packages/ssh/src/index.ts` exports only 7 names, guarded by an exact-match test. D-15 cannot be satisfied without either exporting it (a real, if narrow, `packages/ssh` contract change — which 03-CONTEXT.md's phase-boundary text says does not happen this phase) or re-implementing key-format validation. See Pitfall 1 and Open Question 1.
2. **`apps/control-plane`'s `package.json` has no runtime dependency on `@noodara/ssh`** — only `@noodara/domain`. This phase is the first to make the control-plane app actually call into the SSH adapter at runtime (root `devDependencies` already has `@noodara/ssh` for the top-level `tests/integration/**` harness, but that is a separate, root-scoped dependency and does not satisfy `apps/control-plane`'s own workspace resolution). A task must add it.
3. **`validateServerName` already exists** in `packages/domain/src/validators/identity.ts` (built in Phase 1, unused until now) — 03-CONTEXT.md's "Claude's Discretion" section describes it as new work; it is not. The planner should point tasks at reusing it, not building it.

Every other contract this phase orchestrates (`SshPort.connect`, `runDiscovery`, `transition`, `applyConnectionResult`, `envelope.ts`, `SecretValue`/`Redactor`, `writeActivityEvent`, Drizzle schema, migration tooling, the canary test harness) is precisely typed below, quoted from the actual source.

**Primary recommendation:** Build the services as thin orchestration functions that never duplicate a rule that already exists in `packages/domain` or `packages/ssh` — the only genuinely new logic this phase writes is: (a) three or four small pure functions in `packages/domain` (`mergeDiscoveryFacts`, snapshot-outcome classification, `classifyServerEdit`), (b) the transactional glue in `apps/control-plane/src/services/*`, and (c) migration `0003`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Server registration/edit/delete rules | API/Backend (`apps/control-plane/src/services`) | Database (Drizzle schema + migration 0003) | Transactional orchestration is inherently backend; the domain layer supplies pure validation/classification, never persists |
| Credential encryption/decryption mapping | API/Backend (`credential-store.ts`) | — | Wraps `packages/domain/src/security/envelope.ts` (pure crypto) with the one place that touches the `credentials` table |
| Connect + discovery orchestration | API/Backend (`connect-server.ts` service) | SSH adapter (`@noodara/ssh`, already built) | Service owns the transaction and the state machine call; `@noodara/ssh` owns the wire protocol |
| Server state transitions | Database/Domain (`packages/domain/src/server`) | — | Already built (Phase 1); this phase only calls `transition`/`applyConnectionResult`, never reimplements them |
| Discovery snapshot persistence | Database (`discovery_snapshots` table, migration 0003) | API/Backend (service writes it) | Append-only audit data; owned by Postgres, written once per run by the service |
| Activity event writing | API/Backend (`write-activity-event.ts`, already built) | Database (`activity_events` table, already built) | This phase only widens the action union (domain) and adds callers (services) — the writer itself does not change |
| Secret redaction | Domain (`packages/domain/src/security/redactor.ts`, already built) | API/Backend (`appRedactor` singleton, already built) | This phase adds no new redaction machinery — it proves the existing machinery holds end-to-end for a real SSH flow (D-18) |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SERV-01 | Register a server with encrypted credential, never returned in plaintext | `registerServer` service pattern (setup-service.ts precedent), `credential-store.ts` helper, `envelope.ts` encrypt, `ServerView` (D-19) — all quoted below |
| SERV-02 | Edit server fields + replace credential without ever showing the existing one | `editServer` in-place credential replacement (D-13), `classifyServerEdit` pure function, `CONNECTED->PENDING`/`clean_close` transition reasons already implemented |
| SERV-03 | Delete server with name confirmation, same-transaction credential delete, event logged | `deleteServer` pattern, D-14 event-before-delete ordering, `ON DELETE CASCADE` on `discovery_snapshots.server_id` |
| SEC-02 | No credential ever leaks via logs/API/errors/activity log; canary-verified | Existing `appRedactor`/`toLogSafe`/`writeActivityEvent` machinery (all built, quoted below) + D-18's full-flow canary extending `tests/integration/activity/canary.test.ts` |
| DISC-03 | Discovery snapshot append-only + denormalized `Server` update, same operation | `discovery_snapshots` schema (new, migration 0003), `mergeDiscoveryFacts` pure function, `runDiscovery`'s `DiscoverySnapshot` shape (already built) |
| ACT-01 | Typed events for setup/login/logout/server CRUD/connection/discovery, services-only | `AUTH_ACTIONS` union widening pattern in `activity-event.ts` (already built for auth; this phase adds `server.*`), boundary test pattern from `packages/ssh/src/boundary.test.ts` |
</phase_requirements>

## Standard Stack

No new external package is introduced by this phase. Every dependency this phase needs is already installed:

### Already available (no `npm install` needed)
| Package | Version (installed) | Purpose | Source |
|---|---|---|---|
| `drizzle-orm` | 0.45.2 | `.for('update')` row locking, `uniqueIndex`, `sql\`\`` expression indexes, `db.transaction` | `apps/control-plane/package.json` [VERIFIED: package.json] |
| `drizzle-kit` | 0.31.10 | `db:generate` diffs schema.ts against migration snapshots | `apps/control-plane/package.json` |
| `uuidv7` | 1.2.1 | `discovery_snapshots.id` generation, matching `servers`/`credentials` convention | `apps/control-plane/package.json` |
| `@noodara/ssh` | workspace | `SshPort`, `runDiscovery`, `formatFingerprint` — **must be added to `apps/control-plane/package.json`'s `dependencies`** (currently absent — see Pitfall 2) | `packages/ssh/package.json` |
| `@noodara/domain` | workspace | already a dependency of `apps/control-plane` | `apps/control-plane/package.json` |

### One missing wiring task (not a new package — a missing dependency declaration)
`apps/control-plane/package.json`'s `dependencies` block today is:
```json
"dependencies": {
  "@fastify/type-provider-zod": "1.0.0",
  "@noodara/domain": "workspace:*",
  "argon2": "0.45.1",
  "better-auth": "1.7.4",
  "commander": "15.0.0",
  "drizzle-orm": "0.45.2",
  "fastify": "5.12.3",
  "pg": "8.23.0",
  "pino": "10.3.1",
  "uuidv7": "1.2.1",
  "zod": "4.6.1"
}
```
[VERIFIED: apps/control-plane/package.json] — `@noodara/ssh` is absent. Add `"@noodara/ssh": "workspace:*"` before any service imports from it, or `pnpm build`/`tsc` will fail to resolve the module at the workspace-package level (root `devDependencies` already lists `@noodara/ssh` for the top-level integration-test harness, but that is unrelated to `apps/control-plane`'s own dependency graph).

## Package Legitimacy Audit

No external (non-workspace) packages are introduced by this phase — the only new dependency wiring is an existing workspace package (`@noodara/ssh`, already built and tested in Phase 2). The Package Legitimacy Gate protocol (slopcheck, registry verification) is **not applicable**: workspace packages are not subject to registry/provenance checks. No entry needed.

## Architecture Patterns

### System Architecture Diagram

```text
                    ┌─────────────────────────────────────────────┐
                    │        apps/control-plane/src/services       │
                    │                                                │
  caller (Phase 4   │  registerServer ──┐                            │
  routes/worker,     │  editServer ──────┤                            │
  out of scope       │  deleteServer ────┼──► db.transaction(tx) ────┼──► Postgres
  this phase; unit   │  trustFingerprint ┤        │                   │    servers
  tests call these   │  connectAndDiscover┘        │                   │    credentials
  functions directly)│         │                    ▼                   │    discovery_snapshots
                    │         │           writeActivityEvent(tx,...) │    activity_events
                    │         │                    │                   │
                    │         ▼                    ▼                   │
                    │  credential-store.ts   buildActivityEvent()     │
                    │  (envelope encrypt/     (packages/domain,        │
                    │   decrypt ↔ SshCredential) throws on forbidden   │
                    │         │               metadata keys)           │
                    │         ▼                                        │
                    │  SshPort.connect()  ──► @noodara/ssh (Phase 2,   │
                    │  runDiscovery()         already built, unchanged)│
                    │         │                                        │
                    │         ▼                                        │
                    │  transition() / applyConnectionResult()          │
                    │  (packages/domain/src/server, already built)     │
                    └─────────────────────────────────────────────┘
                                        │
                                        ▼
                              appRedactor.redact(metadata)
                              (packages/domain/src/security/redactor.ts,
                               already built — registers master key/auth
                               secret at module load; services register
                               nothing extra, the SSH credential lifecycle
                               is already registered/released inside
                               @noodara/ssh's own session, see Pitfall 3)
```

### Recommended Project Structure
```
apps/control-plane/src/services/
├── setup-service.ts              # existing (Phase 1)
├── session-service.ts            # existing (Phase 1)
├── setup-token-repository.ts     # existing (Phase 1)
├── login-attempt-repository.ts   # existing (Phase 1)
├── credential-store.ts           # NEW — envelope ↔ SshCredential, the only file that imports envelope.ts + credentials schema
├── credential-store.test.ts
├── server-view.ts                # NEW — ServerView projection + the "no credential field" unit test (D-19)
├── register-server.ts            # NEW — SERV-01
├── register-server.test.ts
├── edit-server.ts                # NEW — SERV-02 (also contains classifyServerEdit call site)
├── edit-server.test.ts
├── delete-server.ts              # NEW — SERV-03
├── delete-server.test.ts
├── connect-and-discover.ts       # NEW — D-01..D-08, DISC-03
├── connect-and-discover.test.ts
├── trust-fingerprint.ts          # NEW — D-04
└── trust-fingerprint.test.ts

apps/control-plane/src/activity/
├── write-activity-event.ts       # existing, unchanged
├── redaction.ts                  # existing, unchanged
└── boundary.test.ts              # NEW — "only src/services/ and src/activity/ import writeActivityEvent" (mirrors packages/ssh/src/boundary.test.ts's pattern)

apps/control-plane/src/db/
├── schema/
│   ├── servers.ts                # MODIFIED — docker_compose_version column, 2 unique indexes
│   ├── discovery-snapshots.ts    # NEW table
│   └── index.ts                  # MODIFIED — barrel export
└── migrations/0003_<name>.sql    # NEW — generated via `pnpm --filter @noodara/control-plane db:generate`

packages/domain/src/
├── discovery/
│   └── merge-facts.ts            # NEW — mergeDiscoveryFacts + snapshot outcome classification (pure)
└── server/
    └── classify-edit.ts          # NEW — classifyServerEdit (pure)

tests/integration/activity/
├── canary.test.ts                # existing (Phase 1, unchanged) — logger/HTTP-error/activity-metadata canary, no SSH
└── canary-full-flow.test.ts      # NEW — D-18's SEC-02 full connect→discover→edit→trust→delete canary against the Phase 2 sshd Testcontainer
```

### Pattern 1: Transactional service returning a discriminated result
**What:** Every mutating service opens exactly one `db.transaction`, does all reads/writes/`writeActivityEvent` calls on the `tx` handle it receives, and returns `{ ok: true, ... } | { ok: false, code, message }`. Never throws for an expected failure (validation, not-found, conflict) — throws only for a genuine bug/infra failure.
**When to use:** Every service in this phase (`registerServer`, `editServer`, `deleteServer`, `connectAndDiscover`, `trustFingerprint`).
**Example (from `setup-service.ts`, the exact pattern to replicate):**
```typescript
// Source: apps/control-plane/src/services/setup-service.ts (existing, Phase 1)
export async function redeemSetupToken(input: RedeemSetupTokenInput): Promise<RedeemSetupTokenResult> {
  const now = input.now ?? new Date();
  const db = await getDb();

  return db.transaction(async (tx) => {
    // ... validation, early `return { ok: false, code, message }` on each failure ...
    await writeActivityEvent(
      tx,
      {
        actorType: 'system',
        actorId: null,
        entityType: 'user',
        entityId: signUpResult.user.id,
        action: 'auth.setup_completed',
        outcome: 'success',
        metadata: { email: emailResult.value },
      },
      now,
    );
    return { ok: true, userId: signUpResult.user.id };
  });
}
```
`writeActivityEvent`'s signature composes into any caller's transaction with no special-casing, because its `handle` parameter type is the shared Drizzle base class both `db` and `tx` extend:
```typescript
// Source: apps/control-plane/src/activity/write-activity-event.ts (existing, unchanged this phase)
export type ActivityWriteHandle = PgDatabase<NodePgQueryResultHKT, typeof schema>;
export async function writeActivityEvent(
  handle: ActivityWriteHandle,
  input: WriteActivityEventInput,
  now: Date = new Date(),
): Promise<string>
```

### Pattern 2: Row locking for the D-05 double-dispatch guard
**What:** `connectAndDiscover` must reject a second concurrent invocation for the same server with `ALREADY_CONNECTING`, using `SELECT ... FOR UPDATE` inside the same transaction that performs the `PENDING/DISCONNECTED/UNREACHABLE/ERROR → CONNECTING` transition.
**When to use:** Only in `connectAndDiscover`'s opening step.
**Example:**
```typescript
// Drizzle pg-core supports .for('update') on select queries (verified against the installed
// drizzle-orm@0.45.2 type declarations: pg-core/query-builders/select.types.d.ts declares
// PgSelectLockingStrength including 'update', with optional noWait/skipLocked modifiers).
import { eq } from 'drizzle-orm';

const [row] = await tx
  .select()
  .from(servers)
  .where(eq(servers.id, serverId))
  .for('update'); // blocks a concurrent SELECT ... FOR UPDATE on the same row until this tx commits/rolls back

if (!row) return { ok: false, code: 'NOT_FOUND', message: 'Server not found' };
if (row.status === 'CONNECTING') {
  return { ok: false, code: 'ALREADY_CONNECTING', message: 'A connection attempt is already in flight' };
}
// ... transition(row.status, 'CONNECTING'), update row, commit lock release happens at tx end ...
```
Note: the *second* concurrent transaction blocks on `.for('update')` until the first commits — at which point it re-reads the row (now `CONNECTING` from the first tx's own commit) and returns `ALREADY_CONNECTING` itself, rather than deadlocking. This is the standard "check-then-act under row lock" pattern; no `SELECT ... FOR UPDATE NOWAIT` is needed per 03-CONTEXT.md's D-05 (a blocking wait that resolves to a correct conflict response is acceptable — there is no stated requirement for immediate-fail semantics).

### Pattern 3: Unit-testable `SshPort`/clock/db injection (constructor/factory injection, no DI container)
**What:** Services accept their dependencies (`SshPort`, `SshTimeouts`, `now`, db handle) as parameters or via a factory, per 03-CONTEXT.md's Claude's-Discretion note (`createServerServices({ db, ssh, timeouts, now })`). This mirrors `ARCHITECTURE.md`'s own stated rationale ("constructor injection is enough — no DI container needed at this scale").
**Example shape:**
```typescript
export interface ServerServicesDeps {
  readonly db: Database; // from '../db/client.js' (or getDb() default)
  readonly ssh: SshPort;  // createSsh2Adapter() in production, a fake in unit tests
  readonly timeouts: SshTimeouts; // env.NOODARA_SSH_*_MS, already parsed in env.ts
  readonly now?: () => Date;
}

export function createServerServices(deps: ServerServicesDeps) {
  return {
    registerServer: (input: RegisterServerInput) => registerServer(deps, input),
    editServer: (input: EditServerInput) => editServer(deps, input),
    deleteServer: (input: DeleteServerInput) => deleteServer(deps, input),
    connectAndDiscover: (input: ConnectAndDiscoverInput) => connectAndDiscover(deps, input),
    trustFingerprint: (input: TrustFingerprintInput) => trustFingerprint(deps, input),
  };
}
```
Unit tests supply a fake `SshPort` implementing the two-method interface directly (`connect(input): Promise<ConnectOutcome>`); `run-discovery.test.ts` already establishes the pattern of a `buildFakeSession()` helper returning `{ exec, close }` stubs, reusable as a template for a fake `SshSession`.

### Pattern 4: Credential encryption round-trip (`credential-store.ts`)
**What:** The single file that converts between a `credentials` row (`encryptedValue`, `keyVersion`, `type`) and a decrypted `SshCredential` (`packages/ssh`'s type). Uses `packages/domain/src/security/envelope.ts`'s `encryptSecret`/`decryptSecret` directly — no new crypto.
**Credential shapes to encrypt (D-15):**
- `ssh_password` type: `encryptedValue = encryptSecret(rawPassword, key)` — plaintext is the bare password string.
- `ssh_private_key` type: `encryptedValue = encryptSecret(JSON.stringify({ privateKey, passphrase? }), key)` — passphrase omitted entirely from the JSON when absent (never `null`/`undefined` key), per D-15 and `SshCredential`'s own `exactOptionalPropertyTypes` contract.
**Decrypt → `SshCredential` mapping:**
```typescript
// Source: packages/ssh/src/ssh-port.ts's SshCredential type (existing, unchanged)
// type SshCredential =
//   | { kind: 'private_key'; privateKey: SecretValue; passphrase?: SecretValue }
//   | { kind: 'password'; password: SecretValue };
import { decryptSecret, secretValue, type EncryptedBlob } from '@noodara/domain/security';

function toSshCredential(row: CredentialRow, keyMap: ReadonlyMap<number, Buffer>): SshCredential {
  const plaintext = decryptSecret(row.encryptedValue as EncryptedBlob, keyMap);
  if (row.type === 'ssh_password') {
    return { kind: 'password', password: secretValue(plaintext, 'ssh_password') };
  }
  const parsed = JSON.parse(plaintext) as { privateKey: string; passphrase?: string };
  return parsed.passphrase === undefined
    ? { kind: 'private_key', privateKey: secretValue(parsed.privateKey, 'ssh_private_key') }
    : {
        kind: 'private_key',
        privateKey: secretValue(parsed.privateKey, 'ssh_private_key'),
        // No dedicated SecretKind exists for "key passphrase" — SecretKind is a closed union
        // ('ssh_password' | 'ssh_private_key' | 'master_key' | 'session_secret' | 'setup_token'
        // | 'api_key') and widening it is a packages/domain contract change 03-CONTEXT.md does
        // not list as an allowed exception this phase. Reuse 'ssh_private_key' for the
        // passphrase too — the redactor's [REDACTED:<kind>] label is cosmetic, and both values
        // protect the same key material.
        passphrase: secretValue(parsed.passphrase, 'ssh_private_key'),
      };
}
```
**Important:** `secretValue(raw, kind)` (from `packages/domain/src/security/secret-value.ts`) does **not** register anything with any `Redactor` — it is a pure wrapper. Registration only happens when something calls `revealSecret(secret, registry)`, which `@noodara/ssh`'s adapter does internally (see Pitfall 3). `credential-store.ts` does not need to touch `appRedactor` itself for the connect/discover path.

### Anti-Patterns to Avoid
- **Reaching past `SshPort`/`runDiscovery` into `packages/ssh` internals** (`key-loader.ts`, `ssh2-adapter.ts`, `commands/*`) from `apps/control-plane` — `packages/ssh/src/index.ts`'s own comment says this explicitly, and `run-discovery.test.ts`'s export-name test (`EXPECTED_RUNTIME_EXPORTS`) would need updating if any new export is added (see Open Question 1).
- **Assigning `Server.status` directly** anywhere in a service — every status change must route through `transition()` or `applyConnectionResult()`.
- **Building `activity_events` metadata with raw before/after values** for `server.updated` — D-16 explicitly forbids this (`changedFields: string[]` only). `buildActivityEvent`'s `SensitiveMetadataError` guard will catch a literal `password`/`credential` key, but it does **not** catch a plain host/port/name value sitting under an allowed key name — that is a code-review-time discipline, not a machine-enforced one.
- **Calling `session.close()` outside a `try/finally`** in `connectAndDiscover` — `runDiscovery` never closes the session itself (by design, documented in `run-discovery.ts`'s own header comment), so a thrown error between `connect()` succeeding and the service's own explicit `close()` call would otherwise leak the SSH credential registration in the redactor's registry for the life of the process (see Pitfall 3).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Server status transitions | A new switch/if-chain in a service | `transition()` / `applyConnectionResult()` from `packages/domain/src/server` | Already exhaustively tested (36 ordered pairs), already enforces the 3 reason-gated edges |
| Server name / host / port / SSH user validation | New regexes in a service | `validateServerName`, `validateHost`, `validateSshPort`, `validateSshUser` from `@noodara/domain/validators` | All four already exist and are tested; `validateServerName` in particular is unused until this phase but already built (Phase 1) |
| Credential encryption | New AES call in a service | `encryptSecret`/`decryptSecret` from `@noodara/domain/security` (`envelope.ts`) | Already handles nonce generation, `key_version`, tamper detection |
| Secret redaction in logs/errors/activity metadata | A new redaction pass | `appRedactor` (module singleton) + `writeActivityEvent`'s built-in `appRedactor.redact(event.metadata)` call | Already registers master key/auth secret at boot; SSH credentials are registered/released automatically by `@noodara/ssh`'s own session lifecycle |
| Host fingerprint string formatting | Custom `"<type> <hash>"` string building | `formatFingerprint`/`parseFingerprint` from `@noodara/ssh` | Exact inverse pair already implemented and tested against real `ssh-keygen -lf` output (ADR 0004) |
| Discovery check running | Re-implementing the 11-step sequence | `runDiscovery(input)` from `@noodara/ssh` | Already handles budget timeout, applicability (root vs non-root, Docker-absent skip), warnings, redaction of check details |
| "Only services write X" enforcement | A runtime guard/middleware | A static file-scan test, same shape as `packages/ssh/src/boundary.test.ts` | Zero runtime cost, matches the codebase's established enforcement style for exactly this kind of rule |

**Key insight:** Nothing in this phase requires new algorithmic logic beyond three or four small pure functions (`mergeDiscoveryFacts`, snapshot outcome classification, `classifyServerEdit`). Everything else is wiring together contracts Phase 1 and Phase 2 already built and tested. The temptation to re-validate SSH key format independently (rather than resolving Open Question 1) is the single highest-risk "hand-roll" trap in this phase.

## Common Pitfalls

### Pitfall 1: D-15's key-format validation has no supported entry point from `apps/control-plane`
**What goes wrong:** A service (`registerServer`/`editServer`) calls `packages/ssh/src/key-loader.ts`'s `loadPrivateKey` to validate a private key's format/type/RSA-bit-length before persisting it (as D-15 requires), but that function is not exported from `@noodara/ssh`'s public entrypoint.
**Why it happens:** `packages/ssh/src/index.ts`'s export list is deliberately narrow and enforced exact-match by `run-discovery.test.ts`'s `EXPECTED_RUNTIME_EXPORTS` test:
```typescript
// Source: packages/ssh/src/run-discovery.test.ts, lines ~463-470
const EXPECTED_RUNTIME_EXPORTS = [
  'COMMAND_NAMES', 'RETRYABLE_ERROR_CODES', 'commandFor', 'createSsh2Adapter',
  'formatFingerprint', 'parseFingerprint', 'runDiscovery',
] as const;
```
`loadPrivateKey`, `LoadPrivateKeyResult`, `InvalidCredentialError` and `ACCEPTED_KEY_TYPES` are all internal to `packages/ssh/src/key-loader.ts` and never re-exported. Meanwhile, 03-CONTEXT.md's phase-boundary paragraph states: *"`packages/ssh` y `packages/domain` no cambian de contrato en esta fase salvo la ampliación del union de acciones de `ActivityEvent` y las funciones puras que la denormalización necesite"* — an exception list that names only `packages/domain` changes, not `packages/ssh`.
**How to avoid:** This is a genuine tension between D-15 (locked) and the phase boundary (also locked) that research cannot resolve by re-deciding either — see Open Question 1 for the two concrete options and a recommendation.
**Warning signs:** A task plan that imports `key-loader.js` via a relative path reaching outside `packages/ssh/src/index.ts`'s exports, or a task that silently skips pre-persist key validation and only discovers a bad key at first `connectAndDiscover` (which would violate D-15's "devolviendo un error de validación claro" at registration time).

### Pitfall 2: `apps/control-plane` cannot import `@noodara/ssh` today
**What goes wrong:** `pnpm build`/`pnpm typecheck` fails, or `pnpm install` resolves the import to nothing, because `@noodara/ssh` is not in `apps/control-plane/package.json`'s `dependencies`.
**Why it happens:** Phase 2 built and tested `@noodara/ssh` entirely through `tests/integration/ssh/**` and unit tests inside `packages/ssh` itself — nothing in `apps/control-plane` ever imported it, so the dependency was never added. Root `package.json`'s `devDependencies` lists `@noodara/ssh` (for the top-level test harness only), which is a separate resolution scope from `apps/control-plane/package.json`'s own dependency graph.
**How to avoid:** First task in this phase: add `"@noodara/ssh": "workspace:*"` to `apps/control-plane/package.json`'s `dependencies`, run `pnpm install`, verify `turbo run build` picks up the new `dependsOn: ["^build"]` edge (packages/ssh already has a `turbo.json` with `"extends": ["//"]`, so the build-order dependency resolves automatically once the package.json dependency exists).
**Warning signs:** `Cannot find module '@noodara/ssh'` at typecheck or build time; a green `pnpm install --frozen-lockfile` in CI followed by a red `pnpm build`.

### Pitfall 3: The SSH credential's `Redactor` registration lifetime is owned by the *session*, not the service
**What goes wrong:** A service assumes it must manually `appRedactor.register(...)`/`appRedactor.release(...)` the decrypted SSH credential around the `connect()` call, duplicating or fighting the adapter's own lifecycle — or, worse, never calls `session.close()` on an error path, leaking the registration for the rest of the process's life.
**Why it happens:** `credential-store.ts`'s `secretValue(raw, kind)` wrapper does not register anything (confirmed: `packages/domain/src/security/secret-value.ts`'s `secretValue()` has no side effect). Registration happens only inside `@noodara/ssh`'s adapter, via `revealSecret(credential.X, redactor)`, called once per connect attempt (`loadPrivateKey`/`revealCredential` in `ssh2-adapter.ts`). **Release happens at `session.close()`**:
```typescript
// Source: packages/ssh/src/ssh2-adapter.ts, close():
function close(): Promise<void> {
  if (!sessionState.closed) {
    sessionState.closed = true;
    releaseRevealed(revealed, redactor); // WR-02: no longer needed once the session ends.
    ...
```
So the credential stays registered in `appRedactor`'s in-memory map for the **entire session lifetime** (connect through discovery through close) — this is intentional (SEC-05 needs discovery command output redacted against a credential that might echo into `stdout`/`stderr`). The service's only obligation is: (a) pass `appRedactor` (the app's one `Redactor` singleton) as `ConnectInput.redactor` and `RunDiscoveryInput.redactor`, and (b) **always** call `session.close()`, in a `finally` block, even when `runDiscovery` throws (it shouldn't — `runDiscovery` never throws by design — but a service bug or an unexpected rejection elsewhere must not skip `close()`).
**How to avoid:** Structure `connectAndDiscover` as:
```typescript
const outcome = await ssh.connect(connectInput);
if (!outcome.ok) { /* apply failure, no session to close */ return ...; }
try {
  const snapshot = await runDiscovery({ session: outcome.session, sshUser: target.user, timeouts, redactor: appRedactor });
  // ... persist snapshot + denormalize ...
} finally {
  await outcome.session.close();
}
```
**Warning signs:** A test asserting `appRedactor`'s internal registry size after a connect/discover cycle without also asserting it after a *failing* discovery — the `finally` block is exactly what the D-18 canary and any resource-leak-style unit test must exercise.

### Pitfall 4: `applyConnectionResult`/`transition` do not stamp the fingerprint-capture timestamps
**What goes wrong:** A service calls `applyConnectionResult` and assumes `host_fingerprint_captured_at`/`pending_fingerprint_seen_at` get set automatically, because `hostFingerprint`/`pendingFingerprint` do.
**Why it happens:** `ServerConnectionState` (the type `applyConnectionResult` operates on) has no `hostFingerprintCapturedAt`/`pendingFingerprintSeenAt` fields at all:
```typescript
// Source: packages/domain/src/server/connection-result.ts
export interface ServerConnectionState {
  status: ServerStatus;
  lastErrorCode: ServerErrorCode | null;
  hostFingerprint: string | null;
  pendingFingerprint: string | null;
  lastSeenAt: Date | null;
}
```
These two timestamp columns exist only on the Drizzle `servers` table (added in Phase 2's migration 0002) and are entirely the service's own responsibility to stamp.
**How to avoid:** After calling `applyConnectionResult`, the service must separately check:
- `outcome.ok && outcome.fingerprintCaptured` (from `ConnectOutcome`, `packages/ssh`) → set `hostFingerprintCapturedAt = now`.
- `!outcome.ok && outcome.errorCode === 'HOST_KEY_CHANGED' && outcome.observedFingerprint !== undefined` → set `pendingFingerprintSeenAt = now`.
Also note `ConnectOutcome.fingerprint`/`observedFingerprint` are `HostFingerprint` objects (`{ keyType, fingerprint }`), while `ConnectionResult.fingerprint`/`observedFingerprint` (what `applyConnectionResult` consumes) and the `servers.host_fingerprint`/`pending_fingerprint` columns are plain strings — the service must call `formatFingerprint(outcome.fingerprint)` to bridge the two.
**Warning signs:** A test asserting `host_fingerprint_captured_at` is set after a first successful connect that only checks `applyConnectionResult`'s return value, not the persisted row.

### Pitfall 5: `entity_id` in `activity_events` is a `uuid` column, and `server.deleted` writes after the server row still exists
**What goes wrong:** Assuming `entityId` must be a validated/looked-up foreign key, or writing `server.deleted` after the `DELETE` (making the row lookup for `entityType`/name metadata impossible).
**Why it happens:** `activity_events.entity_id` is declared `uuid('entity_id')` with **no FK constraint** (comment: *"No FK to `users`: an audit trail must survive the actor being deleted"* — the same reasoning applies to `entity_id` referencing a deleted server). D-14 requires `server.deleted` to be written **before** the `DELETE FROM servers`, inside the same transaction, specifically so the event's metadata (`{ name, host }`) can still be read off the live row.
**How to avoid:** In `deleteServer`, order operations: (1) `SELECT` the server row (need `name`/`host` for D-16's `server.deleted` metadata and D-12's confirm-by-name check), (2) `writeActivityEvent(tx, { action: 'server.deleted', entityId: server.id, metadata: { name: server.name, host: server.host }, ... })`, (3) `DELETE FROM credentials WHERE id = server.credentialId`, (4) `DELETE FROM servers WHERE id = server.id` (cascades `discovery_snapshots` automatically per the FK `ON DELETE CASCADE` added in migration 0003).
**Warning signs:** A `NOT NULL`/FK constraint violation on `activity_events.entity_id` after a delete (should never happen, since there is no FK — but a test that expects one would be testing the wrong thing).

### Pitfall 6: Migration 0003's unique indexes need `sql` expression columns, not plain column refs
**What goes wrong:** Writing `uniqueIndex('servers_name_unique').on(servers.name)` (case-sensitive) instead of a `lower(name)` expression index, silently failing D-10's case-insensitive uniqueness requirement.
**Why it happens:** Drizzle's `uniqueIndex(...).on(...)` accepts either column references or `SQL` fragments (confirmed against the installed `drizzle-orm@0.45.2` type declarations: `IndexBuilderOn.on(...columns: [Partial<ExtraConfigColumn> | SQL, ...])`), but a plain column reference produces a literal-value index, not an expression index.
**How to avoid:**
```typescript
import { sql } from 'drizzle-orm';
import { uniqueIndex } from 'drizzle-orm/pg-core';

export const servers = pgTable('servers', { /* ...existing columns..., */ }, (table) => [
  uniqueIndex('servers_name_lower_unique_idx').on(sql`lower(${table.name})`),
  uniqueIndex('servers_host_port_unique_idx').on(table.host, table.sshPort),
]);
```
`pnpm --filter @noodara/control-plane db:generate` (drizzle-kit 0.31.10) will emit the correct `CREATE UNIQUE INDEX ... ON "servers" (lower("name"))` SQL from this schema declaration — verified against drizzle-kit's own strict-mode diffing, which already handles expression indexes for the `IndexBuilder` type.
**Warning signs:** A migration test that inserts `srv-1` and `SRV-1` (or `Srv-1`) and expects a `NAME_TAKEN` conflict, passing against a plain non-expression index only because the test happened to use identical case.

### Pitfall 7: Double-transition edges for D-02's mid-discovery failure require `transition()` a second time in the same call
**What goes wrong:** Treating "connect succeeded, discovery failed" as a single state assignment, or reusing `applyConnectionResult` (which only accepts a result while `status === 'CONNECTING'`) for the second transition.
**Why it happens:** `applyConnectionResult` throws `InvalidTransitionError` if called while the server is already `CONNECTED` — by design (*"Only accepts results while the server is CONNECTING"*). D-02 requires a **second**, separate call after the first transition already landed on `CONNECTED`:
```typescript
// Source: packages/domain/src/server/server-state.ts's TRANSITIONS table
// CONNECTED: ['CONNECTING', 'DISCONNECTED', 'UNREACHABLE', 'ERROR', 'PENDING'],
```
Both `CONNECTED → ERROR` (discovery `COMMAND_TIMEOUT`) and `CONNECTED → UNREACHABLE` (discovery `CONNECTION_LOST`) are unconditional edges (no `TransitionReason` required) already present in the table — confirmed directly against `server-state.ts`. So the service calls `transition('CONNECTED', 'ERROR')` or `transition('CONNECTED', 'UNREACHABLE')` directly (not `applyConnectionResult` a second time), then separately sets `lastErrorCode`.
**How to avoid:** Model `connectAndDiscover` as two sequential, independent status-mutation steps: step 1 (`applyConnectionResult` from the connect outcome), step 2 (conditionally, `transition()` directly from the post-connect status if discovery itself failed with `COMMAND_TIMEOUT`/`CONNECTION_LOST`). A discovery run that only produced warnings (`UNSUPPORTED_OS`, Docker absent) does **not** trigger step 2 — it stays `CONNECTED` per D-02, setting `last_error_code = 'UNSUPPORTED_OS'` only when that specific warning is present.
**Warning signs:** A test for "discovery times out mid-run" that asserts the server ends in `CONNECTING` (the pre-connect-outcome status) instead of `ERROR`.

## Code Examples

### `ServerView` projection (D-19)
```typescript
// The shape every mutating service returns and the future GET route serializes unchanged.
export interface ServerView {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly status: ServerStatus; // from @noodara/domain/server
  readonly hostFingerprint: string | null;
  readonly hostFingerprintCapturedAt: Date | null;
  readonly pendingFingerprint: string | null;
  readonly pendingFingerprintSeenAt: Date | null;
  readonly hostname: string | null;
  readonly osDistribution: string | null;
  readonly osVersion: string | null;
  readonly arch: string | null;
  readonly cpuCores: number | null;
  readonly ramMb: number | null;
  readonly diskTotalMb: number | null;
  readonly diskUsedMb: number | null;
  readonly uptimeSeconds: number | null;
  readonly dockerInstalled: boolean | null;
  readonly dockerVersion: string | null;
  readonly dockerComposeVersion: string | null; // new column, migration 0003
  readonly lastSeenAt: Date | null;
  readonly lastErrorCode: ServerErrorCode | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly credentialType: 'ssh_private_key' | 'ssh_password';
  // Deliberately absent: credentialId, encryptedValue, or anything credential-shaped.
}

// D-19's own unit test: assert the key list never contains a credential-shaped field.
const FORBIDDEN_KEYS = ['credentialId', 'encryptedValue', 'keyVersion', 'password', 'privateKey', 'passphrase'];
it('ServerView never carries a credential field', () => {
  const view: ServerView = buildServerView(/* fixture */);
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.keys(view)).not.toContain(key);
  }
});
```
All source fields for `ServerView` (aside from `credentialType`) are taken 1:1 from `apps/control-plane/src/db/schema/servers.ts`'s existing columns [VERIFIED: apps/control-plane/src/db/schema/servers.ts] plus the new `dockerComposeVersion` column this phase adds.

### `mergeDiscoveryFacts` pure function (Claude's Discretion, `packages/domain`)
```typescript
// Source location: packages/domain/src/discovery/merge-facts.ts (new)
import type { DiscoveryFacts } from './types.js';

/** D-07: a null fact never overwrites a previously-known value. */
export function mergeDiscoveryFacts(current: DiscoveryFacts, incoming: DiscoveryFacts): DiscoveryFacts {
  const merged = { ...current };
  for (const key of Object.keys(incoming) as (keyof DiscoveryFacts)[]) {
    const value = incoming[key];
    if (value !== null) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export type SnapshotOutcome = 'ok' | 'partial' | 'failed';

/** Classifies a DiscoverySnapshot.checks array per D-06's outcome enum. */
export function classifySnapshotOutcome(checks: readonly { status: string }[]): SnapshotOutcome {
  const relevant = checks.filter((c) => c.status !== 'skipped' && c.status !== 'not_applicable');
  if (relevant.length === 0) return 'failed'; // nothing ran at all
  const failed = relevant.filter((c) => c.status === 'fail').length;
  if (failed === 0) return 'ok';
  if (failed === relevant.length) return 'failed';
  return 'partial';
}
```
Note: for a brand-new `Server` (first discovery), `current` is the all-null `emptyFacts()`-shaped row `servers` starts with — `mergeDiscoveryFacts` handles this the same as any subsequent merge (no special-case needed, since `current` starting all-null means every non-null incoming fact simply wins).

### `classifyServerEdit` pure function (Claude's Discretion, `packages/domain`)
```typescript
// Source location: packages/domain/src/server/classify-edit.ts (new)
export type EditClassification = 'none' | 'identity' | 'access';

export interface ServerIdentityFields {
  readonly host: string;
  readonly sshPort: number;
}
export interface ServerAccessFields {
  readonly sshUser: string;
  readonly credentialReplaced: boolean;
}

/** D-14 (Phase 1): host/port changes are an identity change (CONNECTED -> PENDING,
 *  reason 'identity_changed'); SSH user or credential-only changes are an access change
 *  (CONNECTED -> DISCONNECTED, reason 'clean_close'); no relevant field changed is 'none'. */
export function classifyServerEdit(
  before: ServerIdentityFields & ServerAccessFields,
  after: ServerIdentityFields & ServerAccessFields,
): EditClassification {
  if (before.host !== after.host || before.sshPort !== after.sshPort) return 'identity';
  if (before.sshUser !== after.sshUser || after.credentialReplaced) return 'access';
  return 'none';
}
```
Cross-check against the transition table's reason-gated edges (`server-state.ts`, quoted in full above): `CONNECTED → PENDING` requires `'identity_changed'`, `CONNECTED → DISCONNECTED` requires `'clean_close'` — `editServer` calls `transition(current, 'PENDING', { reason: 'identity_changed' })` or `transition(current, 'DISCONNECTED', { reason: 'clean_close' })` based on this classification's result, only when the server was `CONNECTED` at edit time (any other starting status has no analogous edge and the edit is a plain field update with no transition).

### The `security:scan-leaks` script already targets the exact file to extend
```json
// Source: package.json (root), line 21
"security:scan-leaks": "vitest run --config vitest.integration.config.ts tests/integration/activity/canary.test.ts"
```
D-18's full-flow canary is heavier (spins up a real sshd Testcontainer, runs the entire register→connect→discover→edit→trust→delete sequence) than the existing lightweight `canary.test.ts` (no containers, ~seconds). Recommendation: add it as a **new, separate file** `tests/integration/activity/canary-full-flow.test.ts` (co-located with the existing canary for discoverability) and widen the script to a glob:
```json
"security:scan-leaks": "vitest run --config vitest.integration.config.ts tests/integration/activity/canary.test.ts tests/integration/activity/canary-full-flow.test.ts"
```
This keeps the fast, container-free Phase-1 canary fast, and groups the two logically without one file's growth slowing down the other during local iteration. (`vitest.integration.config.ts` already sets `fileParallelism: false`, so there is no parallelism benefit either way — this is purely about keeping the file focused and the existing test's own docstring, which already anticipated "the full flow-driven scan... arrives with SEC-02 (phase 3)", intact rather than rewritten.)

### Boundary test for "only services write activity events" (Claude's Discretion, ACT-01 enforcement)
Directly modeled on the existing `packages/ssh/src/boundary.test.ts` (quoted in full during research) — same file-walk + regex-import-scan technique, scoped to forbid `writeActivityEvent`/`activityEvents` imports outside `apps/control-plane/src/{services,activity}/`:
```typescript
// Source location: apps/control-plane/src/activity/boundary.test.ts (new)
// Mirrors packages/ssh/src/boundary.test.ts's listTsFiles/importSpecifiers helpers exactly.
const ALLOWED_DIRS = ['apps/control-plane/src/services/', 'apps/control-plane/src/activity/'];
// ... walk apps/control-plane/src/**/*.ts (excluding *.test.ts, dist, node_modules),
// assert no file outside ALLOWED_DIRS imports 'writeActivityEvent' or '../db/schema/activity-events.js' ...
```

## State of the Art

Not applicable — every technology in this phase is already pinned and proven working in this codebase (Drizzle 0.45.2, drizzle-kit 0.31.10, Vitest 5, Testcontainers). No library upgrade or deprecated-pattern concern was found during this research pass.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | `loadPrivateKey` should be exported from `packages/ssh/src/index.ts` as the resolution to Pitfall 1/Open Question 1 (rather than re-implementing key validation in `packages/domain`) | Pitfall 1, Open Question 1 | If the user/planner instead chooses to re-implement validation, `ACCEPTED_KEY_TYPES`/`RSA_MIN_MODULUS_BITS` would need to be duplicated and kept in sync manually — a real but bounded maintenance cost, not a correctness risk either way |
| A2 | The SSH-key passphrase `SecretValue` should reuse `SecretKind: 'ssh_private_key'` rather than widening `SecretKind` with a new value | Pattern 4 (credential-store.ts) | Low risk: `SecretKind` only affects the cosmetic `[REDACTED:<kind>]` label; no behavioral difference. A future phase could still widen it without breaking this phase's code |
| A3 | `tests/integration/activity/canary-full-flow.test.ts` (new file) is the right home for D-18's canary, vs. extending `canary.test.ts` in place | Code Examples, "security:scan-leaks" | Low risk: purely organizational; either choice satisfies D-18's requirements as long as `security:scan-leaks` is updated to cover it |
| A4 | `SELECT ... FOR UPDATE` (blocking, not `NOWAIT`) satisfies D-05's `ALREADY_CONNECTING` requirement, since the decision text does not specify NOWAIT semantics | Pattern 2 | Low risk: a blocking wait still produces the correct `ALREADY_CONNECTING` result once the lock is released, just with slightly higher latency for the losing request than a `NOWAIT` immediate-fail would give |

**If this table is empty:** N/A — see entries above. All four are low-risk, bounded-impact judgment calls, not compliance/security-critical unknowns; none block planning.

## Open Questions (RESOLVED)

1. **RESOLVED in plan 03-01 Task 2 (additive export of `loadPrivateKey`, `LoadPrivateKeyResult`, `InvalidCredentialError`, `PrivateKeyCredential`).** How does `registerServer`/`editServer` satisfy D-15's "valida formato y tipo de clave con las reglas de packages/ssh" given `loadPrivateKey` is not in `@noodara/ssh`'s public surface, and 03-CONTEXT.md's phase-boundary text states `packages/ssh`'s contract does not change this phase?**
   - What we know: `loadPrivateKey` (format/type/RSA-bit-length validation, D-01 of Phase 2) exists, is pure (no I/O), and is exactly the logic D-15 asks the service to reuse. It is not exported. `packages/ssh/src/index.ts`'s export list is guarded by an exact-match test (`run-discovery.test.ts`'s `EXPECTED_RUNTIME_EXPORTS`).
   - What's unclear: whether "no cambian de contrato" in 03-CONTEXT.md's phase boundary was written with this specific function in mind, or whether it only meant "no *behavioral* change to `SshPort`/`runDiscovery`" (in which case *adding* an export, with zero behavior change to anything existing, would not violate the spirit of that sentence).
   - Recommendation: **Export `loadPrivateKey`, `LoadPrivateKeyResult`, and `InvalidCredentialError` from `packages/ssh/src/index.ts`.** This is additive-only (no existing export changes shape), requires updating exactly one test's expected-exports array (`run-discovery.test.ts`), and is the only option that lets D-15 literally reuse "the rules of `packages/ssh`" rather than duplicating them. Flag this as a one-line phase-boundary amendment for the user/planner to confirm rather than silently deciding it — it is a real, if narrow, deviation from CONTEXT.md's stated scope.

2. **RESOLVED in plan 03-10 (new file `tests/integration/activity/canary-full-flow.test.ts`, `security:scan-leaks` widened to both canaries).** Should the D-18 full-flow canary live in a new file or extend `canary.test.ts` in place?**
   - What we know: the existing file's own comment already anticipates this exact expansion ("The full flow-driven scan covering SSH stdout/stderr and AI prompts arrives with SEC-02 (phase 3)"), and the `security:scan-leaks` script currently names the one file explicitly.
   - What's unclear: no locked decision states which; this is purely organizational.
   - Recommendation: new file (`canary-full-flow.test.ts`), script widened to a two-file glob — see Code Examples. Low-stakes either way; flagged only so the planner picks one deliberately rather than by accident.

## Environment Availability

No new external dependency is introduced. Docker (for Testcontainers — Postgres and the Phase 2 sshd image variants) and PostgreSQL access were already verified available and working in Phase 1/Phase 2 CI and local runs (`02-VALIDATION.md`: `status: approved`, all scenarios green against real containers). This phase reuses the same `tests/integration/helpers/{postgres,ssh}.ts` fixtures with no new infrastructure need.

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Docker (Testcontainers) | `startPostgres()`, `startSshd()` (both reused, unchanged) | ✓ (proven in Phase 1/2) | — | — |
| PostgreSQL 17 (via Testcontainers) | Migration tests, service integration tests | ✓ | `postgres:17-alpine` | — |
| Real `sshd` fixture images | D-18's full-flow canary | ✓ (built in Phase 2, `tests/integration/images/`) | Ubuntu 22.04/24.04 variants | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|---|---|
| Framework | Vitest 5.0.0 (`vitest.config.ts` for unit, `vitest.integration.config.ts` for Testcontainers-backed integration) |
| Config file | `vitest.config.ts` (unit, coverage-gated ≥95% stmt/branch for `packages/domain/**`), `vitest.integration.config.ts` (integration, `testTimeout: 120_000`, `fileParallelism: false`) |
| Quick run command | `pnpm test` (unit only, no Docker required) |
| Full suite command | `pnpm test && pnpm test:integration` (integration requires Docker) |
| Security-canary command | `pnpm security:scan-leaks` (already wired into CI's `security` job) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| SERV-01 | Register server, credential encrypted, never plaintext in result | unit | `pnpm test -- register-server` | ❌ Wave 0 |
| SERV-02 | Edit server, credential replaced in place, never shown | unit + integration | `pnpm test -- edit-server` / `pnpm test:integration -- tests/integration/ssh` (credential-replace-then-connect round trip) | ❌ Wave 0 |
| SERV-03 | Delete server, name confirmation, cascade credential+snapshots, event before delete | unit | `pnpm test -- delete-server` | ❌ Wave 0 |
| SEC-02 | No credential leaks via logs/API/errors/activity/snapshots | integration | `pnpm security:scan-leaks` (extended) | ⚠️ existing file extended, new file for full-flow variant — Wave 0 |
| DISC-03 | Snapshot append-only + denormalization, same operation | unit (`mergeDiscoveryFacts`, `classifySnapshotOutcome`) + integration (`connectAndDiscover` against real sshd) | `pnpm test -- merge-facts` / `pnpm test:integration -- connect-and-discover` | ❌ Wave 0 |
| ACT-01 | Typed `server.*` events, services-only enforcement | unit (`activity-event.test.ts` widened) + boundary test | `pnpm test -- activity-event` / `pnpm test -- boundary` | ❌ Wave 0 (boundary test), ✅ existing file widened |
| QA-06 (migration) | 0003 applies from scratch and from 0002 snapshot | integration | `pnpm test:integration -- migrations` | ✅ `tests/integration/db/migrations.test.ts` exists, extend `EXPECTED_TABLES`/`EXPECTED_ENUMS` and `representative-data.ts` |

### Sampling Rate
- **Per task commit:** `pnpm test` (unit, fast, no Docker)
- **Per wave merge:** `pnpm test:integration` (Docker required, ~9+ minutes warm per Phase 2's measured baseline of 555s for a smaller suite — expect this phase's addition to add several more minutes given the full-flow canary spins up a fresh sshd container)
- **Phase gate:** `pnpm test`, `pnpm test:integration`, `pnpm security:scan-leaks`, `pnpm lint`, `pnpm typecheck`, `pnpm exec turbo boundaries` all green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/control-plane/src/services/credential-store.ts` + `.test.ts` — no file exists yet
- [ ] `apps/control-plane/src/services/register-server.ts` / `edit-server.ts` / `delete-server.ts` / `connect-and-discover.ts` / `trust-fingerprint.ts` + tests — none exist yet
- [ ] `apps/control-plane/src/services/server-view.ts` + test (D-19's key-list assertion) — none exists
- [ ] `apps/control-plane/src/activity/boundary.test.ts` — none exists
- [ ] `packages/domain/src/discovery/merge-facts.ts` + `.test.ts` — none exists
- [ ] `packages/domain/src/server/classify-edit.ts` + `.test.ts` — none exists
- [ ] `apps/control-plane/src/db/schema/discovery-snapshots.ts` — none exists
- [ ] `apps/control-plane/src/db/migrations/0003_*.sql` (generated via `db:generate`, not hand-written) — none exists
- [ ] `tests/integration/activity/canary-full-flow.test.ts` (or equivalent) — none exists
- [ ] `apps/control-plane/package.json`'s `@noodara/ssh` dependency — missing, blocks everything else in this list from typechecking

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | No (this phase does not touch auth) | — |
| V3 Session Management | No | — |
| V4 Access Control | Partial — D-11's `SERVER_BUSY` on edit/delete-while-`CONNECTING` is a resource-state access control, not identity-based | `transition()`/row-status check inside the transaction, never a UI-only guard |
| V5 Input Validation | Yes | `validateHost`/`validateSshPort`/`validateSshUser`/`validateServerName` (all existing, `@noodara/domain/validators`) + D-15's private-key format validation (Open Question 1) |
| V6 Cryptography | Yes | `encryptSecret`/`decryptSecret` (`@noodara/domain/security`, AES-256-GCM, already built and tested — never hand-rolled here) |
| V7 Error Handling & Logging | Yes | `writeActivityEvent`'s `appRedactor.redact(metadata)` call, `toLogSafe()`, pino `redact.paths` — all already built |
| V9 Communications (transport) | Out of phase scope | SSH transport security is `@noodara/ssh`'s domain (Phase 2, unchanged) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Credential leak via activity log metadata | Information Disclosure | `SensitiveMetadataError` guard (key-name-based, already built) + `appRedactor.redact()` (value-based, already built) — D-18's canary proves both hold for a real SSH flow |
| Double-dispatch race on connect (two jobs racing the same server) | Tampering / Denial of Service (inconsistent state) | D-05's `SELECT ... FOR UPDATE` + `ALREADY_CONNECTING` conflict response |
| Host key substitution (MITM) not re-detected after a legitimate rebuild | Spoofing | Already mitigated by Phase 1/2's TOFU + `HOST_KEY_CHANGED` + explicit `trustFingerprint` re-confirmation (D-04, this phase only adds the service call, no new logic) |
| SQL injection via server name/host in a raw query | Tampering | Not applicable — every query in this phase uses Drizzle's parameterized query builder (`eq()`, `sql\`\`` template literals with proper parameter binding), never string concatenation |
| Command injection via server name reaching an SSH command template | Tampering | Already mitigated by Phase 2's allowlist (`packages/ssh/src/commands`) — server-provided values never reach a command template; `validateServerName`'s slug pattern additionally rejects shell metacharacters at the domain layer before persistence |

## Sources

### Primary (HIGH confidence — all read in full during this research session, this repo's own committed source)
- `packages/ssh/src/ssh-port.ts`, `run-discovery.ts`, `index.ts`, `key-loader.ts`, `ssh2-adapter.ts` (partial), `fingerprint.ts`, `commands/index.ts`
- `packages/domain/src/server/server-state.ts`, `connection-result.ts`, `index.ts`
- `packages/domain/src/discovery/types.ts`, `index.ts`
- `packages/domain/src/activity/activity-event.ts`
- `packages/domain/src/security/envelope.ts`, `secret-value.ts`, `redactor.ts`, `index.ts`
- `packages/domain/src/validators/network.ts`, `identity.ts`, `index.ts`
- `apps/control-plane/src/activity/write-activity-event.ts`, `redaction.ts`
- `apps/control-plane/src/db/schema/servers.ts`, `credentials.ts`, `activity-events.ts`, `index.ts`
- `apps/control-plane/src/services/setup-service.ts`, `session-service.ts`, `setup-token-repository.ts`
- `apps/control-plane/src/env.ts`, `db/client.ts`, `package.json`
- `apps/control-plane/src/db/migrations/0000_*.sql`, `0001_*.sql`, `0002_*.sql`, `meta/_journal.json`
- `apps/control-plane/drizzle.config.ts`
- `tests/integration/helpers/migrations.ts`, `postgres.ts`, `app.ts`, `ssh.ts`
- `tests/integration/fixtures/representative-data.ts`
- `tests/integration/db/migrations.test.ts`
- `tests/integration/activity/canary.test.ts`
- `packages/ssh/src/boundary.test.ts`, `packages/domain/src/purity.test.ts`
- `packages/ssh/src/run-discovery.test.ts` (export-surface assertion)
- `vitest.config.ts`, `vitest.integration.config.ts`, `turbo.json`, `packages/domain/turbo.json`, `packages/ssh/turbo.json`, root `package.json`
- `.github/workflows/ci.yml`
- `docs/domain/server-state-transitions.md`, `docs/adr/0004-ssh-adapter-empirical-contracts.md` (partial)
- `.claude/skills/noodara-domain-model/SKILL.md`, `noodara-security/SKILL.md`, `noodara-tdd/SKILL.md`
- `.planning/phases/03-.../03-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md`
- `.planning/phases/01-.../01-17-SUMMARY.md`, `.planning/phases/02-.../02-10-SUMMARY.md`
- `.planning/research/ARCHITECTURE.md` (§3, §4, §5, §6), `.planning/research/PITFALLS.md` (Pitfalls 2, 9, 10)
- `node_modules/.../drizzle-orm@0.45.2/pg-core/indexes.d.ts`, `select.types.d.ts` (installed type declarations, confirming `uniqueIndex`/`.for('update')` API shapes)

### Secondary (MEDIUM confidence)
None — this research required no web search; every fact needed was directly verifiable in the committed codebase or installed package type declarations.

### Tertiary (LOW confidence)
None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new external packages, every internal contract read directly from source
- Architecture: HIGH — directly extends two already-proven service patterns (setup-service.ts, session-service.ts) with no new architectural style
- Pitfalls: HIGH — all seven are concrete facts observed in the actual source (missing export, missing dependency, timestamp fields absent from a type, column nullability, index API shape, transition table edges), not speculative

**Research date:** 2026-09-15
**Valid until:** Until Phase 3 is planned and executed (this research is tightly coupled to the exact commit state of Phase 1/2's deliverables; if either phase's code changes before Phase 3 executes, re-verify the quoted signatures)
