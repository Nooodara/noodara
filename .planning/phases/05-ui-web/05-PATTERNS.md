# Phase 5: UI web - Pattern Map

**Mapped:** 2026-09-19
**Files analyzed:** 26 (5 security-fix files + 4 backend-addition files + 17 greenfield frontend/scaffold surfaces)
**Analogs found:** 26 / 26 (11 exact code analogs in the existing tree; 15 greenfield files mapped to the closest scaffolding/structural analog per the phase's own instructions — `apps/web`/`packages/ui` do not exist yet)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/control-plane/src/services/edit-server.ts` (UF-01 fix) | service | CRUD | itself (existing file, targeted edit) | exact |
| `apps/control-plane/src/routes/events.ts` (T-4-02 bounded `getSession`) | route (SSE) | streaming | `apps/control-plane/src/routes/health.ts` (`withTimeout`) | exact (pattern donor) |
| `apps/control-plane/src/auth/require-session.ts` (T-4-02/UF-03 bounded `getSession`) | middleware | request-response | `apps/control-plane/src/routes/health.ts` (`withTimeout`) | exact (pattern donor) |
| `apps/control-plane/src/logger.ts` (T-4-10/T-4-38 `err` serializer) | config/utility | transform | itself (existing file, targeted edit) | exact |
| `apps/control-plane/src/queue/connect-server-worker.ts` (T-4-10 call site) | service (queue consumer) | event-driven | `apps/control-plane/src/redis/connections.ts` (`err.name`-only logging, cited in 04-SECURITY.md) | exact (pattern donor) |
| `apps/control-plane/src/events/redis-server-event-publisher.ts` (T-4-38 call site) | service (pub/sub) | event-driven | same file post-fix pattern from `logger.ts` serializer | exact |
| `apps/control-plane/src/events/sse-broadcaster.ts` (T-4-38 second site + `KNOWN_EVENT_TYPES` extension for D-05) | service (pub/sub → SSE) | streaming | itself (existing file, targeted edit) | exact |
| `apps/control-plane/src/worker.ts` (T-4-32 shutdown try/catch) | service (entrypoint) | event-driven | itself (existing file, targeted edit) | exact |
| `packages/ssh/src/run-discovery.ts` (`onCheck` callback, D-05) | service (pure orchestration) | transform | itself (existing file, targeted edit) | exact |
| `apps/control-plane/src/services/connect-and-discover.ts` (wire `onCheck` → `publishServerEvent`) | service | CRUD + event-driven | itself (existing file, targeted edit) | exact |
| `apps/control-plane/src/routes/servers.ts` (`GET /api/servers/:id/discovery`) | route | request-response | `apps/control-plane/src/routes/config.ts` (guarded, read-only, no service-result branch) | exact |
| `packages/domain/src/discovery/types.ts` (no change — imported as-is) | model | transform | itself | exact (read-only reuse) |
| `apps/web/package.json`, `next.config.ts`, `tsconfig.json`, `turbo.json` | config | — | `apps/control-plane/package.json` + root `turbo.json` (`dev`/`dev:worker` task shape, `passThroughEnv`) | role-match (new app, same monorepo scaffolding contract) |
| `packages/ui/package.json`, `tsconfig.json`, `tsconfig.build.json`, `turbo.json` | config | — | `packages/domain/package.json` + `turbo.json` (`exports` map, `pure-domain`-style tag, `tsc -p tsconfig.build.json` build) | role-match (new pure-ish package, same scaffolding contract) |
| `apps/web/src/lib/api-client.ts` | service (client fetch wrapper) | request-response | `apps/control-plane/src/routes/servers.ts`'s `sendServiceError`/error-vocabulary handling (server-side counterpart) | partial (no existing browser fetch client; error-shape contract is the shared analog) |
| `apps/web/src/lib/use-server-events.ts` | hook | streaming | `apps/control-plane/src/events/sse-broadcaster.ts` + `routes/events.ts` (server-side SSE contract this hook consumes) | partial (consumer side of an existing well-specified producer) |
| `apps/web/src/lib/discovery-steps.ts` | utility (pure transform) | transform | `packages/ssh/src/run-discovery.ts`'s `DISCOVERY_SEQUENCE`/`DISCOVERY_STEPS` (`satisfies Record<DiscoveryCheckId, ...>` pattern) | exact (structural pattern, cross-package) |
| `apps/web/src/app/layout.tsx`, `setup/page.tsx`, `login/page.tsx`, `(shell)/**` | route (Next.js page/layout) | request-response | none in-repo (greenfield) — Next.js 16 App Router conventions per RESEARCH.md Pattern 1/2 | no analog (greenfield) |
| `packages/ui/src/*.tsx` (Button, StatusPill, Sheet, etc.) | component | — | none in-repo (greenfield) — Radix primitives + skill `noodara-ux-apple` tokens | no analog (greenfield) |
| `apps/web/playwright.config.ts` + first E2E spec (QA-04) | test | event-driven (drives full stack) | `vitest.integration.config.ts` + `tests/integration/helpers/{app,ssh,worker-fixture,boot-process}.ts` (fixture composition pattern) | role-match (different runner, same fixture-composition discipline) |
| `.github/workflows/nightly.yml` | config (CI) | batch | `.github/workflows/ci.yml` (job shape: checkout → pnpm setup → install → run → stray-container check) | exact (structural CI pattern) |
| `pnpm test:e2e` script replacement (root `package.json`) | config | — | itself (existing placeholder line) | exact |
| `scripts/check-package-provenance.mjs` (`EXPECTED_PACKAGES` extension) | utility | batch | itself (existing file, additive rows) | exact |
| `docs/adr/0000-package-legitimacy-approvals.md` ("Phase 5 additions" section) | config/doc | — | itself ("Phase 4 additions" section, same table shape) | exact |
| `tests/integration/services/edit-server.test.ts` (new UF-01 regression case) | test | CRUD | itself (existing file, additive test case) | exact |
| `pnpm security:scan-leaks` extension (new suite/assertions for `server.discovery_progress` + `GET /api/servers/:id/discovery`) | test | batch | `tests/integration/activity/canary-http.test.ts` (per-run canary registered/scanned across success/error/SSE/log/DB surfaces) | exact |

## Pattern Assignments

### Wave 0 — Security remediation (must precede all UI work, per D-17)

### `apps/control-plane/src/services/edit-server.ts` (UF-01 fix)

**Analog:** itself — `apps/control-plane/src/services/edit-server.ts:205-231`

**The bug** (lines 211-231, already read in full above): the `pendingFingerprint`/`pendingFingerprintSeenAt` clear only happens inside the `if (row.status === 'CONNECTED')` branch's `classification === 'identity'` case. A row in `ERROR` (the only status where `pendingFingerprint` is actually non-null, per `connect-and-discover.ts`'s `HOST_KEY_CHANGED` path) never reaches this branch at all, so an identity-changing edit while `ERROR` leaves a stale `pendingFingerprint` in place for the new host/port/user.

