# Phase 4: HTTP routes, worker BullMQ y SSE - Pattern Map

**Mapped:** 2026-09-16
**Files analyzed:** 23 (new/modified)
**Analogs found:** 21 / 23

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/control-plane/src/routes/servers.ts` | route | CRUD + request-response | `apps/control-plane/src/routes/sessions.ts` | exact (route shape) + `services/delete-server.ts` (result-code shape) |
| `apps/control-plane/src/routes/activity.ts` | route | request-response (keyset pagination) | `apps/control-plane/src/routes/sessions.ts` (route shape) + `db/schema/activity-events.ts` (query source) | role-match |
| `apps/control-plane/src/routes/config.ts` | route | request-response | `apps/control-plane/src/routes/health.ts` | exact |
| `apps/control-plane/src/routes/events.ts` | route | streaming (SSE) | none in-repo (no existing streaming route) | no analog — use RESEARCH.md Pattern 3 |
| `apps/control-plane/src/routes/http-errors.ts` | utility | transform (code→status map) | none in-repo (first single-map helper); modeled on the five services' `{ ok, code, message }` union | no analog — see Shared Patterns |
| `apps/control-plane/src/auth/require-session.ts` | middleware | request-response (guard) | `apps/control-plane/src/services/session-service.ts` (`toFetchHeaders`, `auth.api.getSession`, `UnauthorizedError`) | role-match (service → plugin adaptation) |
| `apps/control-plane/src/queue/connect-server-queue.ts` | service (queue producer) | event-driven | `apps/control-plane/src/services/server-service-deps.ts` (dependency-resolution shape) | partial |
| `apps/control-plane/src/queue/connect-server-worker.ts` | service (worker) | event-driven | `apps/control-plane/src/services/connect-and-discover.ts` (caller contract) + `services/server-services.ts` (factory shape) | role-match |
| `apps/control-plane/src/queue/job-payload.ts` | utility (Zod schema) | transform/validation | `apps/control-plane/src/routes/setup.ts` (Zod schema-as-const pattern) | partial |
| `apps/control-plane/src/services/fail-in-flight-connection.ts` | service | CRUD (state transition) | `apps/control-plane/src/services/trust-fingerprint.ts` (row-lock + `transition()` + activity + result union) | exact |
| `apps/control-plane/src/events/server-event-publisher.ts` | service (adapter) | pub-sub | `apps/control-plane/src/activity/redaction.ts` (single-binding-module pattern) | partial |
| `apps/control-plane/src/events/sse-broadcaster.ts` | service (adapter) | pub-sub / streaming | none in-repo | no analog — see RESEARCH.md Pattern 2 |
| `apps/control-plane/src/worker.ts` | config/entrypoint | event-driven (process boot) | `apps/control-plane/src/server.ts` | exact |
| `apps/control-plane/src/app.ts` (MODIFIED) | config | request-response (composition root) | itself (extend existing `buildApp`) | exact |
| `apps/control-plane/src/env.ts` (MODIFIED) | config | transform (validation) | itself (`parseTuningInt`/`parseTuningBool` already present) | exact |
| `apps/control-plane/src/routes/setup.ts` (MODIFIED) | route | request-response | itself (migrate error shape only) | exact |
| `apps/control-plane/src/routes/sessions.ts` (MODIFIED) | route | request-response | itself (migrate error shape + `requireSession`) | exact |
| `apps/control-plane/src/routes/health.ts` (MODIFIED) | route | request-response | itself (extend with checks) | exact |
| `packages/domain/src/server/server-state.ts` (consumer, not modified) | model (pure) | transform | already has `CONNECTING -> ERROR` edge; `computeJobLockDurationMs` is a new pure function to add alongside it | exact |
| `tests/integration/helpers/redis.ts` | test helper | file-I/O (Testcontainers) | `tests/integration/helpers/postgres.ts` | exact |
| `tests/integration/routes/*.test.ts` (servers, activity, events, redis-down) | test | integration | `tests/integration/services/*.test.ts` + `tests/integration/activity/canary.test.ts` | exact |
| `tests/integration/queue/*.test.ts` (stalled-recovery, startup-recovery) | test | integration | `tests/integration/services/connect-and-discover.test.ts` | role-match |
| `.github/workflows/ci.yml` (MODIFIED) | config | batch (CI) | itself (`integration`, `boot-smoke` jobs) | exact |
| `apps/control-plane/package.json` / `turbo.json` (MODIFIED) | config | — | itself (`dev`, `passThroughEnv`) | exact |

## Pattern Assignments

### `apps/control-plane/src/routes/servers.ts` (route, CRUD + request-response)

**Analogs:** `apps/control-plane/src/routes/sessions.ts` (route/schema/error-mapping shape), `apps/control-plane/src/services/delete-server.ts` + `trust-fingerprint.ts` (the `{ ok, code, message }` unions this route maps), `apps/control-plane/src/services/server-view.ts` (response body).

**Imports pattern** (`sessions.ts` lines 1-11):
```typescript
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import {
  listSessions,
  revokeOtherSessions,
  revokeSession,
  SessionNotFoundError,
  toFetchHeaders,
  UnauthorizedError,
} from '../services/session-service.js';
```
For `servers.ts`, mirror this but import `createServerServices`/`resolveServerServicesDeps` from `../services/server-services.js` + `../services/server-service-deps.js`, `toServerView`/`ServerView` from `../services/server-view.js`, and the new `mapServiceCodeToStatus` from `./http-errors.js`.

**Route + Zod schema + result-code mapping pattern** (`sessions.ts` lines 33-57, adapted with `server-services.ts`'s result shape):
```typescript
const sessionsRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'GET',
    url: '/api/sessions',
    schema: { response: { 200: z.array(SessionItemSchema), 401: UnauthorizedSchema } },
    handler: async (request, reply) => {
      try {
        const items = await listSessions(toFetchHeaders(request.headers));
        await reply.send(items);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          await reply.code(401).send({ error: 'unauthorized' as const });
          return;
        }
        throw error;
      }
    },
  });
  done();
};
```
Every `ServerServices` call instead returns `{ ok: true, ... } | { ok: false, code, message }` (never throws for an expected failure — see `delete-server.ts` lines 20-24, 44-49, 51-57, 61-67 and `trust-fingerprint.ts` lines 18-22, 45-63), so `servers.ts`'s handler pattern is:
```typescript
const result = await services.deleteServer({ actor: request.actor!, serverId: request.params.id, confirmName: request.body.confirmName });
if (!result.ok) {
  const status = mapServiceCodeToStatus(result.code);
  await reply.code(status).send({ error: result.code, message: result.message });
  return;
}
await reply.send({ ok: true as const, serverId: result.serverId });
```

**Response body pattern** (`server-view.ts` lines 82-112 — the exact, unmodified `ServerView` allowlist every `POST`/`PATCH`/`GET` response returns):
```typescript
export function toServerView(row: ServerRow, credentialType: CredentialType): ServerView {
  return { id: row.id, name: row.name, host: row.host, /* ...27 allowlisted fields... */ };
}
```

**Enqueue precondition pattern** — combine `connect-and-discover.ts`'s row-lock shape (lines 95-133, `SELECT ... FOR UPDATE` + status check) conceptually with RESEARCH.md Pattern 1's `enqueueConnect` (already a concrete code example matching this repo's conventions):
```typescript
const server = await services.getServerOrNull(serverId);
if (!server) return { code: 'NOT_FOUND' };
if (server.status === 'CONNECTING') return { code: 'ALREADY_CONNECTING' };
if (trigger === 'discover' && server.status !== 'CONNECTED') return { code: 'SERVER_NOT_CONNECTED' };
const jobId = `connect:${serverId}`;
const job = await queue.add('connect-server', { serverId, actor, requestedAt: new Date().toISOString(), trigger }, { jobId, attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } });
```

---

### `apps/control-plane/src/routes/activity.ts` (route, keyset pagination)

**Analog:** `apps/control-plane/src/routes/sessions.ts` (route shape) + `apps/control-plane/src/db/schema/activity-events.ts` (query source, `occurred_at desc` index at lines 26-29).

**Query pattern** (RESEARCH.md Pattern 7, Drizzle-verified, no direct repo analog since this is the first paginated read route):
```typescript
import { and, desc, eq, lt, or } from 'drizzle-orm';

