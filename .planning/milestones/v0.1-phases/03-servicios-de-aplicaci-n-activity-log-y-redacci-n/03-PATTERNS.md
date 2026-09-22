# Phase 3: Servicios de aplicación, activity log y redacción - Pattern Map

**Mapped:** 2026-09-15
**Files analyzed:** 20 (10 apps/control-plane services/activity, 2 domain pure functions, 1 domain type widening, 2 db schema/migration, 5 tests)
**Analogs found:** 20 / 20 (every file has at least a role-match analog; 3 have exact analogs)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/control-plane/src/services/credential-store.ts` | service (helper) | transform (encrypt/decrypt) | `packages/domain/src/security/envelope.ts` (crypto it wraps) + `packages/ssh/src/ssh-port.ts` (`SshCredential` target type) | role-match (no existing file wraps envelope↔credential; wiring pattern is new but the two halves it bridges are exact) |
| `apps/control-plane/src/services/server-view.ts` | transform / projection | transform | none in-repo (new projection concept) — shape given verbatim in RESEARCH.md Code Examples | no analog (see below) |
| `apps/control-plane/src/services/register-server.ts` | service | CRUD (create) | `apps/control-plane/src/services/setup-service.ts` (`redeemSetupToken`) | exact |
| `apps/control-plane/src/services/edit-server.ts` | service | CRUD (update) | `apps/control-plane/src/services/setup-service.ts` (transactional result pattern) + `packages/domain/src/server/server-state.ts` (`transition` with reason) | exact |
| `apps/control-plane/src/services/delete-server.ts` | service | CRUD (delete) | `apps/control-plane/src/services/session-service.ts` (`revokeSession` — lookup, ownership/guard check, transaction with `writeActivityEvent` then delete) | exact |
| `apps/control-plane/src/services/connect-and-discover.ts` | service | event-driven / orchestration (SSH session + state machine) | `apps/control-plane/src/services/setup-service.ts` (`redeemSetupToken`'s advisory-lock-then-transaction shape) + `packages/ssh/src/run-discovery.ts` (session lifecycle it orchestrates) | role-match (no existing service opens an SSH session; transactional/lock shape is exact, SSH orchestration is new composition of already-built primitives) |
| `apps/control-plane/src/services/trust-fingerprint.ts` | service | CRUD (update, single-field) | `apps/control-plane/src/services/edit-server.ts` (sibling, same phase) / `apps/control-plane/src/services/setup-service.ts` (transactional result + `transition` with reason) | exact |
| `apps/control-plane/src/activity/boundary.test.ts` | test (boundary/static) | transform (file-walk + regex) | `packages/ssh/src/boundary.test.ts` (ssh2 containment) / `packages/domain/src/purity.test.ts` (import-scan) | exact |
| `packages/domain/src/discovery/merge-facts.ts` | utility (pure) | transform | `packages/domain/src/server/connection-result.ts` (`applyConnectionResult` — pure, no-mutation merge over a state shape) | role-match |
| `packages/domain/src/discovery/merge-facts.test.ts` | test (unit) | transform | `packages/domain/src/server/connection-result.test.ts` | exact |
| `packages/domain/src/server/classify-edit.ts` | utility (pure) | transform | `packages/domain/src/server/connection-result.ts` (`statusForErrorCode` — pure lookup/classification function) | exact |
| `packages/domain/src/server/classify-edit.test.ts` | test (unit) | transform | `packages/domain/src/server/connection-result.test.ts` | exact |
| `packages/domain/src/activity/activity-event.ts` (MODIFIED — widen union) | model (domain type) | transform | itself, prior version (`AUTH_ACTIONS` → add `SERVER_ACTIONS`) | exact (same file, additive change) |
| `packages/domain/src/activity/activity-event.test.ts` (MODIFIED) | test (unit) | transform | itself, prior version | exact |
| `apps/control-plane/src/db/schema/discovery-snapshots.ts` | model (Drizzle schema) | CRUD (append-only insert) | `apps/control-plane/src/db/schema/activity-events.ts` (append-only, jsonb metadata, FK-less-by-design pattern is close; but `discovery_snapshots` DOES have an FK) / `apps/control-plane/src/db/schema/credentials.ts` (has FK-owning sibling table for `id`/timestamps shape) | role-match |
| `apps/control-plane/src/db/schema/servers.ts` (MODIFIED — add `docker_compose_version` + 2 unique indexes) | model (Drizzle schema) | CRUD | itself, prior version (migration 0002's precedent of additive nullable columns) | exact |
| `apps/control-plane/src/db/migrations/0003_*.sql` | migration | batch | `apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql` (simplest precedent) + `0000_shiny_franklin_storm.sql` (table-creation + index precedent) | exact |
| `tests/integration/db/migrations.test.ts` (MODIFIED — extend `EXPECTED_TABLES`/`EXPECTED_ENUMS`, snapshot fetch) | test (integration) | batch | itself, prior version (already has the exact two-step "before 0002 / after 0002" pattern to replicate for 0003) | exact |
| `tests/integration/fixtures/representative-data.ts` (MODIFIED) | test fixture | batch | itself, prior version | exact |
| `tests/integration/activity/canary-full-flow.test.ts` | test (integration, security) | event-driven (full flow) | `tests/integration/activity/canary.test.ts` (canary structure) + `tests/integration/helpers/ssh.ts`/`app.ts` (sshd container + app fixture) | exact (structure) / role-match (this file is heavier — spins up sshd, not just Postgres) |

## Pattern Assignments

### `apps/control-plane/src/services/register-server.ts`, `edit-server.ts`, `trust-fingerprint.ts` (service, CRUD)

**Analog:** `apps/control-plane/src/services/setup-service.ts` (`redeemSetupToken`, lines 62-126)

**Imports pattern** (setup-service.ts lines 13-22):
```typescript
import { eq, sql } from 'drizzle-orm';
import { hashSetupToken, isTokenUsable } from '@noodara/domain/security';
import { validateEmail, validatePassword } from '@noodara/domain/validators';
import { auth } from '../auth/auth.js';
import { runInBootstrap } from '../auth/bootstrap-context.js';
import { hashPassword } from '../auth/password-hasher.js';
import { writeActivityEvent, type ActivityWriteHandle } from '../activity/write-activity-event.js';
import { getDb } from '../db/client.js';
import { accounts, sessions, users } from '../db/schema/auth.js';
import { findUsableByHash, markUsed } from './setup-token-repository.js';
```
For register/edit/trust-fingerprint, swap in: `validateServerName`, `validateHost`, `validateSshUser` from `@noodara/domain/validators`; `transition`, `applyConnectionResult` from `@noodara/domain/server`; `servers`, `credentials` from `../db/schema/servers.js`/`credentials.js`; `writeActivityEvent` unchanged.

**Result-type pattern** (setup-service.ts lines 37-39):
```typescript
export type RedeemSetupTokenResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly code: RedeemSetupTokenFailureCode; readonly message: string };
```
Every new service (`RegisterServerResult`, `EditServerResult`, `DeleteServerResult`, `ConnectAndDiscoverResult`, `TrustFingerprintResult`) returns this exact discriminated shape — 03-CONTEXT.md's Claude's Discretion note names this file explicitly as the pattern to follow.

**Transaction + early-return-on-failure + writeActivityEvent-inside-tx pattern** (setup-service.ts lines 66-125):
```typescript
export async function redeemSetupToken(input: RedeemSetupTokenInput): Promise<RedeemSetupTokenResult> {
  const now = input.now ?? new Date();
  const db = await getDb();

  return db.transaction(async (tx) => {
    // ... each validation/lookup returns early: { ok: false, code, message } ...
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
`register-server.ts` follows this shape exactly: open `db.transaction`, validate fields with `validateServerName`/`validateHost`/`validateSshPort`/`validateSshUser` (early `{ ok: false, code, message }` return per failure), encrypt the credential via `credential-store.ts`, insert `credentials` then `servers`, catch unique-violation as `NAME_TAKEN`/`HOST_TAKEN` (D-10's "captura de la violación de unicidad como red de seguridad" — Postgres error code `23505`), write `server.created`, return `{ ok: true, server: ServerView }`.

**Validators to reuse (no re-implementation)** — `packages/domain/src/validators/identity.ts` lines 26-45:
```typescript
export function validateServerName(input: string): ValidationResult<string> { ... }
export function validateSshUser(input: string): ValidationResult<string> { ... }
```
`validateServerName` already exists (RESEARCH.md's gap #3 — do not rebuild it). `validateHost`/`validateSshPort` live in `packages/domain/src/validators/network.ts` (same `ValidationResult<T>` shape, `ok`/`fail` helpers).

**`editServer`'s transition-with-reason call site** — `packages/domain/src/server/server-state.ts` lines 92-107, `classifyServerEdit` result feeds directly into it:
```typescript
// CONNECTED->PENDING requires reason 'identity_changed'; CONNECTED->DISCONNECTED requires 'clean_close'.
transition(current.status, 'PENDING', { reason: 'identity_changed' });
transition(current.status, 'DISCONNECTED', { reason: 'clean_close' });
```

**`trustFingerprint`'s transition-with-reason call site** — same `server-state.ts`, `ERROR->PENDING` requires `'fingerprint_trusted'` (line 52):
```typescript
transition('ERROR', 'PENDING', { reason: 'fingerprint_trusted' });
```

---

### `apps/control-plane/src/services/delete-server.ts` (service, CRUD delete)

**Analog:** `apps/control-plane/src/services/session-service.ts` (`revokeSession`, lines 101-128)

**Lookup → ownership/guard check → transaction (event before delete) pattern:**
```typescript
export async function revokeSession(headers: Headers, sessionId: string): Promise<void> {
  const { userId } = await requireCurrentSession(headers);
  const db = await getDb();

  const [target] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (!target) {
    throw new SessionNotFoundError(sessionId);
  }

  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await writeActivityEvent(tx, {
      actorType: 'user',
      actorId: userId,
      entityType: 'session',
      entityId: sessionId,
      action: SESSION_REVOKED,
      outcome: 'success',
      metadata: { sessionId, revokedBy: userId },
    });
  });
}
```
Adapt for `deleteServer`: replace the throw-on-not-found with the service's own `{ ok: false, code: 'NOT_FOUND', ... }` result convention (this file uses exceptions because it's route-facing; `deleteServer` must follow `setup-service.ts`'s result convention instead per 03-CONTEXT.md). Critically **reorder** per D-14/Pitfall 5: (1) `SELECT` row `FOR UPDATE` inside the tx (also gives the D-11 `SERVER_BUSY` check on `status === 'CONNECTING'` and D-12's `confirmName` compare, both against the live row), (2) `writeActivityEvent(tx, { action: 'server.deleted', entityId: server.id, metadata: { name: server.name, host: server.host }, ... })` **before** any delete, (3) `DELETE FROM credentials WHERE id = server.credentialId`, (4) `DELETE FROM servers WHERE id = server.id` (cascades `discovery_snapshots`).

---

### `apps/control-plane/src/services/connect-and-discover.ts` (service, event-driven/orchestration)

**Analogs:** `setup-service.ts` for the advisory-lock/row-lock + transaction shape; `packages/ssh/src/run-discovery.ts` + `packages/ssh/src/ssh-port.ts` for the SSH session contract it orchestrates (already built, unchanged this phase).

**Row-lock guard pattern (D-05)** — RESEARCH.md Pattern 2, directly usable:
```typescript
import { eq } from 'drizzle-orm';

const [row] = await tx
  .select()
  .from(servers)
  .where(eq(servers.id, serverId))
  .for('update');

if (!row) return { ok: false, code: 'NOT_FOUND', message: 'Server not found' };
if (row.status === 'CONNECTING') {
  return { ok: false, code: 'ALREADY_CONNECTING', message: 'A connection attempt is already in flight' };
}
```

**Session lifecycle contract it must respect** — `packages/ssh/src/ssh-port.ts` lines 77-117 (`ConnectInput`, `ConnectOutcome`, `SshSession`) and `run-discovery.ts`'s own header comment: `runDiscovery` never calls `session.close()` — the caller must, in a `finally`:
```typescript
const outcome = await ssh.connect(connectInput);
if (!outcome.ok) { /* apply failure via applyConnectionResult, no session to close */ }
try {
  const snapshot = await runDiscovery({ session: outcome.session, sshUser: target.user, timeouts, redactor: appRedactor });
  // persist snapshot + denormalize + writeActivityEvent, all inside the same tx
} finally {
  await outcome.session.close();
}
```

**Two-step status mutation for D-02's mid-discovery failure** — `packages/domain/src/server/connection-result.ts` (`applyConnectionResult`, step 1) + `packages/domain/src/server/server-state.ts` (`transition`, step 2, unconditional edges `CONNECTED->ERROR` / `CONNECTED->UNREACHABLE`, no reason needed — confirmed in `TRANSITIONS` table lines 32-39). Do not call `applyConnectionResult` twice — it throws `InvalidTransitionError` once status is `CONNECTED` (by design, line 69-71).

**Fingerprint timestamp stamping (Pitfall 4)** — not automatic; `ServerConnectionState` (connection-result.ts lines 25-31) has no `hostFingerprintCapturedAt`/`pendingFingerprintSeenAt` fields. The service must separately set these two Drizzle columns from `outcome.fingerprintCaptured` / `outcome.observedFingerprint`, using `formatFingerprint` (`@noodara/ssh`) to convert the `HostFingerprint` object to the plain string the `servers` columns store.

---

### `packages/domain/src/discovery/merge-facts.ts` (`mergeDiscoveryFacts`, `classifySnapshotOutcome`) and `packages/domain/src/server/classify-edit.ts` (`classifyServerEdit`) — pure functions

**Analog:** `packages/domain/src/server/connection-result.ts` (`statusForErrorCode`, lines 42-54 — pure table-lookup classification with zero I/O, zero mutation)
```typescript
const ERROR_CODE_STATUS = {
  AUTH_FAILED: 'ERROR',
  // ...
} satisfies Record<ServerErrorCode, ServerStatus>;

export function statusForErrorCode(code: ServerErrorCode): ServerStatus {
  return ERROR_CODE_STATUS[code];
}
```
`classifyServerEdit`/`classifySnapshotOutcome` follow the same shape: a frozen lookup or simple field comparison, no `Date.now()`, no I/O, returning a plain value. `mergeDiscoveryFacts` follows `applyConnectionResult`'s "returns a new object, never mutates `state`" convention (connection-result.ts line 60: *"Returns a new object; never mutates `state`"*) — spread `current`, overwrite only non-null `incoming` keys.

**Test analog** — `packages/domain/src/server/connection-result.test.ts` lines 1-46:
```typescript
function buildState(overrides: Partial<ServerConnectionState> = {}): ServerConnectionState {
  return {
    status: 'CONNECTING',
    lastErrorCode: null,
    hostFingerprint: null,
    pendingFingerprint: null,
    lastSeenAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-09-10T12:00:00.000Z');

describe('SERVER_ERROR_CODES', () => {
  it('contains exactly the 7 documented codes', () => { ... });
});
```
`merge-facts.test.ts` and `classify-edit.test.ts` should use the same `build<Thing>(overrides)` fixture-builder + fixed `NOW` constant convention, and (per `noodara-tdd` skill §4) enumerate the full table of valid/invalid input combinations exhaustively — this is the ≥95%-branch-coverage bar these two files must hit.

---

### `apps/control-plane/src/activity/boundary.test.ts` (test, boundary/static enforcement)

**Analog:** `packages/ssh/src/boundary.test.ts` (full file quoted below, lines 1-73) — same file-walk + regex-import-scan technique.
```typescript
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SSH_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(SSH_PACKAGE_ROOT));
const SCAN_ROOTS = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'tests')];

function listTsFiles(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((entry: string) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') return [];
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) return listTsFiles(fullPath);
    return fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') ? [fullPath] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const matches = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)];
  return matches.map((match) => match[1] ?? '');
}

describe('ssh2 containment boundary', () => {
  it('is only imported from files under packages/ssh', () => {
    const allFiles = SCAN_ROOTS.flatMap((root) => findFilesUnder(root));
    for (const file of allFiles) {
      if (isUnderSshPackage(file)) continue;
      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      expect(specifiers.includes('ssh2'), `${file} imports "ssh2" ...`).toBe(false);
    }
  });
});
```
Adapt: `ALLOWED_DIRS = ['apps/control-plane/src/services/', 'apps/control-plane/src/activity/']`, scan `apps/control-plane/src/**/*.ts` excluding `*.test.ts`, assert no file outside `ALLOWED_DIRS` has `writeActivityEvent` or `activityEvents`/`../db/schema/activity-events.js` in its `importSpecifiers()` result. `packages/domain/src/purity.test.ts` (lines 1-79) is the second reference for this same "walk src tree, regex-scan imports" technique, including its `listTsFiles` excluding `*.test.ts` files themselves from the scan.

---

### `apps/control-plane/src/services/credential-store.ts`

**Analogs:** `packages/domain/src/security/envelope.ts` (crypto primitives, unchanged) + `packages/domain/src/security/secret-value.ts` (`SecretValue`/`secretValue`/`revealSecret`) + `packages/ssh/src/ssh-port.ts`'s `SshCredential` type (target shape).

**Encrypt/decrypt primitives to call, never reimplement** (`envelope.ts` lines 79-86, 145-161):
```typescript
export function encryptSecret(plaintext: string, { key, version }: EncryptionKey): EncryptedBlob { ... }
export function decryptSecret(blob: EncryptedBlob, keyMap: ReadonlyMap<number, Buffer>): string { ... }
```

**`SecretValue` wrapping — no side effect, registration happens only on reveal** (`secret-value.ts` lines 67-81):
```typescript
export function secretValue(raw: string, kind: SecretKind): SecretValue {
  return SecretValue.from(raw, kind);
}
export function revealSecret(secret: SecretValue, registry?: SecretRegistry): string {
  const raw = SecretValue.reveal(secret);
  registry?.register(raw, secret.kind);
  return raw;
}
```

**Target shape** (`ssh-port.ts` lines 23-25):
```typescript
export type SshCredential =
  | { readonly kind: 'private_key'; readonly privateKey: SecretValue; readonly passphrase?: SecretValue }
  | { readonly kind: 'password'; readonly password: SecretValue };
```
Per RESEARCH.md's Pattern 4, the `passphrase` field reuses `SecretKind: 'ssh_private_key'` (no new `SecretKind` value this phase — `SecretKind` is a closed union in `secret-value.ts` lines 13-19, widening it is out of scope). `credential-store.ts` does not touch `appRedactor` itself — registration is owned by `@noodara/ssh`'s adapter at connect time (Pitfall 3).

---

### `apps/control-plane/src/db/schema/discovery-snapshots.ts` (Drizzle schema, append-only)

**Analog:** `apps/control-plane/src/db/schema/activity-events.ts` (full file, lines 1-31) for the append-only + jsonb + index shape:
```typescript
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    // ...
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('activity_events_occurred_at_idx').on(table.occurredAt.desc()),
  ],
);
```
Differences to apply per D-06: `discovery_snapshots` DOES have an FK to `servers` (`ON DELETE CASCADE`, unlike `activity_events`'s deliberately FK-less `entity_id`) — model the FK the way `apps/control-plane/src/db/schema/servers.ts` line 21-23 models its own FK to `credentials`:
```typescript
credentialId: uuid('credential_id').notNull().references(() => credentials.id),
```
add `.references(() => servers.id, { onDelete: 'cascade' })` for `serverId`. The `outcome`/`errorCode` columns reuse `serverErrorCodeEnum` already exported from `servers.ts` (line 9) rather than declaring a new enum. Composite index per D-06: `index('discovery_snapshots_server_id_collected_at_idx').on(table.serverId, table.collectedAt.desc())` — same `index(...).on(col.desc())` API `activity-events.ts` already uses.

---

### `apps/control-plane/src/db/schema/servers.ts` (MODIFIED — `docker_compose_version` column + 2 unique indexes)

**Analog:** itself, prior version, plus Pitfall 6's exact expression-index requirement:
```typescript
import { sql } from 'drizzle-orm';
import { uniqueIndex } from 'drizzle-orm/pg-core';

export const servers = pgTable('servers', { /* ...existing columns..., dockerComposeVersion: text('docker_compose_version'), */ }, (table) => [
  uniqueIndex('servers_name_lower_unique_idx').on(sql`lower(${table.name})`),
  uniqueIndex('servers_host_port_unique_idx').on(table.host, table.sshPort),
]);
```
`dockerComposeVersion: text('docker_compose_version')` (nullable, same convention as `dockerVersion: text('docker_version')` immediately above it in the existing file). **Do not** use `uniqueIndex(...).on(table.name)` directly for the name index — that produces a case-sensitive literal-column index, not the case-insensitive `lower(name)` D-10 requires (Pitfall 6).

---

### `apps/control-plane/src/db/migrations/0003_*.sql`

**Analog:** `apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql` (full file, 2 lines) for additive-column style:
```sql
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "host_fingerprint_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "pending_fingerprint_seen_at" timestamp with time zone;
```
Migration 0003 is heavier (new table + column + 2 indexes) — generate it via `pnpm --filter @noodara/control-plane db:generate` from the schema changes above, never hand-write it (RESEARCH.md's Wave 0 gap note: "generated via `db:generate`, not hand-written"). Verify the generated SQL uses `CREATE UNIQUE INDEX ... ON "servers" (lower("name"))` for the name index and includes `ON DELETE CASCADE` for `discovery_snapshots.server_id`.

---

### `packages/domain/src/activity/activity-event.ts` (MODIFIED — widen action union)

**Analog:** itself, prior version, `AUTH_ACTIONS` (lines 14-25):
```typescript
export const AUTH_ACTIONS = [
  'auth.setup_completed',
  'auth.admin_preseeded',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.login_blocked',
  'auth.logout',
  'auth.session_revoked',
  'auth.password_reset',
] as const;

export type AuthAction = (typeof AUTH_ACTIONS)[number];
```
Add a parallel `SERVER_ACTIONS` tuple (the six `server.*` actions from D-16) and widen the type consumed by `ActivityEvent.action`/`BuildActivityEventInput.action` from `AuthAction` to `AuthAction | ServerAction` (or a combined `ActivityAction = AuthAction | ServerAction`), and widen the runtime membership check in `buildActivityEvent` (line 120):
```typescript
if (!(AUTH_ACTIONS as readonly string[]).includes(input.action)) {
  throw new InvalidActivityActionError(input.action);
}
```
to check membership in the combined set. `SensitiveMetadataError`/`assertNoSensitiveMetadata`/`FORBIDDEN_METADATA_KEYS` (lines 66-112) are unchanged and already cover the new `server.*` metadata shapes — D-16's `server.updated` metadata (`{ changedFields: string[], credentialReplaced: boolean }`) contains no forbidden key by construction.

---

### `tests/integration/activity/canary-full-flow.test.ts`

**Analog:** `tests/integration/activity/canary.test.ts` (full file, lines 1-117) for the canary structure (runtime-generated values via `randomBytes`, `appRedactor.register`/`.release` in `try`/`finally`, assert `not.toContain` across every captured output) — plus `tests/integration/helpers/ssh.ts` (`startSshd`, not read in full this pass but referenced by 03-RESEARCH.md as the fixture to reuse) and `tests/integration/helpers/app.ts` (`startTestApp`, lines 1-45) for the app+db fixture:
```typescript
let fixture: TestAppFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});
```
D-18's version additionally starts a real `sshd` Testcontainer (`startSshd`), runs the full register→connectAndDiscover→edit→trustFingerprint→delete sequence through the actual services (not through HTTP, since routes don't exist until phase 4), and asserts none of the captured `logOutput`/service results/`activity_events.metadata`/`discovery_snapshots.payload`/a simulated thrown error contain the canary values or `'BEGIN OPENSSH PRIVATE KEY'` — same `not.toContain` assertion loop as `canary.test.ts` lines 105-110, extended with two more captured-output sources.

## Shared Patterns

### Transactional service result convention
**Source:** `apps/control-plane/src/services/setup-service.ts` (whole file, esp. lines 37-39, 62-126)
**Apply to:** All five new services (`registerServer`, `editServer`, `deleteServer`, `connectAndDiscover`, `trustFingerprint`)
```typescript
export type XResult =
  | { readonly ok: true; /* ...success payload... */ }
  | { readonly ok: false; readonly code: string; readonly message: string };

export async function x(input: XInput): Promise<XResult> {
  const now = input.now ?? new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    // validation / lookups, each an early `return { ok: false, code, message }`
    await writeActivityEvent(tx, { /* ... */ }, now);
    return { ok: true, /* ... */ };
  });
}
```

### Activity event writing — the one insert point
**Source:** `apps/control-plane/src/activity/write-activity-event.ts` (whole file, lines 1-67)
**Apply to:** All five new services, called only inside their own `db.transaction`'s `tx` handle — never `db` directly, never from a route/worker (enforced by the new `boundary.test.ts`).
```typescript
export async function writeActivityEvent(
  handle: ActivityWriteHandle,
  input: WriteActivityEventInput,
  now: Date = new Date(),
): Promise<string>
```
Order matters (comment lines 33-38 of that file): the function builds the event (which throws `SensitiveMetadataError` on a forbidden metadata key) **before** redacting — never let a forbidden key get silently laundered.

### Secret redaction — module singleton, register once
**Source:** `apps/control-plane/src/activity/redaction.ts` (whole file, lines 1-71)
**Apply to:** `connect-and-discover.ts` (passes `appRedactor` as `ConnectInput.redactor`/`RunDiscoveryInput.redactor`), and any service logging a `servers`/`credentials` row (via `toLogSafe`).
```typescript
export const appRedactor: Redactor = createRedactor();
appRedactor.register(env.NOODARA_MASTER_KEY, 'master_key');
// ...
export function toLogSafe(entity: Record<string, unknown>): Record<string, unknown> { ... }
```
`credential-store.ts` does NOT need to call `appRedactor.register` itself — `secretValue()` has no side effect, and `@noodara/ssh`'s adapter registers/releases the credential around the connection's own lifetime (Pitfall 3).

### Server state transitions — single authority, never assign `status` directly
**Source:** `packages/domain/src/server/server-state.ts` (whole file) + `packages/domain/src/server/connection-result.ts` (`applyConnectionResult`, `statusForErrorCode`)
**Apply to:** `register-server.ts` (initial `status: 'PENDING'` default, no transition call needed), `edit-server.ts`, `connect-and-discover.ts`, `trust-fingerprint.ts`.
```typescript
export function transition(from: ServerStatus, to: ServerStatus, options: TransitionOptions = {}): ServerStatus
export function applyConnectionResult(state: ServerConnectionState, result: ConnectionResult, now: Date): ServerConnectionState
```

### Validation — reuse, never re-regex
**Source:** `packages/domain/src/validators/identity.ts` (`validateServerName`, `validateSshUser`) + `packages/domain/src/validators/network.ts` (`validateHost`, `validateSshPort`, not read in full this pass but confirmed to exist and export the same `ValidationResult<T>` shape by RESEARCH.md and `identity.ts`'s own import line 5)
**Apply to:** `register-server.ts`, `edit-server.ts`

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `apps/control-plane/src/services/server-view.ts` | transform / projection | transform | No existing file in this codebase projects a Drizzle row to a public API-safe DTO — `toLogSafe` (redaction.ts) is adjacent (also strips credential-shaped fields) but serves logging, not API responses. Use RESEARCH.md's `ServerView` interface (Code Examples section) verbatim as the target shape; the "assert no credential key" unit test pattern is also given there in full and needs no further analog. |
| `apps/control-plane/src/services/*.test.ts` (colocated unit tests for the five services) | test (unit) | — | **Important gap:** no service in this codebase (`setup-service.ts`, `session-service.ts`) has a colocated `.test.ts` file today — both are exercised only through `tests/integration/auth/*.test.ts` (`setup.test.ts`, `setup-race.test.ts`, `session-management.test.ts`, etc.) driving the real Fastify app + Testcontainers Postgres via `startTestApp()`. RESEARCH.md's proposed structure lists colocated `register-server.test.ts` etc., and 03-CONTEXT.md's Claude's Discretion explicitly calls for **unit** tests with a fake `SshPort` (implying these files are new territory — a "unit test that still needs a real Postgres transaction" hybrid, since every service opens `db.transaction`). Planner should decide explicitly whether these are true colocated Vitest unit tests using a lightweight fake `db` handle (not proven anywhere in this repo) or whether "unit" here means "integration test under `tests/integration/**` with a fake `SshPort` swapped in for `createSsh2Adapter`" (which fits the existing test-file location convention). The `run-discovery.test.ts`'s `buildFakeSession()` helper (lines 56-79) is the correct analog for the fake-`SshPort`/fake-`SshSession` half either way. |

## Metadata

**Analog search scope:** `apps/control-plane/src/services/`, `apps/control-plane/src/activity/`, `apps/control-plane/src/db/schema/`, `apps/control-plane/src/db/migrations/`, `packages/domain/src/server/`, `packages/domain/src/discovery/`, `packages/domain/src/activity/`, `packages/domain/src/security/`, `packages/domain/src/validators/`, `packages/ssh/src/`, `tests/integration/activity/`, `tests/integration/db/`, `tests/integration/helpers/`
**Files scanned:** 24 read in full or targeted sections (setup-service.ts, session-service.ts, servers.ts, credentials.ts, activity-events.ts, activity-event.ts, write-activity-event.ts, redaction.ts, connection-result.ts, server-state.ts, envelope.ts, secret-value.ts, identity.ts, discovery/types.ts, boundary.test.ts (ssh), canary.test.ts, migrations.test.ts (partial), purity.test.ts, connection-result.test.ts (partial), 0002 migration SQL, ssh-port.ts, ssh/index.ts, run-discovery.ts (partial), run-discovery.test.ts (partial), app.ts, postgres.ts, migrations.ts helper) plus directory listings of every relevant `src/` and `tests/integration/` subtree
**Pattern extraction date:** 2026-09-15