**Fix shape** (matches the file's own existing `classifyServerEdit`/`statusPatch` idiom — extend the `let statusPatch` block, do not add a parallel one):
```typescript
// existing shape, lines 205-231 — add a sibling branch for row.status === 'ERROR'
let statusPatch: Partial<
  Pick<typeof servers.$inferInsert, 'status' | 'hostFingerprint' | 'hostFingerprintCapturedAt'>
> & { pendingFingerprint?: string | null; pendingFingerprintSeenAt?: Date | null } = {};

if (row.status === 'CONNECTED') {
  // ...existing classifyServerEdit branch, unchanged...
} else if (row.status === 'ERROR' && row.pendingFingerprint !== null) {
  const identityChanged = host !== row.host || sshPort !== row.sshPort || sshUser !== row.sshUser;
  if (identityChanged) {
    // UF-01: a pendingFingerprint captured against the OLD host/port/user must never be
    // promotable against a NEW identity — clear it the same edit that changes identity clears it.
    statusPatch = { pendingFingerprint: null, pendingFingerprintSeenAt: null };
  }
}
```
Add a new integration test in `tests/integration/services/edit-server.test.ts` (existing file — add a case, do not create a new file): "editing host while ERROR with a pending fingerprint clears it, so a subsequent trust-fingerprint call fails with NO_PENDING_FINGERPRINT" — mirrors the existing test file's own transaction/row-lock assertions style (read `edit-server.ts`'s own header comment for the row-lock/transaction discipline to preserve).

**Error handling pattern to preserve:** the `catch` block's `uniqueViolationConstraint` handling (lines 289-306) is unrelated to this fix and must not be touched.

---

### `apps/control-plane/src/auth/require-session.ts` + `apps/control-plane/src/routes/events.ts` (T-4-02 / UF-03 bounded `getSession`)

**Analog:** `apps/control-plane/src/routes/health.ts:28-40` (`withTimeout`)