const rows = await db
  .select()
  .from(activityEvents)
  .where(
    cursor
      ? or(
          lt(activityEvents.occurredAt, cursor.occurredAt),
          and(eq(activityEvents.occurredAt, cursor.occurredAt), lt(activityEvents.id, cursor.id)),
        )
      : undefined,
  )
  .orderBy(desc(activityEvents.occurredAt), desc(activityEvents.id))
  .limit(limit + 1);
```
Route wiring (schema + `withTypeProvider<ZodTypeProvider>()` + `app.route`) follows `sessions.ts` lines 33-45 exactly, with a `querystring` schema (`limit`, `cursor`) instead of `params`.

---

### `apps/control-plane/src/routes/config.ts` (route, request-response)

**Analog:** `apps/control-plane/src/routes/health.ts` (full file, 29 lines — exact shape to extend).

**Full existing pattern** (`health.ts` lines 1-28):
```typescript
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

const healthRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/health',
    schema: { response: { 200: z.object({ status: z.literal('ok'), version: z.string() }) } },
    handler: (_request, reply) => {
      reply.send({ status: 'ok' as const, version: CONTROL_PLANE_VERSION });
    },
  });
  done();
};
```
`config.ts` copies this shape 1:1 for `GET /api/config` (no params, single literal-status object response), reusing the same `CONTROL_PLANE_VERSION` source (RESEARCH.md Pattern 6 — `createRequire(import.meta.url)` reading `../package.json`, since `apps/control-plane/package.json` line 2 already carries `"version": "0.0.0"`). `health.ts` itself must be modified to import this same version constant and add `checks: { postgres, redis, worker }` — same `z.object` schema style, one boolean-ish `pass`/`fail` literal per check.

---

### `apps/control-plane/src/routes/events.ts` (route, SSE streaming)

**No in-repo analog** (no existing streaming route). Use RESEARCH.md Pattern 3 verbatim — it is already tailored to this codebase's `requireSession`/`toFetchHeaders`/`env` conventions:
```typescript
fastify.get('/api/events', async (request, reply) => {
  if (openReplies.size >= env.NOODARA_SSE_MAX_CONNECTIONS) {
    await reply.code(503).header('Retry-After', '5').send({ error: 'SSE_LIMIT_REACHED' });
    return;
  }
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  reply.raw.write('retry: 5000\n\n');
  openReplies.add(reply);
  const heartbeat = setInterval(async () => {
    const session = await auth.api.getSession({ headers: toFetchHeaders(request.headers) });
    if (!session?.session) { cleanup(); reply.raw.end(); return; }
    reply.raw.write(': keepalive\n\n');
  }, 15_000);
  function cleanup(): void { clearInterval(heartbeat); openReplies.delete(reply); }
  request.raw.on('close', cleanup);
});
```
`toFetchHeaders` and `auth.api.getSession` come from `apps/control-plane/src/services/session-service.ts` lines 55-79 (already imported this exact way by `sessions.ts`). Close every open reply and the Redis subscriber in a `preClose` hook (RESEARCH.md Anti-Patterns / Pitfall 3) — this codebase has no existing `preClose` usage to copy from; treat as new but well-sourced from Fastify's own docs per RESEARCH.md.

---

### `apps/control-plane/src/routes/http-errors.ts` (utility, transform)

**No direct analog** (first single code→status map), but the input shape it consumes is the union already established by every phase-3 service:
```typescript
// delete-server.ts lines 20-24
export type DeleteServerFailureCode = 'NOT_FOUND' | 'SERVER_BUSY' | 'CONFIRMATION_MISMATCH';
export type DeleteServerResult =
  | { readonly ok: true; readonly serverId: string }
  | { readonly ok: false; readonly code: DeleteServerFailureCode; readonly message: string };
