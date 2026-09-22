---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
verified: 2026-09-16T21:55:41Z
status: passed
score: 5/5 roadmap success criteria verified (6/6 requirements satisfied)
overrides_applied: 0
---

# Phase 3: Servicios de aplicación, activity log y redacción — Verification Report

**Phase Goal:** Registrar/editar/eliminar servidores, snapshots de discovery y un activity log sin
fugas de secrets, centralizado en servicios de aplicación reutilizables.
**Verified:** 2026-09-16T21:55:41Z
**Status:** passed
**Re-verification:** No — initial verification

## Method

This is a backend/services-only phase (no HTTP routes, worker, SSE or UI — explicitly out of
scope per the phase's own cross-cutting constraints). Every must-have below was checked at three
levels: (1) the artifact exists and is substantive (read in full, not grepped for keywords only),
(2) it is wired (imported/used by its declared callers, enforced by a static boundary test for
ACT-01), and (3) it is proven by tests that were **re-run in this verification session**, not
inferred from SUMMARY.md prose. Commands actually executed (fresh, in this session):

- `pnpm test` → 739/739 unit tests passed (matches SUMMARY claim, independently reproduced)
- `pnpm --filter @noodara/domain test` via `vitest run --project packages --coverage`, scoped to
  `packages/domain/src/**/*.ts` → **100% statements/branches/functions/lines** (QA-02 gate is
  ≥95%; comfortably exceeded)
- `pnpm typecheck` → green (turbo full cache hit, 5/5 tasks)
- `pnpm exec turbo boundaries` → "Checked 314 files in 4 packages, no issues found"
- `pnpm vitest run --config vitest.integration.config.ts tests/integration/services/register-server.test.ts tests/integration/services/edit-server.test.ts tests/integration/services/delete-server.test.ts tests/integration/db/migrations.test.ts tests/integration/db/schema.test.ts` → 64/64 passed
- `pnpm vitest run --config vitest.integration.config.ts tests/integration/services/connect-and-discover.test.ts tests/integration/services/trust-fingerprint.test.ts` → 38/38 passed
- `pnpm security:scan-leaks` (runs both `tests/integration/activity/canary.test.ts` and
  `tests/integration/activity/canary-full-flow.test.ts` against a real Ubuntu sshd Testcontainer)
  → **2/2 passed**
- `docker ps -aq --filter "label=noodara.test=true"` checked before and after every integration
  run above → empty every time (no stray containers)

The full `pnpm test:integration` run was deliberately **not** re-run whole, per the verification
context note: it is documented in `deferred-items.md` as a pre-existing, machine-specific
resource-contention flake in `tests/integration/ssh/*` (files this phase does not touch), with
isolation evidence already provided by the phase. Running the phase's own affected suites
individually (above) is the correct scoped check and all of them pass cleanly.

## Goal Achievement

### Observable Truths (ROADMAP.md Phase 3 Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Un servidor se registra con nombre, host, puerto SSH, usuario SSH y credencial (clave privada o password) ya cifrada; la credencial nunca se devuelve en texto plano | ✓ VERIFIED | `apps/control-plane/src/services/register-server.ts` validates fields, calls `encodeCredential` (AES-256-GCM via `@noodara/domain/security`) before any DB write, returns `toServerView(...)` which is a field-by-field allowlist with no credential-shaped key (`server-view.ts`, `SERVER_VIEW_KEYS` asserted at exactly 27 keys by `server-view.test.ts`). `tests/integration/services/register-server.test.ts` passes 100% in this session against a real Postgres Testcontainer. |
| 2 | Editar un servidor permite reemplazar su credencial sin precargar ni mostrar nunca la existente; eliminar borra la credencial en la misma transacción y deja un evento registrado | ✓ VERIFIED | `edit-server.ts` never selects/decrypts the existing `credentials.encryptedValue` (only an in-place `UPDATE`); `delete-server.ts` writes `server.deleted` **before** deleting the row, then deletes `servers` (cascading `discovery_snapshots`) then `credentials`, all inside one `deps.db.transaction`. `tests/integration/services/edit-server.test.ts` and `delete-server.test.ts` pass in this session. |
| 3 | Cada discovery exitoso escribe un `DiscoverySnapshot` append-only y, en la misma operación, actualiza los campos denormalizados de `Server` | ✓ VERIFIED | `connect-and-discover.ts` TX2 inserts into `discoverySnapshots` and updates `servers` with `mergeDiscoveryFacts` output in the same transaction. `discovery-snapshots.ts` schema has `onDelete: 'cascade'` FK and a `(server_id, collected_at desc)` index. Proven against a **real Ubuntu 24.04 sshd container** by `canary-full-flow.test.ts` (2 discovery_snapshots rows persisted, denormalized `servers` columns match collected facts, 0 rows remain after delete) — re-run in this session, passed. |
| 4 | Se registran eventos tipados para servidor creado/editado/eliminado, intento de conexión con resultado y discovery ejecutado — escritos solo desde los servicios de aplicación | ✓ VERIFIED | `packages/domain/src/activity/activity-event.ts` declares the 6-member `SERVER_ACTIONS` union used by all 5 services. `apps/control-plane/src/activity/boundary.test.ts` statically scans every non-test source file and fails if anything outside `src/services/`/`src/activity/` imports `writeActivityEvent` or inserts into `activityEvents` directly (with 3 individually-named, pre-ACT-01 exceptions that are neither routes nor workers). Re-run in this session as part of `pnpm test` (739/739 pass, includes this boundary test). |
| 5 | Un test con valores canary alimenta logs, errores simulados y `ActivityEvent` con un secret conocido y confirma que no aparece en ninguna salida | ✓ VERIFIED | `tests/integration/activity/canary-full-flow.test.ts` drives a real register → connect+discover → edit (credential swap) → host-key-change → trust → connect → delete flow against a live sshd Testcontainer with 5 per-run canary secrets, asserting absence from pino logs, every service result, `activity_events.metadata`, `discovery_snapshots.payload`, and a simulated service error. `pnpm security:scan-leaks` (which runs this file plus the fast Phase-1 `canary.test.ts`) was **re-run in this verification session**: 2/2 passed. CI's `security` job (`.github/workflows/ci.yml`) runs the same command as a merge gate with its own stray-container guard. |

**Score:** 5/5 truths verified

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| SERV-01 | 03-01, 03-04, 03-05 | Registrar servidor con credencial cifrada | ✓ SATISFIED | `register-server.ts` + `credential-store.ts`; integration test passes |
| SERV-02 | 03-01, 03-02, 03-04, 03-06 | Editar servidor, reemplazar credencial sin precargar la existente | ✓ SATISFIED | `edit-server.ts`; integration test passes |
| SERV-03 | 03-07 | Eliminar servidor con confirmación por nombre, credencial borrada en la misma transacción, evento registrado | ✓ SATISFIED | `delete-server.ts`; integration test passes |
| SEC-02 | 03-04, 03-10 | Ninguna credencial en respuestas API/logs/errores/activity log; canary lo verifica | ✓ SATISFIED | `server-view.ts` allowlist, `redaction.ts` (`toLogSafe`, `appRedactor`), `canary-full-flow.test.ts` (real Testcontainer flow); `pnpm security:scan-leaks` re-run, 2/2 pass |
| DISC-03 | 03-02, 03-03, 03-08, 03-10 | Snapshot append-only + denormalización de `Server` | ✓ SATISFIED | `discovery-snapshots.ts` schema, `connect-and-discover.ts` TX2, proven against real server by canary |
| ACT-01 | 03-02, 03-09 | Eventos tipados escritos solo desde servicios | ✓ SATISFIED | `SERVER_ACTIONS` union, `boundary.test.ts` static enforcement (3 named pre-existing exceptions, none a route/worker) |

No orphaned requirements: `.planning/REQUIREMENTS.md`'s Phase 3 mapping (SERV-01/02/03, SEC-02,
DISC-03, ACT-01) matches exactly the union of `requirements:` frontmatter declared across all 10
plans.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `apps/control-plane/src/services/register-server.ts` | SERV-01 service | ✓ VERIFIED | 197 lines, transactional, D-10 pre-checks + unique-violation safety net, writes `server.created` |
| `apps/control-plane/src/services/edit-server.ts` | SERV-02 service | ✓ VERIFIED | 300 lines, row-locked, in-place credential UPDATE, D-14 reason-gated transitions, `server.updated` |
| `apps/control-plane/src/services/delete-server.ts` | SERV-03 service | ✓ VERIFIED | 88 lines, name confirmation (exact, case-sensitive), event-before-delete ordering |
| `apps/control-plane/src/services/connect-and-discover.ts` | DISC-03 orchestration | ✓ VERIFIED | 440 lines, TX1/SSH/TX2 shape, D-01–D-08 mapping, two activity events |
| `apps/control-plane/src/services/trust-fingerprint.ts` | D-04 trust service | ✓ VERIFIED | 114 lines, promotes pending fingerprint, `ERROR -> PENDING` transition |
| `apps/control-plane/src/services/server-services.ts` | `createServerServices` factory | ✓ VERIFIED | 58 lines, binds `deps` once across all five services |
| `apps/control-plane/src/services/credential-store.ts` | envelope ↔ SshCredential boundary | ✓ VERIFIED | 163 lines, `loadPrivateKey` reuse (D-15), `SecretValue`-only decode |
| `apps/control-plane/src/services/server-view.ts` | ServerView projection | ✓ VERIFIED | 112 lines, explicit 27-key allowlist, no credential-shaped field |
| `apps/control-plane/src/db/schema/discovery-snapshots.ts` | append-only snapshot table | ✓ VERIFIED | FK `onDelete: 'cascade'`, `(server_id, collected_at desc)` index |
| `apps/control-plane/src/activity/boundary.test.ts` | ACT-01 static enforcement | ✓ VERIFIED | 132 lines, 4 assertions incl. non-vacuity self-check |
| `tests/integration/activity/canary-full-flow.test.ts` | SEC-02/D-18 full-flow leak scan | ✓ VERIFIED | 318 lines, real sshd Testcontainer, 5 canaries × 5 capture points; re-run, passed |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `register-server.ts` | `activity/write-activity-event.ts` | `writeActivityEvent(tx, ...)` inside transaction | ✓ WIRED | Confirmed by reading the file; integration test asserts the event row |
| `register-server.ts` | `credential-store.ts` | `encodeCredential` before insert | ✓ WIRED | Confirmed by reading the file |
| `edit-server.ts` | `@noodara/domain/server` | `classifyServerEdit` + reason-gated transition | ✓ WIRED | `identity_changed`/`clean_close` both present and reachable only from `CONNECTED` |
| `delete-server.ts` | `discovery_snapshots` | FK `ON DELETE CASCADE` | ✓ WIRED | Verified in schema and proven empirically by canary (0 rows after delete) |
| `connect-and-discover.ts` | `@noodara/ssh` | `SshPort.connect` + `runDiscovery` on one session, closed in `finally` | ✓ WIRED | `finally { await outcome.session.close(); }` present |
| `connect-and-discover.ts` | `discovery-snapshots.ts` | append-only insert in post-SSH transaction | ✓ WIRED | `tx.insert(discoverySnapshots)` present, TX2 |
| `package.json security:scan-leaks` | `canary-full-flow.test.ts` | vitest integration config file list | ✓ WIRED | Re-ran the actual npm script in this session; 2/2 pass |
| `.github/workflows/ci.yml` security job | `pnpm security:scan-leaks` | CI step | ✓ WIRED | Step present at line 160, with stray-container guard at 161-165 |