**Pattern to copy verbatim** (the exact `Promise.race` shape already proven in this codebase):
```typescript
// apps/control-plane/src/routes/health.ts:31-40
function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('health check timed out'));
      }, ms);
    }),
  ]);
}
```

**Apply at two call sites**, both currently unbounded:
- `require-session.ts:41` — `session = await deps.getSession(toFetchHeaders(request.headers));` inside the `onRequest` hook's `try`. Wrap in `withTimeout(() => deps.getSession(...), SESSION_TIMEOUT_MS)`; a timeout rejection should fall into the existing `catch (err)` branch, which already 500s via `toErrorBody('INTERNAL_ERROR', ...)` — no new error branch needed, matching the file's own existing "session-resolution failure is a server error" comment (line 44-46).
- `events.ts:82` — `session = await deps.getSession(...)` inside the heartbeat's `setInterval` callback's `try`. Wrap the same way; the existing `catch { session = null; }` already treats any failure (including a timeout) as "no session" and calls `cleanup()` + `reply.raw.end()` — the fix is purely bounding the await, no branch restructuring required.

A shared timeout constant (e.g. `SESSION_LOOKUP_TIMEOUT_MS`, a few seconds) should live wherever both files can import it without a circular dependency — `health.ts`'s own `CHECK_TIMEOUT_MS = 2000` local constant is the precedent for keeping it file-local unless a shared home already exists.

**Test analog:** `tests/integration/routes/events-sse.test.ts`'s existing "closes the stream within two heartbeat intervals after the session is revoked" test — add a sibling case with a `getSession` fake that resolves after an artificially long delay, asserting the stream still closes within the bounded window (mirrors this file's own test double style).

---

### `apps/control-plane/src/logger.ts` + call sites (T-4-10 / T-4-38 `err` serialization)

**Analog:** `apps/control-plane/src/redis/connections.ts` (cited directly in 04-SECURITY.md as the already-correct pattern: "all `redis/connections.ts` factories log `err.name` only via `console.warn`, never `process.exit`").

**Fix option A (preferred — one central fix):** add a pino `serializers` option in `logger.ts`'s `createLogger`:
```typescript
// apps/control-plane/src/logger.ts — add alongside the existing `redact` option (line ~29)
const loggerOptions: LoggerOptions = {
  level: options.level ?? env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  serializers: {
    err: (e: unknown) => ({ name: e instanceof Error ? e.name : 'UnknownError' }),
  },
};
```
This closes both T-4-10 (`connect-server-worker.ts:99-101`, `worker.on('failed', ...)`) and T-4-38 (`redis-server-event-publisher.ts:32-34`, `sse-broadcaster.ts:106-108`) with a single change — no call site needs editing.

**Fix option B (if the central serializer is rejected for scope reasons):** edit each of the three call sites to pass `{ err: { name: err.name } }` instead of the raw `err` object, following `redis/connections.ts`'s own `err.name`-only discipline. Prefer option A; it is the smaller, single-point fix and matches the existing `redact` option's "one central policy" shape.

**Test analog:** `apps/control-plane/src/logger.test.ts` (existing file) — add a case asserting `writableForTests()`'s captured output for a logged `Error` never contains `err.message`/`err.stack`, only `err.name`.

---

### `apps/control-plane/src/worker.ts` (T-4-32 shutdown try/catch)

**Analog:** itself — the existing `shutdown()` function, lines 74-93.

**Fix shape** (wrap the existing body, preserve every existing cleanup step and their order):
```typescript
// apps/control-plane/src/worker.ts:74-93 — wrap body in try/finally
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await Promise.race([
      handle.close(),
      new Promise<void>((resolve) => { setTimeout(resolve, lockDurationMs); }),
    ]);
  } catch (err) {
    logger.warn({ err }, 'worker close rejected during shutdown'); // after the T-4-10/T-4-38 serializer fix above, this is already safe
  } finally {
    stopHeartbeat();
    await queue.close();
    workerConnection.disconnect();
    queueConnection.disconnect();
    publisherConnection.disconnect();
    process.exit(0);
  }
}
```
Note: `queue.close()`/`disconnect()` calls inside `finally` can themselves throw — if strict bullet-proofing is wanted, wrap each in its own `.catch(() => undefined)`/`try` following `sse-broadcaster.ts`'s `closeAll()` pattern (`.catch(() => undefined)` on the `unsubscribe()` call, line 123) as the precedent for "cleanup step failure must never block a later cleanup step."

---

### Wave 1 — Backend addition for DISC-02 (D-05)