```
Full known code inventory to map (gathered from `register-server.ts`, `edit-server.ts`, `delete-server.ts`, `trust-fingerprint.ts`, `connect-and-discover.ts`):
`VALIDATION_FAILED`, `INVALID_CREDENTIAL` (register-server.ts:70,78,86,94,109; edit-server.ts:123,129,135,141,165) → 400; `NOT_FOUND` (trust-fingerprint.ts:48; delete-server.ts:44-49; edit-server.ts:108) → 404; `NAME_TAKEN`, `HOST_TAKEN` (register-server.ts:122,135,184,191; edit-server.ts:181,195,287,294), `SERVER_BUSY` (trust-fingerprint.ts:55; edit-server.ts:115; delete-server.ts:51-57), `ALREADY_CONNECTING` (connect-and-discover.ts:51, 106-109), `NO_PENDING_FINGERPRINT` (trust-fingerprint.ts:62), `CONFIRMATION_MISMATCH` (delete-server.ts:61-67) → 409; plus the new phase-4 codes `SERVER_NOT_CONNECTED`, `QUEUE_UNAVAILABLE`, `SSE_LIMIT_REACHED`, `FORBIDDEN_ORIGIN`, `INTERNAL_ERROR`.

**Testing pattern:** table-driven unit test, one row per code, modeled on the exhaustive-mapping style of `packages/domain/src/server/server-state.test.ts` (every transition asserted) — read `server-state.ts`'s `TRANSITIONS`/`REASON_REQUIRED` frozen-object pattern (lines 32-54) as the "one source of truth, exhaustively tested" idiom to copy for the code→status map itself (a frozen `Record<string, number>`).

---

### `apps/control-plane/src/auth/require-session.ts` (middleware, request-response guard)

**Analog:** `apps/control-plane/src/services/session-service.ts` lines 55-79 (`toFetchHeaders`, `UnauthorizedError`, `requireCurrentSession`'s `auth.api.getSession` call).

**Auth pattern to adapt into a Fastify plugin** (`session-service.ts` lines 68-79):
```typescript
async function requireCurrentSession(headers: Headers): Promise<CurrentSession> {
  const result = await auth.api.getSession({ headers });
  if (!result?.session) {
    throw new UnauthorizedError();
  }
  return { userId: result.user.id, sessionId: result.session.id };
}
```
Wrapped as RESEARCH.md Pattern 4's Fastify plugin (already concrete and repo-specific — note the `decorateRequest('actor', null)` requirement, not an object literal, per Fastify v5's `decorateRequest` restriction):
```typescript
export default fp(async (fastify) => {
  fastify.decorateRequest('actor', null);
  fastify.addHook('onRequest', async (request, reply) => {
    const session = await auth.api.getSession({ headers: toFetchHeaders(request.headers) });
    if (!session?.session) {
      await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'No active session' });
      return;
    }
    request.actor = { type: 'user', id: session.user.id };
  });
});
```
`ServiceActor` type itself is already declared once in `apps/control-plane/src/services/server-service-deps.ts` line 20 — import it, do not redeclare.

---

### `apps/control-plane/src/queue/connect-server-worker.ts` (service/worker, event-driven)

**Analogs:** `apps/control-plane/src/services/server-services.ts` (factory pattern, lines 50-58) + `apps/control-plane/src/services/connect-and-discover.ts` (the exact function the job handler calls, its `{ ok, code }` non-throwing contract lines 68-79).

**Factory pattern to copy** (`server-services.ts` lines 50-58):
```typescript
export function createServerServices(deps: ServerServicesDeps): ServerServices {
  return {
    registerServer: (input) => registerServer(deps, input),
    editServer: (input) => editServer(deps, input),
    deleteServer: (input) => deleteServer(deps, input),
    connectAndDiscover: (input) => connectAndDiscover(deps, input),
    trustFingerprint: (input) => trustFingerprint(deps, input),
  };
}
```
`createWorker(deps)` in `connect-server-worker.ts` should call `createServerServices(deps)` exactly this way, then drive `services.connectAndDiscover(...)` per RESEARCH.md Pattern 1's handler body (already concrete, includes `maxStalledCount: 0` + `'stalled'` listener per Common Pitfall #1).

**Non-throwing result contract to preserve** (`connect-and-discover.ts` lines 68-79):
```typescript
export type ConnectAndDiscoverResult =
  | { readonly ok: true; readonly server: ServerView; readonly connection: ConnectionReport; readonly discovery?: DiscoveryReport }
  | { readonly ok: false; readonly code: ConnectAndDiscoverFailureCode; readonly message: string };