### Anti-Patterns Found

None. Scanned all 17 phase-3-modified core service/schema/activity files for `TBD`/`FIXME`/`XXX`/
`TODO`/`HACK`/`PLACEHOLDER` and empty-return stubs: zero matches outside a legitimate
file-walker's early-return `[]` in `boundary.test.ts` (not a stub — a normal directory-not-found
guard in a recursive helper).

### Human Verification Required

None. This phase is service-layer only (no HTTP routes, no UI, no worker — explicitly excluded by
the phase's own cross-cutting constraints), so every must-have is machine-verifiable and was
verified by re-running the actual test suites in this session, not by trusting SUMMARY.md prose.

### Gaps Summary

No gaps. All 5 ROADMAP success criteria and all 6 declared requirements (SERV-01, SERV-02,
SERV-03, SEC-02, DISC-03, ACT-01) have both static code evidence (read in full) and fresh dynamic
evidence (tests re-executed in this verification session, not merely cited from SUMMARY.md):
739 unit tests, 100% domain coverage, 102 targeted integration tests across register/edit/delete/
connect-and-discover/trust-fingerprint, and 2/2 security canaries against a real SSH server — all
green, with zero stray Docker containers left behind. The one known pre-existing issue (a
resource-contention flake when running the *entire* `pnpm test:integration` suite on this shared
machine, isolated to `tests/integration/ssh/*` which this phase does not touch) is already
documented in `deferred-items.md` with reproduction/isolation evidence and does not block this
phase's own success criteria.

---

*Verified: 2026-09-16T21:55:41Z*
*Verifier: Claude (gsd-verifier)*