### `packages/ssh/src/run-discovery.ts` (`onCheck` callback)

**Analog:** itself — the existing `for (const entry of DISCOVERY_SEQUENCE)` loop, lines 372-444.

**Core pattern to extend** (add an optional field to `RunDiscoveryInput`, lines 39-51, and call it right after each `checks.push(...)` — there are four `checks.push` call sites in the loop: the `!applicability.applies` branch (375-381), the `budgetAlreadyExceeded` branch (385-391), the budget-just-exceeded branch (400-407), and the normal-completion branch (438-443)):
```typescript
export interface RunDiscoveryInput {
  readonly session: SshSession;
  readonly sshUser: string;
  readonly timeouts: RunDiscoveryTimeouts;
  readonly redactor: Redactor;
  readonly now?: () => number;
  /** D-05: invoked once per DiscoveryCheck as it is pushed, including skipped/not_applicable
   *  ones, so a listener's "next pending check" inference stays in lockstep with the fixed
   *  DISCOVERY_SEQUENCE order. Optional — defaults to a no-op; never awaited (best-effort,
   *  matches publishServerEvent's own contract) and never allowed to throw out of runDiscovery. */
  readonly onCheck?: (check: DiscoveryCheck) => void;
}

// inside the loop, immediately after each `checks.push({...})`:
const pushedCheck = checks[checks.length - 1]!;
try {
  input.onCheck?.(pushedCheck);
} catch {
  // A listener must never abort discovery — same discipline as publishServerEvent's swallow.
}
```
Preserve the existing "never throws, never rejects" contract from the file's own header comment — `onCheck` must be wrapped defensively exactly like `publishServerEvent` wraps `publisher.publish`.

**Test analog:** `packages/ssh/src/run-discovery.test.ts` (existing file) — add a case asserting `onCheck` is invoked once per `DISCOVERY_CHECK_IDS` entry, in `DISCOVERY_SEQUENCE` order, including skipped/not_applicable entries, and that a throwing `onCheck` does not affect the returned `DiscoverySnapshot`.

---

### `apps/control-plane/src/services/connect-and-discover.ts` (wire `onCheck` → SSE)

**Analog:** itself — the existing `publishServerEvent(deps.events, { type: 'server.updated', ... })` call sites (lines 295-298, 453) and the `discover({...})` call (lines 319-325).

**Core pattern:**
```typescript
// inside connectAndDiscover, at the discover({...}) call site (line ~320)
snapshot = await discover({
  session: outcome.session,
  sshUser: row.sshUser,
  timeouts: { discoveryMs: deps.timeouts.discoveryMs },
  redactor: deps.redactor,
  onCheck: (check) => {
    // Best-effort, fire-and-forget — mirrors publishServerEvent's own "never await inside a hot
    // loop, never let a publish failure affect the run" contract. void, not awaited: onCheck
    // itself is a synchronous callback per run-discovery.ts's contract above.
    void publishServerEvent(deps.events, {
      type: 'server.discovery_progress',
      serverId: row.id,
      check,
    });
  },
});
```
This is additive only — every existing `publishServerEvent(deps.events, { type: 'server.updated', ... })` call site (CONNECTING announcement, final result) is untouched.

**Add the new event type** to `ServerEvent` in `apps/control-plane/src/events/server-event-publisher.ts` (the union at lines 12-14):
```typescript
export type ServerEvent =
  | { readonly type: 'server.updated'; readonly server: ServerView }
  | { readonly type: 'server.deleted'; readonly id: string }
  | { readonly type: 'server.discovery_progress'; readonly serverId: string; readonly check: DiscoveryCheck };
```

**Add to the broadcaster allowlist** — `apps/control-plane/src/events/sse-broadcaster.ts:40`:
```typescript
const KNOWN_EVENT_TYPES = new Set(['server.updated', 'server.deleted', 'server.discovery_progress']);
```
This is the exact T-4-36 control this phase's D-05 constraint requires be "extended explicitly" — do not infer membership from a wildcard.

**Test analogs:** `tests/integration/services/connect-and-discover.test.ts` (existing) for the wiring; `apps/control-plane/src/events/sse-broadcaster.test.ts` (existing) for the allowlist addition, following that file's existing "a message whose type is not in the allowlist is dropped" test shape but inverted (asserting the new type IS forwarded).

---

### `apps/control-plane/src/routes/servers.ts` (`GET /api/servers/:id/discovery`)

**Analog:** `apps/control-plane/src/routes/config.ts` (guarded, read-only, no service-result failure branch, one Zod response schema) — closer than any other existing route since this new endpoint, like `config.ts`, never returns a service-level error and always 200s.