```
The job handler must treat `{ ok: false }` as job-completes-with-`{ outcome: code }` (D-15), never job-failed.

---

### `apps/control-plane/src/services/fail-in-flight-connection.ts` (service, CRUD state transition)

**Analog:** `apps/control-plane/src/services/trust-fingerprint.ts` (row-lock + `transition()` + activity-event write + result union — structurally identical to what D-12 needs).

**Row-lock + transition + activity pattern** (mirror of `trust-fingerprint.ts`'s shape, itself mirrored from `delete-server.ts` lines 36-87 and `connect-and-discover.ts` lines 95-133):
```typescript
export async function failInFlightConnection(
  deps: ServerServicesDeps,
  input: { actor: ServiceActor; serverId: string; reason: 'CONNECTION_LOST' },
): Promise<FailInFlightConnectionResult> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(servers).where(eq(servers.id, input.serverId)).for('update');
    if (!row) return { ok: false, code: 'NOT_FOUND', message: `Server "${input.serverId}" not found` };
    if (row.status !== 'CONNECTING') return { ok: true, skipped: true }; // already resolved
    const newStatus = transition(row.status, 'ERROR');
    const [updatedRow] = await tx.update(servers)
      .set({ status: newStatus, lastErrorCode: 'CONNECTION_LOST', updatedAt: deps.now() })
      .where(eq(servers.id, row.id)).returning();
    await writeActivityEvent(tx, {
      actorType: input.actor.type, actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'server', entityId: row.id, action: 'server.connection_attempted',
      outcome: 'failure', errorCode: 'CONNECTION_LOST', metadata: { reason: input.reason },
    }, deps.now());
    return { ok: true, server: toServerView(updatedRow!, /* credentialType */) };
  });
}
```
`transition('CONNECTING', 'ERROR')` is already a valid, unguarded edge — `packages/domain/src/server/server-state.ts` line 34: `CONNECTING: ['CONNECTED', 'UNREACHABLE', 'ERROR']` (no `REASON_REQUIRED` entry for this edge, confirmed lines 50-54). Publish `server.updated` via `deps.events.publish(...)` after the transaction commits, exactly like D-04 requires — see Shared Patterns below for where this hook goes in every phase-3 service.

**This file lives in `services/`** (not `queue/`) specifically so `activity/boundary.test.ts`'s allowlist (lines 31-63, `SERVICES_DIR`/`ACTIVITY_DIR_PREFIX`) keeps passing without modification — a `queue/`-located writer of `writeActivityEvent` would trip the boundary test.

---

### `apps/control-plane/src/events/server-event-publisher.ts` (service/adapter, pub-sub)

**Analog:** `apps/control-plane/src/activity/redaction.ts` (single-binding-module pattern — construct once, export a bound singleton, lines 12-24).

**Single-binding pattern to copy** (`redaction.ts` lines 12-24):
```typescript
export const appRedactor: Redactor = createRedactor();
appRedactor.register(env.NOODARA_MASTER_KEY, 'master_key');
```
`server-event-publisher.ts` follows the same "construct once, export the interface, never let call sites build their own instance" idiom, but as a factory (`createRedisServerEventPublisher(redis)`) since the Redis connection is process-scoped rather than module-scoped — use RESEARCH.md Pattern 2's already-concrete `ServerEventPublisher` interface and `try/catch`-then-`logger.warn` body (D-04's "never throws out of a service call" requirement, structurally identical to how `writeActivityEvent`'s callers never let an activity-log failure abort a state transition).

---

### `apps/control-plane/src/worker.ts` (entrypoint, event-driven boot)

**Analog:** `apps/control-plane/src/server.ts` (full file, 36 lines — the exact `env.js`-first-import + fail-fast + graceful-exit contract to mirror).

**Full pattern to copy** (`server.ts` lines 1-35):
```typescript
import './env.js'; // must be first import — INST-06 fail-fast