**Schema pattern** (add beside the existing route definitions in `servers.ts`, following the exact `app.route({...})` shape already used eight times in that file):
```typescript
const DiscoveryReadResponseSchema = z.object({
  collectedAt: z.date().nullable(),
  outcome: z.enum(['ok', 'partial', 'failed']).nullable(),
  checks: z.array(DiscoveryCheckSchema), // new small Zod schema mirroring packages/domain/src/discovery/types.ts's DiscoveryCheck shape — do not hand-redeclare field names without a drift-guard test, same discipline as assertServerViewSchemaKeysMatch
  warnings: z.array(z.enum(SERVER_ERROR_CODES)),
});

app.route({
  method: 'GET',
  url: '/api/servers/:id/discovery',
  schema: {
    params: ServerIdParamSchema,
    response: {
      200: DiscoveryReadResponseSchema,
      401: ErrorBodySchema,
      404: ErrorBodySchema,
    },
  },
  handler: async (request, reply) => {
    const services = await fastify.getServerServices();
    const server = await services.getServer(request.params.id); // 404 if the server itself doesn't exist
    if (!server) {
      await sendServiceError(reply, 'NOT_FOUND', `Server "${request.params.id}" not found`);
      return;
    }
    const discovery = await services.readLatestDiscovery(request.params.id); // new service, mirrors read-servers.ts's read-only shape
    await reply.send(discovery); // { collectedAt: null, outcome: null, checks: [], warnings: [] } when no snapshot exists yet — never a 404 for "no discovery yet" (UI-SPEC §7.2)
  },
});
```
New service function belongs in `apps/control-plane/src/services/read-servers.ts` (existing file, add a sibling read function) or a new `read-discovery.ts` beside it — follow whichever this file's own existing read functions already establish for a "select the latest row for a server id, project a narrow shape" query (check `read-servers.ts`'s existing `getServer`/`listServers` for the exact drizzle-orm query shape to mirror, including which `discoverySnapshots` columns are safe to select — never `payload` wholesale if it could carry anything beyond `checks`/`facts`/`warnings`, since `discoverySnapshots.payload` is the same column `canary-http.test.ts` already scans for leaks).

**Test analog:** `tests/integration/routes/servers-discover.test.ts` (existing file, closest sibling) for the route-level test; extend `pnpm security:scan-leaks` per the Canary section below.

---

### Wave 2+ — Greenfield frontend scaffolding

### `apps/web` package/build scaffolding

**Analog:** `apps/control-plane/package.json` + root `turbo.json`'s `dev`/`dev:worker` tasks + `docs/adr/0003-runtime-entrypoints-and-module-resolution.md`.

**Package.json shape to mirror** (scripts section only — dependencies differ per Standard Stack):
```json
{
  "name": "@noodara/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint --config ../../packages/config/eslint.config.js .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --root ../.. --project apps"
  }
}
```
**Turbo wiring (ADR-0003's own consequence list, Pitfall 5/6 in RESEARCH.md):** add `apps/web` to the root `turbo.json`'s `dev` task's `passThroughEnv` array for any new env var it reads (e.g. `NOODARA_API_ORIGIN`), and ensure `build`/`typecheck`/`dev`'s existing `dependsOn: ["^build"]` edge covers `apps/web` importing `@noodara/domain/discovery` — this is automatic once `apps/web` depends on `@noodara/domain` in its `package.json`, per Turborepo's own dependency-graph inference, matching how `apps/control-plane` already does it.

**Root `package.json` changes:** add `"dev": "turbo run dev dev:worker dev"` equivalent (or a fourth persistent task) so `pnpm dev` boots api+worker+web together — follow the exact `turbo run dev dev:worker` precedent already at root `package.json:10`.

---

### `packages/ui` package/build scaffolding

**Analog:** `packages/domain/package.json` + `packages/domain/turbo.json` + `packages/domain/tsconfig.json`/`tsconfig.build.json`.

**Package.json shape to mirror** (the `exports` map pattern, `tsc -p tsconfig.build.json` build, single barrel):
```json
{
  "name": "@noodara/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./tokens.css": "./tokens.css"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint --config ../config/eslint.config.js .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --root ../.. --project packages"
  }
}
```
`tsconfig.json`/`tsconfig.build.json`: copy `packages/domain/tsconfig.json` and `tsconfig.build.json` verbatim (both files already read above — `extends: "@noodara/config/tsconfig.base.json"`, `outDir: "dist"`, `rootDir: "src"`, build config additionally excludes `*.test.ts`). `turbo.json`: copy `packages/domain/turbo.json`'s `{"extends": ["//"], "tags": [...]}` shape with a new tag (e.g. `"ui-components"`) — do not reuse `pure-domain`'s tag verbatim since `packages/ui` will need to render JSX (not zero-I/O in the same sense as `packages/domain`), but register the new tag in the root `turbo.json`'s `boundaries.tags` map alongside `pure-domain`/`ssh-adapter` so the `pnpm boundaries` gate has an explicit rule for it rather than silently allowing anything.

**Barrel export pattern:** `packages/domain/src/index.ts` — read it if the executor needs the exact re-export shape; the phase's own `05-RESEARCH.md` Recommended Project Structure already specifies `packages/ui/src/index.ts` as "a single barrel export, mirrors packages/domain's pattern," which is now confirmed correct against the real file.

---

### `apps/web/src/lib/discovery-steps.ts`

**Analog:** `packages/ssh/src/run-discovery.ts`'s `DISCOVERY_STEPS`/`DISCOVERY_SEQUENCE` (lines 130-347) — specifically the `as const satisfies Record<DiscoveryCheckId, ...>` idiom that makes a missing/extra id a compile error.

**Pattern to copy:**
```typescript
import { DISCOVERY_CHECK_IDS, type DiscoveryCheckId } from '@noodara/domain/discovery';

export const DISCOVERY_STEP_NAMES = ['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access'] as const;
export type DiscoveryStepName = (typeof DISCOVERY_STEP_NAMES)[number];

// D-06's grouping, `satisfies` against DiscoveryCheckId so an id added to the domain package
// without updating this map is a type error here — same discipline as DISCOVERY_STEPS above.
export const CHECK_TO_STEP = {
  hostname: 'os',
  os_release: 'os',
  arch: 'os',
  cpu: 'resources',
  memory: 'resources',
  disk: 'resources',
  uptime: 'resources',
  docker_version: 'docker',
  docker_compose_version: 'docker',
  sudo: 'access',
  docker_group: 'access',
} as const satisfies Record<DiscoveryCheckId, DiscoveryStepName>;
```
Never redeclare `DISCOVERY_CHECK_IDS`'s eleven string literals as a parallel union in `apps/web` — always import the tuple from `@noodara/domain/discovery` (RESEARCH.md's own "Don't Hand-Roll" table, row 4).

---

### `apps/web/src/lib/use-server-events.ts`

**Analog (server-side contract this hook must exactly consume):** `apps/control-plane/src/events/sse-broadcaster.ts`'s `KNOWN_EVENT_TYPES` set and the frame format it writes (`` `event: ${type}\ndata: ${message}\n\n` ``, line 80) + `apps/control-plane/src/routes/events.ts`'s `RETRY_FIELD`/heartbeat/401-close behavior.

**Contract the hook must honor (read directly from the producer, not assumed):**
- Frame format is a named SSE event (`event: server.updated`), not a bare `data:` line — the hook must use `EventSource.addEventListener(type, ...)` per type, exactly as RESEARCH.md's own sketch does, never a single generic `onmessage` handler (which only fires for unnamed events).
- No replay exists (`sse-broadcaster.ts` holds no history, `routes/events.ts` never sends a `Last-Event-ID` backlog) — every reconnect must trigger a full resync fetch, per D-05/D-01..D-07 locked decisions.
- A `503 SSE_LIMIT_REACHED` (before the stream even opens, `events.ts:40-46`) carries a `Retry-After` header the hook should read and back off by, rather than reconnecting immediately in a tight loop.
- The heartbeat comment (`: keepalive\n\n`, `events.ts:94`) is a comment line per the SSE spec and never reaches `addEventListener` — no special handling needed for it.

---

### `apps/web/src/lib/api-client.ts`

**Analog:** the server-side error vocabulary this client must parse, defined in `apps/control-plane/src/routes/http-errors.ts` (`{ error: ServiceErrorCode, message }` / `{ error: 'VALIDATION_FAILED', message, issues }`) and consumed the same way by every route in `servers.ts`/`activity.ts`/`config.ts` already read above.