import { auth } from './auth/auth.js';
import { bootstrapAdmin } from './boot/bootstrap-admin.js';
import { getDb } from './db/client.js';
import { env } from './env.js';
import { buildApp } from './app.js';

const app = buildApp();

async function main(): Promise<void> {
  const db = await getDb();
  try {
    await bootstrapAdmin({ db, auth, logger: app.log, env });
  } catch (err) {
    app.log.error({ err }, 'Admin bootstrap failed; refusing to start');
    process.exit(1);
    return;
  }
  app.listen({ port: env.PORT, host: '0.0.0.0' }, (err) => {
    if (err) { app.log.error(err); process.exit(1); }
  });
}

void main();
```
`worker.ts` mirrors this shape exactly: `import './env.js'` first, `getDb()`, `resolveServerServicesDeps()` (from `services/server-service-deps.ts` lines 53-68 — already the async, override-friendly resolver phase-4 needs), `createWorker(deps)`, then `SIGTERM`/`SIGINT` handlers per RESEARCH.md's "Graceful worker shutdown racing the D-14 budget" code example (no server-side analog exists for graceful shutdown yet — `server.ts` has none — so this part is new but the entrypoint skeleton above is a direct copy).

---

### `apps/control-plane/src/app.ts` (MODIFIED, composition root)

**Analog:** itself — extend the existing registration list.

**Current pattern to extend** (`app.ts` lines 18-38):
```typescript
export function buildApp(deps: BuildAppDeps = {}): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger ?? createLogger(), trustProxy: env.NOODARA_TRUST_PROXY });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  logMasterKeyWarning(app.log, decodeMasterKey(env.NOODARA_MASTER_KEY));
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(setupRoutes);
  app.register(sessionsRoutes);
  return app;
}
```
Add: `app.register(requireSession, { ... })` inside an encapsulated `fastify.register(async (instance) => { instance.register(requireSession); instance.register(serversRoutes); instance.register(activityRoutes); instance.register(configRoutes); instance.register(eventsRoutes); })` scope (Fastify plugin encapsulation, per RESEARCH.md Pattern 4's closing note) plus `app.setErrorHandler(...)` (Pattern 5) and a `preClose` hook for SSE/Redis cleanup (Anti-Patterns section). `setup.ts`/`sessions.ts`/`health.ts` registrations stay outside that scope, matching D-17/D-18.

---

### `apps/control-plane/src/env.ts` (MODIFIED, config validation)

**Analog:** itself — `parseTuningInt`/`parseTuningBool` already exist and are the exact functions to reuse for the two new variables.

**Pattern to copy** (`env.ts` lines 300-320, applied verbatim for the two new knobs):
```typescript
const sshConnectTimeoutMs = parseTuningInt(
  'NOODARA_SSH_CONNECT_TIMEOUT_MS',
  source.NOODARA_SSH_CONNECT_TIMEOUT_MS,
  10000,
  issues,
  { min: 1000, max: 120000 },
);
```
Add, using the exact same helper:
```typescript
const workerConcurrency = parseTuningInt('NOODARA_WORKER_CONCURRENCY', source.NOODARA_WORKER_CONCURRENCY, 5, issues, { min: 1, max: 20 });
const sseMaxConnections = parseTuningInt('NOODARA_SSE_MAX_CONNECTIONS', source.NOODARA_SSE_MAX_CONNECTIONS, 32, issues, { min: 1, max: 1000 });
```
Add both to the `Env` interface (after line 43) and the final returned object (after line 352), following the exact same ordering convention. `REDIS_URL` is already required (line 23, `validateRequiredString` at line 253) — no change needed there.

---

### `apps/control-plane/src/routes/setup.ts`, `sessions.ts` (MODIFIED — error shape migration)

**Pattern:** in-place migration only. Current error bodies (`setup.ts` lines 19-20: `{ error: z.string() }`, `{ error: z.literal('not_found') }`; `sessions.ts` lines 27-28: `{ error: z.literal('unauthorized') }`, `{ error: z.literal('not_found') }`) become `{ error: 'NOT_FOUND', message }` / `{ error: 'UNAUTHORIZED', message }` per D-18. No structural change to the route/handler shape — same `app.route({ schema, handler })` skeleton, only the literal string values and the addition of a `message` field change. `sessions.ts` additionally drops its own `toFetchHeaders`+`UnauthorizedError` try/catch in favor of `requireSession`'s `onRequest` hook plus `request.actor`.

---

## Shared Patterns

### Result-union error contract (D-16's foundation)
**Source:** every phase-3 service (`register-server.ts`, `edit-server.ts`, `delete-server.ts`, `trust-fingerprint.ts`, `connect-and-discover.ts`) — established, consistent, non-throwing.
**Apply to:** `routes/servers.ts`, `routes/http-errors.ts`, `fail-in-flight-connection.ts`, `queue/connect-server-worker.ts`.
```typescript
export type XFailureCode = 'NOT_FOUND' | 'SERVER_BUSY' | /* ... */;
export type XResult =
  | { readonly ok: true; /* success payload */ }
  | { readonly ok: false; readonly code: XFailureCode; readonly message: string };