**Pattern:** a thin `fetch` wrapper that (a) always sends `credentials: 'same-origin'` (never `'include'` with a cross-origin URL — D-29's same-origin lock), (b) on a non-2xx response, parses the body as `{ error, message, issues? }` and throws/returns a typed result rather than a raw `Response`, (c) never retries or transforms the body beyond that — business logic stays server-side. No existing browser-side fetch client exists in this repo to copy verbatim; the shape is fully determined by the error vocabulary already fixed in `http-errors.ts` (read above) and the four response shapes in RESEARCH.md's "Code Examples" section (`ServerView`, `ActivityItem`/`ActivityResponse`, `ConfigResponse`, `ServiceErrorCode`).

---

### CI: `.github/workflows/nightly.yml`

**Analog:** `.github/workflows/ci.yml` — copy the job skeleton shape exactly (checkout → `pnpm/action-setup` → `actions/setup-node` with `cache: pnpm` → `pnpm install --frozen-lockfile` → the actual run step → the "Fail if any noodara.test container survived" step, verbatim, for every job that touches Testcontainers).

**Structure to add:**
```yaml
name: Nightly
on:
  schedule:
    - cron: '0 3 * * *'   # do not rely on this firing until the repo has a remote — CONTEXT.md discretion note
  workflow_dispatch: {}
jobs:
  e2e-repeat:
    # pnpm test:e2e run 20 times (QA-04) — a bash loop around the existing script, or
    # `--repeat-each=20` if the chosen Playwright config supports it natively
  stress-connections:
    # 100 consecutive connections — tests/integration/ssh/stress-connections.test.ts already
    # exists as a starting point; check it before writing a new one
  canary:
    # pnpm security:scan-leaks, same as ci.yml's `security` job body
```
Every job body should reuse `ci.yml`'s exact stray-container check step (lines 129-138 pattern) since this workflow will also spin up Testcontainers.

---

### `scripts/check-package-provenance.mjs` + `docs/adr/0000-package-legitimacy-approvals.md`

**Analog:** both files' own existing "Phase 4 additions" precedent (script: literal array append; ADR: new `### Phase N additions` markdown section with the same table columns).

**Script change** — append to `EXPECTED_PACKAGES` (array literal at lines 25-42), one entry per row in 05-RESEARCH.md's Package Legitimacy Audit table:
```javascript
{ name: 'next', expectedOwnerRepo: 'vercel/next.js' },
{ name: 'react', expectedOwnerRepo: 'react/react' },
{ name: 'react-dom', expectedOwnerRepo: 'react/react' },
{ name: 'tailwindcss', expectedOwnerRepo: 'tailwindlabs/tailwindcss' },
{ name: 'lucide-react', expectedOwnerRepo: 'lucide-icons/lucide' },
{ name: '@playwright/test', expectedOwnerRepo: 'microsoft/playwright' },
{ name: 'playwright', expectedOwnerRepo: 'microsoft/playwright' },
{ name: '@radix-ui/react-dialog', expectedOwnerRepo: 'radix-ui/primitives' },
// ...one row per remaining @radix-ui/react-* package, same owner/repo
```
**ADR change** — append a `### Phase 5 additions` section mirroring the exact table shape at ADR-0000 lines 48-59 (`| Package | Expected repository | Observed repository | Resolved version | slopcheck verdict | Automated verdict | Date |`), sourced from 05-RESEARCH.md's own Package Legitimacy Audit table (already re-verified this session, values ready to copy).

---

### QA-05 canary extension for the new SSE event + read endpoint

**Analog:** `tests/integration/activity/canary-http.test.ts` (full pattern read above) — per-run random canary, registered with the redactor, submitted through a real HTTP flow, scanned across every surface.

**Extension shape:** add assertions to the existing SSE-frame capture (`streamChunks`/`framesText`, already collected in this file for `server.updated` frames) that also scans for the canary inside any `server.discovery_progress` frame — no new stream connection needed, the existing one already receives every event type on the shared global stream. Add a second scan against the new endpoint's response body (`GET /api/servers/:id/discovery`), following the same `expect(body).not.toContain(passwordCanary)` idiom already used for `successBodies`/`errorBodies` in this file. Per D-05's own fourth clause, this is additive to the existing suite, not a new file — extend `canary-http.test.ts` directly, consistent with how it already grew from the phase-1 canary to the phase-4 HTTP/SSE canary described in its own header comment.

## Shared Patterns

### Bounded async operations (`withTimeout`)
**Source:** `apps/control-plane/src/routes/health.ts:28-40`
**Apply to:** `require-session.ts`'s and `events.ts`'s `getSession` calls (T-4-02/UF-03 fix)
```typescript
function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => { reject(new Error('...timed out')); }, ms);
    }),
  ]);
}
```

### Best-effort, never-throwing side channel (`publishServerEvent`)
**Source:** `apps/control-plane/src/events/server-event-publisher.ts:46-55`
**Apply to:** the new `onCheck` callback in `run-discovery.ts` (same "a listener/publisher failure must never abort the real operation" contract) and any new SSE publish call site
```typescript
export async function publishServerEvent(publisher, event) {
  try {
    await publisher.publish(event);
  } catch {
    // Intentionally swallowed.
  }
}
```

### Service-result error mapping, never a hand-written status literal
**Source:** `apps/control-plane/src/routes/servers.ts:59-61` (`sendServiceError`) + `apps/control-plane/src/routes/http-errors.ts` (`mapServiceCodeToStatus`, `toErrorBody`)
**Apply to:** the new `GET /api/servers/:id/discovery` route, and any `apps/web` error-rendering logic that must reproduce the same `{ error, message }`/`{ error: 'VALIDATION_FAILED', message, issues }` vocabulary client-side (05-UI-SPEC.md §5.4's Copy Deck table is this pattern's UI-side mirror — one copy string per `ServiceErrorCode`, never a generic fallback except where the table says so).

### Explicit, non-reflective field allowlists (drift-guard discipline)
**Source:** `apps/control-plane/src/routes/server-schemas.ts:79-113` (`ServerViewSchema` + `assertServerViewSchemaKeysMatch`)
**Apply to:** the new `DiscoveryReadResponseSchema`/`DiscoveryCheck`-mirroring Zod schema (never derive it by reflection off `packages/domain/src/discovery/types.ts`'s `DiscoveryCheck` interface — declare it explicitly with a matching drift-guard test), and `apps/web`'s own client-side type for `ServerView` (per RESEARCH.md's own "Don't Hand-Roll" table, either import the Zod schema's inferred type or hand-write an interface with a comment linking back to `ServerViewSchema`).

### Redis/pub-sub `KNOWN_EVENT_TYPES` allowlist (never a wildcard)
**Source:** `apps/control-plane/src/events/sse-broadcaster.ts:40, 73-78`
**Apply to:** adding `server.discovery_progress` — the allowlist must be extended with a literal string, never a pattern/prefix match, per T-4-36's own closed-threat discipline.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `apps/web/src/app/**` (all Next.js pages/layouts) | route (page) | request-response | Greenfield — no prior Next.js/React code exists anywhere in this repo. Follow Next.js 16 App Router conventions per RESEARCH.md's Architecture Patterns (Pattern 1: rewrites proxy; Pattern 2: EventSource hook) and 05-UI-SPEC.md's per-screen contract (§2). Re-verify exact `rewrites()`/App Router API syntax against Context7/official docs at execution time (RESEARCH.md flags this as Assumption A2, MEDIUM confidence). |
| `packages/ui/src/*.tsx` (all 17 components in the Component Inventory) | component | — | Greenfield — no prior UI component library exists. Build directly on the Radix primitives listed in 05-RESEARCH.md's Standard Stack table; do not introduce shadcn/ui (explicitly rejected in 05-UI-SPEC.md's Design System table). Token values come from `.claude/skills/noodara-ux-apple/SKILL.md` §2, already locked — do not invent new ones (the one open exception, light-mode status-pill contrast, is 05-UI-SPEC.md's own Open Question 1, escalate rather than silently fix). |
| `apps/web/playwright.config.ts` + `tests/e2e/*.spec.ts` | test | event-driven | Greenfield — `playwright.config.ts` does not exist. Fixture composition (starting api+worker+web+sshd together) has a structural analog in `tests/integration/helpers/{app,worker-fixture,ssh}.ts` (listed above) but no Playwright-specific file to copy from; this is genuinely new tooling for this repo, gated by the ADR-0000 provenance check like everything else in Standard Stack. |

## Metadata

**Analog search scope:** `apps/control-plane/src/{routes,services,events,queue,auth}/**`, `packages/{ssh,domain}/src/**`, `packages/domain/src/discovery/**`, `scripts/**`, `docs/adr/**`, `.github/workflows/**`, `tests/integration/**` (helpers, activity canary suites, routes), root/package-level `package.json`/`turbo.json`/`tsconfig*.json`/`vitest.config.ts`.
**Files scanned:** ~35 read in full or targeted sections (see file paths cited inline above); directory listings taken of `apps/control-plane/src/{routes,events,services,queue}`, `packages/{domain,ssh}/src`, and the full non-`node_modules` repo tree.
**Pattern extraction date:** 2026-09-19