```

### Activity-write boundary (ACT-01)
**Source:** `apps/control-plane/src/activity/boundary.test.ts` (full file) + `apps/control-plane/src/activity/write-activity-event.ts` lines 39-66.
**Apply to:** `fail-in-flight-connection.ts` must live under `services/` (not `queue/`) to satisfy `SERVICES_DIR`/`ACTIVITY_DIR_PREFIX` allowlisting (`boundary.test.ts` lines 13-14, 59-63). The worker's job handler in `queue/connect-server-worker.ts` must never call `writeActivityEvent` itself — only through `services.connectAndDiscover`/`failInFlightConnection`.

### Row-lock + `transition()` + post-commit event (state-changing services)
**Source:** `apps/control-plane/src/services/connect-and-discover.ts` lines 95-133 (`lockAndBeginConnecting`), `trust-fingerprint.ts`, `delete-server.ts` lines 36-87.
**Apply to:** `fail-in-flight-connection.ts`.
```typescript
return deps.db.transaction(async (tx) => {
  const [row] = await tx.select().from(servers).where(eq(servers.id, id)).for('update');
  if (!row) return { ok: false, code: 'NOT_FOUND', message: `...` };
  const newStatus = transition(row.status, 'ERROR');
  // ...update + writeActivityEvent(tx, ...) inside the same transaction...
});
```

### Event publishing after commit (D-04, new this phase)
**Source:** RESEARCH.md Pattern 2 (`ServerEventPublisher`), applied at the exact post-transaction point every phase-3 service already returns from — e.g. `connect-and-discover.ts` lines 364-370 (`return { ok: true as const, server: toServerView(...), ... }`) is where `await deps.events.publish({ type: 'server.updated', server })` gets inserted, immediately after the `db.transaction(...)` call resolves (never inside it).
```typescript
export interface ServerEventPublisher {
  publish(event: { type: 'server.updated'; server: ServerView } | { type: 'server.deleted'; id: string }): Promise<void>;
}
```

### `ZodTypeProvider` route skeleton
**Source:** `apps/control-plane/src/routes/setup.ts` (full file), `sessions.ts` (full file), `health.ts` (full file) — identical `FastifyPluginCallback` + `fastify.withTypeProvider<ZodTypeProvider>()` + `app.route({ method, url, schema: { body/params/querystring, response: { <status>: <ZodSchema> } }, handler })` skeleton across all three.
**Apply to:** every new route file (`servers.ts`, `activity.ts`, `config.ts`, `events.ts`).

### `ServiceActor` / dependency-injection resolution
**Source:** `apps/control-plane/src/services/server-service-deps.ts` (full file) — `ServiceActor` type (line 20) and `resolveServerServicesDeps(overrides)` (lines 53-68), already async and override-friendly for tests.
**Apply to:** `worker.ts` (calls `resolveServerServicesDeps()` with no overrides in production), every integration test for routes/queue/events (overrides `ssh`, `now`, and the new `events` field with fakes).

### Testcontainers fixture shape
**Source:** `tests/integration/helpers/postgres.ts` (full file, 57 lines).
**Apply to:** `tests/integration/helpers/redis.ts`.
```typescript
export async function startPostgres(options: StartPostgresOptions = {}): Promise<PostgresFixture> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withLabels({ 'noodara.test': 'true' })
    .start();
  const connectionString = container.getConnectionUri();
  // ...
  let stopped = false;
  const stop = async (): Promise<void> => { if (stopped) return; stopped = true; await pool.end(); await container.stop(); };
  return { container, connectionString, db, stop };
}
```
`redis.ts` copies this shape with `RedisContainer` from `@testcontainers/redis` (`redis:7-alpine`), the same `noodara.test: 'true'` label (required by the CI stray-container check in `.github/workflows/ci.yml`'s `integration`/`security`/`boot-smoke` jobs), and the same idempotent `stop()`.

### Test-env bootstrap for integration tests
**Source:** `tests/integration/helpers/app.ts` lines 20-26 (`setTestEnv`) and `tests/integration/helpers/boot-process.ts` lines 24-39 (`buildValidBootEnv`) — both already set `REDIS_URL = 'redis://localhost:6379'` as a placeholder since Redis isn't required until this phase.
**Apply to:** extend `startTestApp()` to accept the Redis fixture's real connection string and extend `buildValidBootEnv` similarly for `test:boot`'s worker-inclusive smoke test (D-23).

### Canary / redaction pattern for the extended `security:scan-leaks`
**Source:** `tests/integration/activity/canary.test.ts` (full file) — the three-surface canary proof (logger, HTTP error body, `activity_events.metadata`) that D-22 explicitly says extends to HTTP routes and SSE events this phase.
**Apply to:** a new canary assertion covering an SSE `server.updated` payload and a real `POST /api/servers/:id/connect` 4xx/5xx body, reusing `appRedactor.register`/`.release` exactly as at lines 48-49, 112-114.

### CI job pattern (Redis in `integration`/`boot-smoke`)
**Source:** `.github/workflows/ci.yml` `integration` job (full block) and `boot-smoke` job (full block) — both already run `pnpm test:integration` / `pnpm build && pnpm test:boot` with a stray-container check keyed on `label=noodara.test=true`.
**Apply to:** no new CI job needed — `redis.ts`'s `noodara.test=true` label makes the existing stray-container check in both jobs cover Redis containers automatically; only `turbo.json`'s `dev`/`test:boot` `passThroughEnv` arrays need the two new env vars appended (`turbo.json` lines 10-30 is the exact array to extend).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `apps/control-plane/src/routes/events.ts` | route | streaming (SSE) | No existing streaming/hijacked route in this codebase; RESEARCH.md Pattern 3 is the concrete, repo-adapted source to use instead |
| `apps/control-plane/src/events/sse-broadcaster.ts` | service/adapter | pub-sub + streaming | No existing Redis pub/sub or multi-consumer fan-out code; RESEARCH.md Pattern 2 (subscriber half) is the source |
| `apps/control-plane/src/routes/http-errors.ts` | utility | transform | First single code→status map; modeled on the union shapes of five existing services (see Shared Patterns) rather than copied from an existing map |
| `apps/control-plane/src/queue/connect-server-queue.ts` | service (producer) | event-driven | No existing BullMQ usage in the repo; RESEARCH.md's "Three distinct ioredis connections" code example is the source, combined with `server-service-deps.ts`'s override-friendly resolver shape |

## Metadata

**Analog search scope:** `apps/control-plane/src/{routes,services,auth,activity,db,queue,events}/`, `apps/control-plane/src/{app,server,env}.ts`, `packages/domain/src/server/`, `tests/integration/{helpers,activity,services}/`, `.github/workflows/ci.yml`, `turbo.json`, `apps/control-plane/package.json`.
**Files scanned:** ~45 (all non-generated, non-migration files under `apps/control-plane/src` plus the listed test/config files).
**Pattern extraction date:** 2026-09-16
