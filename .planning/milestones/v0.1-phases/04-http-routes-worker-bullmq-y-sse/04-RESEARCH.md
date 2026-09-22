# Phase 4: HTTP routes, worker BullMQ y SSE - Research

**Researched:** 2026-09-16
**Domain:** Fastify HTTP API + BullMQ worker + Redis pub/sub SSE bridge, on top of Phase 3's application services
**Confidence:** HIGH for Fastify/BullMQ/ioredis API shapes (Context7 + official docs, cross-checked against installed versions); MEDIUM for the exact BullMQ stalled/attempts interaction and the ioredis 6.x/RESP3 compatibility risk (WebSearch-derived, not empirically spiked in this session — flagged as an Open Question the planner should gate behind a spike task)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Stream SSE y puente worker → API**
- **D-01:** Un único stream global `GET /api/events` (`text/event-stream`), autenticado por la cookie de sesión como el resto de `/api`. No hay stream por servidor. La lista y el detalle de la fase 5 comparten la misma conexión; activity y deployments añadirán tipos de evento a esta misma ruta más adelante.
- **D-02:** Dos tipos de evento en esta fase: `server.updated` con el `ServerView` completo (mismo shape y misma allowlist de 27 campos que `GET /api/servers/:id`, fase 3 D-19) y `server.deleted` con `{ id }`. No hay un tipo por transición: la UI discrimina por `status`. El test de allowlist de `ServerView` es la garantía de no-fuga del stream.
- **D-03:** El puente entre procesos es Redis pub/sub propio: canal `noodara:server-events`, mensaje JSON `{ type, server | id, at }`. El API mantiene una conexión ioredis dedicada en modo suscriptor (distinta de la de BullMQ) y reenvía cada mensaje a todos los SSE abiertos. No se usan `QueueEvents` de BullMQ ni `LISTEN/NOTIFY` de Postgres.
- **D-04:** Quien publica es el servicio, no el caller: `ServerServicesDeps` gana un puerto `events: ServerEventPublisher` (`publish(event): Promise<void>`) y cada servicio de fase 3 publica **después** de que su transacción confirme (`registerServer`, `editServer`, `trustFingerprint` una vez; `deleteServer` publica `server.deleted`; `connectAndDiscover` publica dos veces: tras TX1 con `CONNECTING` y tras TX2 con el resultado). Un fallo al publicar se loggea a warn y nunca revierte ni hace fallar la operación (Postgres es la verdad; SSE es best-effort). Tests unitarios con un publisher falso; el adaptador Redis vive en un archivo aparte.
- **D-05:** Sin replay ni `Last-Event-ID`: el stream envía `retry:` al abrir y un comentario keepalive cada ~15 s. Cuando `EventSource` reconecta, la UI (fase 5) resincroniza con `GET /api/servers`. El API no guarda buffer de eventos.
- **D-06:** El stream valida la sesión al abrir (401 `{ error: 'UNAUTHORIZED' }` sin abrir el stream) y **re-valida en cada heartbeat**; si la sesión expiró o fue revocada, cierra el stream.
- **D-07:** Límite de conexiones SSE simultáneas por proceso API: `NOODARA_SSE_MAX_CONNECTIONS` validado en `env.ts` con `parseTuningInt` (default 32). Al superarlo el API responde 503 `{ error: 'SSE_LIMIT_REACHED' }` con `Retry-After`. Todas las conexiones se cierran al apagar el servidor.

**Jobs de connect y discover**
- **D-08:** `POST /api/servers/:id/connect` y `POST /api/servers/:id/discover` comprueban que el servidor existe (404) y no está `CONNECTING` (409 `ALREADY_CONNECTING`), encolan y responden **202** `{ server: ServerView, jobId }`. `jobId` es solo para logs/correlación, nunca para polling. Nunca se espera al job dentro de la petición.
- **D-09:** Dedupe en dos capas: `jobId` determinista `connect:<serverId>` (BullMQ ignora un segundo `add` mientras el anterior esté `waiting`/`active`, la ruta responde 202 idempotente con el mismo `jobId`); si aun así dos jobs llegan al worker, el `SELECT ... FOR UPDATE` de fase 3 (D-05) devuelve `ALREADY_CONNECTING`. No se añade columna `pending_job_id`.
- **D-10:** Un solo tipo de job `connect-server` y un solo handler para ambas rutas, llamando al mismo `connectAndDiscover`. `/discover` responde 409 `SERVER_NOT_CONNECTED` si el servidor no está `CONNECTED`; `/connect` vale desde cualquier estado distinto de `CONNECTING`.
- **D-11:** Payload del job: `{ serverId, actor, requestedAt, trigger: 'connect' | 'discover' }`, `actor` exactamente como fase 3 D-17 (`{ type: 'user', id }`); nunca host, usuario ni credencial. El payload se valida con Zod al consumir.
- **D-12:** Sin reintentos BullMQ (`attempts: 1`). Cuando un job queda `stalled` porque el worker murió a mitad, el worker que lo recupera **no vuelve a conectar**: llama a un servicio nuevo `failInFlightConnection({ serverId, actor, reason })` que, bajo lock de fila, transiciona `CONNECTING → ERROR` con `last_error_code = CONNECTION_LOST`, escribe `server.connection_attempted` (`outcome: failure`) y publica `server.updated`. Al arrancar, el worker recorre los servidores en `CONNECTING` sin job activo en la cola y les aplica el mismo servicio. Un servidor nunca queda en `CONNECTING` indefinidamente.
- **D-13:** Encolar no escribe evento de activity; la ruta loggea a `info` con `serverId`, `jobId` y `trigger`.
- **D-14:** El job no tiene timeout propio. `lockDuration` y `stalledInterval` se derivan de `NOODARA_SSH_*` con margen: `connectMs × 2 + 2000 + discoveryMs + 30000` ms.
- **D-15:** Un resultado `{ ok: false, code }` del servicio es un desenlace esperado → el job **completa** (`{ outcome: code }`), log a `warn`. Solo una excepción real (Postgres caído, bug) marca el job `failed`, log a `error` sin payload completo ni datos sensibles. `failed` en BullMQ siempre significa bug o infraestructura.

**Contrato de la API HTTP**
- **D-16:** Un único mapa código → status en un helper testeado (`http-errors.ts`): `VALIDATION_FAILED`, `INVALID_CREDENTIAL` → 400; `UNAUTHORIZED` → 401; `NOT_FOUND` → 404; `NAME_TAKEN`, `HOST_TAKEN`, `SERVER_BUSY`, `ALREADY_CONNECTING`, `SERVER_NOT_CONNECTED`, `NO_PENDING_FINGERPRINT`, `CONFIRMATION_MISMATCH` → 409; `QUEUE_UNAVAILABLE`, `SSE_LIMIT_REACHED` → 503; `INTERNAL_ERROR` → 500. Body siempre `{ error: '<CODE>', message }`. Errores de esquema Zod se normalizan al mismo shape con `error: 'VALIDATION_FAILED'` y `issues: [{ path, message }]`.
- **D-17:** Guard de sesión como plugin `requireSession`: hook `onRequest` que llama a `auth.api.getSession`, responde 401 si no hay sesión y decora `request.actor = { type: 'user', id }`. Se registra en un scope encapsulado que agrupa `/api/servers`, `/api/activity`, `/api/config` y `/api/events`. Fuera del guard: `/health`, `/api/auth/*`, `/api/setup`, `/api/recovery`.
- **D-18:** Rutas existentes migran **sin cambiar semántica**: `setup.ts`/`sessions.ts` pasan al shape `{ error: 'UPPER_SNAKE', message }`, `sessions.ts` usa `requireSession`, `health.ts` deja el `'0.0.0'` fijo. `auth.ts` no se toca; `app.ts` sí.
- **D-19:** Recursos: `POST /api/servers` → 201 `ServerView`; `GET /api/servers` → 200 `{ items: ServerView[] }` ordenado por `name`, sin paginar; `GET /api/servers/:id` → 200 `ServerView`; `PATCH /api/servers/:id` → 200 `ServerView` (body parcial, `EditServerInput`, credencial nunca en la respuesta); `DELETE /api/servers/:id` con `{ confirmName }` → 200 `{ ok: true, serverId }`; `POST /api/servers/:id/trust-fingerprint` → 200 `ServerView`.
- **D-20:** `GET /api/activity` → 200 `{ items, nextCursor }`, keyset por `(occurred_at desc, id desc)`: `?limit=50` (1–200) `&cursor=<opaco base64url>`. Sin filtros ni búsqueda.
- **D-21:** `GET /api/config` → 200 `{ version, publicUrl, masterKeyFingerprint, sshTimeouts, workerConcurrency }`: `version` leída de `package.json` en build, no un literal. `health.ts` reutiliza la misma fuente de `version`. Sin tabla `settings` ni `PUT`.
- **D-22:** Error handler global (`app.setErrorHandler`): toda excepción no controlada responde 500 `{ error: 'INTERNAL_ERROR', message: 'Internal error' }`, loggea `appRedactor.redact(error.message)` + `requestId`. El proceso sigue vivo. `security:scan-leaks` se extiende a las rutas HTTP y a eventos SSE.

**Proceso worker y operación**
- **D-23:** `apps/control-plane/src/worker.ts` es el segundo entrypoint. Importa `./env.js` primero, abre Postgres y Redis, resuelve `ServerServicesDeps` y crea el worker con `createWorker(deps)`. Scripts: `dev` arranca api y worker en paralelo (`tsx watch` de ambos, vía `concurrently` o dos tareas turbo), `start` = `node dist/server.js`, `start:worker` = `node dist/worker.js`. `pnpm test:boot` añade el arranque real del worker.
- **D-24:** `NOODARA_WORKER_CONCURRENCY` validada en `env.ts` (default 5, rango 1–20).
- **D-25:** Apagado limpio: en `SIGTERM`/`SIGINT` el worker deja de tomar jobs y espera a los activos con `worker.close()` hasta el presupuesto de D-14; si se excede, sale igual. El API cierra los SSE abiertos y la suscripción Redis al apagar. Al arrancar el worker exige Postgres y Redis (fail-fast); en vida, reconecta a Redis solo (backoff, log a `warn`, nunca `process.exit`); un Postgres caído dentro de un job lo marca `failed` sin reintento.
- **D-26:** Heartbeat `noodara:worker:<workerId>` en Redis, TTL 30s cada ~10s. `GET /health` → 200 `{ status: 'ok' | 'degraded', version, checks: { postgres, redis, worker } }`. `degraded` sigue siendo 200. Postgres caído en `/health` es 503. El worker no abre puerto HTTP.
- **D-27:** Redis caído en el API: el API arranca y sirve CRUD/activity/config sin Redis. `POST connect/discover` intenta `queue.add` con timeout corto (~2s) y responde 503 `QUEUE_UNAVAILABLE`. `/api/events` acepta la conexión y manda heartbeats aunque la suscripción esté caída; ioredis reconecta y re-suscribe solo. Ningún fallo de Redis lanza fuera de un handler.
- **D-28:** Cola BullMQ `servers`, job name `connect-server`; `prefix: 'noodara'` en BullMQ y todas las claves propias. `removeOnComplete: { count: 100 }`, `removeOnFail: { count: 500 }`. ioredis con `maxRetriesPerRequest: null` en la conexión del worker; conexiones separadas para cola, suscriptor y publicador. STACK.md apunta BullMQ 6.3.4 como referencia — research verifica la versión exacta abajo.
- **D-29:** Same-origin: la UI de fase 5 proxya `/api/*`. El API no registra `@fastify/cors`. Cookies `SameSite=Lax`. Defensa CSRF barata: rutas de mutación rechazan con 403 `FORBIDDEN_ORIGIN` un header `Origin` presente y distinto de `NOODARA_PUBLIC_URL` (ausente = permitido).
- **D-30:** Sin rate limit en rutas de mutación en v0.1. `@fastify/rate-limit` no se añade.

**Testing**
- **D-31:** `tests/integration/helpers/redis.ts` arranca `redis:7-alpine` con Testcontainers, etiqueta `noodara.test=true`. El worker se instancia in-process con `createWorker(deps)`, `SshPort` falso para rutas y sshd real de fase 2 para un E2E de API. Cubre: dedupe, `discover` sobre no-CONNECTED → 409, stalled → `failInFlightConnection`, recuperación al arrancar, Redis caído → 503, cierre de SSE por sesión revocada, límite de SSE → 503, `Origin` distinto → 403.
- **D-32:** Unit: rutas con `app.inject` y `ServerServices` falsos; publisher/suscriptor Redis con fakes estructurales; `requireSession` con `getSession` falso; cálculo de `lockDuration` como función pura. CI: `integration` añade Redis; `boot-smoke` arranca api + worker con Redis y comprueba `/health` con `worker: pass`; `security` amplía `security:scan-leaks`.

### Claude's Discretion
- Nombres exactos de archivos y plugins (`routes/servers.ts`, `routes/activity.ts`, `routes/config.ts`, `routes/events.ts`, `auth/require-session.ts`, `queue/`, `events/`), mientras respeten la estructura de `apps/control-plane/src/` y el boundary test de fase 3.
- Formato del cursor de activity y del `workerId`.
- Cómo se comparte `version` entre `health.ts` y `config.ts` (constante generada en build o lectura de `package.json` con `createRequire`), respetando ADR 0003.
- Detalles de la implementación SSE en Fastify 5 (`reply.raw` con `hijack()` frente a un plugin), siempre que guard/heartbeat/re-validación/cierre de D-05..D-07 se cumplan.
- Forma exacta de `failInFlightConnection` y del recorrido de `CONNECTING` al arrancar (consulta a la cola por `jobId` determinista vs. `getJob`).
- Si el `Origin` check de D-29 es un hook del scope de mutaciones o parte de `requireSession`.

### Deferred Ideas (OUT OF SCOPE)
- Rate limit por sesión/IP en rutas de mutación — post multiusuario/API keys.
- Replay de eventos SSE con `Last-Event-ID` / Redis Streams — v0.3+.
- Cola `deployments` separada y tipos de job adicionales — v0.3.
- Configuración global editable (`settings` + `PUT /api/config`) — post v0.1.
- Evento de activity `server.connection_requested` al encolar — descartado.
- Stream SSE por servidor — descartado.
- Puerto HTTP propio en el worker — descartado.
- CORS con credentials — descartado para v0.1.
- Timeout de job por env var — descartado; presupuesto derivado de timeouts SSH.
- Filtros, búsqueda y export del activity log — fuera de alcance.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SERV-06 | El admin dispara "Connect" explícitamente; la conexión corre en el worker en segundo plano y el estado se refleja en la UI en tiempo real vía SSE sin recargar. | BullMQ Queue/Worker patterns (§Standard Stack, §Code Examples: job enqueue with deterministic jobId, worker handler delegating to `connectAndDiscover`), Redis pub/sub bridge pattern (§Architecture Patterns: Pattern 2), Fastify SSE route pattern (§Code Examples: SSE route with hijack/heartbeat/onRequest re-validation) |
| DISC-05 | El admin puede volver a ejecutar el discovery bajo demanda desde el detalle del servidor. | Same `connect-server` job/handler reused for `/discover` (§Architecture Patterns: Pattern 1 — one job type, two route preconditions), `SERVER_NOT_CONNECTED` in the D-16 error map |
</phase_requirements>

## Summary

This phase wires Phase 3's application services to HTTP, a BullMQ worker and a Redis-pub/sub-fed SSE stream, without changing any service contract. The three moving pieces — Fastify routes, the BullMQ `connect-server` job, and the `/api/events` SSE stream — are all thin: routes validate + map error codes, the worker calls the exact same `connectAndDiscover`/`failInFlightConnection` services the routes would call synchronously if blocking were acceptable, and the SSE stream is a dumb relay of whatever `ServerEventPublisher.publish()` pushes onto `noodara:server-events`. The riskiest technical details are not "how do I write a Fastify route" (well-trodden) but three specific interaction effects: (1) BullMQ's stalled-job recovery semantics under `attempts: 1` can silently *reprocess* the job once before failing it — the planner must decide `maxStalledCount: 0` or event-driven handling to make D-12's "never reconnect on stalled recovery" hold; (2) `ioredis` just shipped a `6.0.0` major (RESP3-by-default, Node ≥20) barely a month before this research, while BullMQ 6.x only declares `ioredis: ">=5.0.0"` as an *optional* peer with no explicit 6.x validation on record — pinning the last 5.x line is the safer default; (3) Fastify v5's `decorateRequest` refuses a raw object default (throws at boot), so `request.actor` must be decorated as `null` first and set inside the `onRequest` hook, not decorated with an object literal.

**Primary recommendation:** Use `bullmq@6.3.6` + `ioredis@5.11.1` (not `6.0.0` — see Open Questions) + `@testcontainers/redis@12.1.0`; implement SSE with `reply.hijack()` + `reply.raw` (no `@fastify/sse` plugin — it doesn't fit the multi-consumer pub/sub-fed broadcast shape this phase needs); close SSE streams and the BullMQ worker in a `preClose` hook (not `onClose`, which runs after Fastify's connection-drain phase and would hang waiting for streams that never end on their own); and route both `/connect` and `/discover` through one `connect-server` BullMQ job whose handler is a ~15-line wrapper around the Phase 3 services.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Server CRUD (register/edit/delete/trust-fingerprint) HTTP surface | API / Backend (Fastify routes) | — | Routes only validate + map service results; no business logic (ARCHITECTURE.md §3) |
| Connect/discover orchestration | API / Backend (BullMQ worker, same process family) | — | SSH is multi-second I/O; must run off the HTTP request thread (SERV-06) — worker is a delivery mechanism for the same application service, not a second implementation |
| Real-time status push | API / Backend (Fastify SSE route + Redis pub/sub) | Browser (EventSource, fase 5) | One-directional server→browser push; SSE chosen over WebSocket per ARCHITECTURE.md §7 (no client→server streaming need in v0.1) |
| Job queue / dedupe / stalled recovery | API / Backend (BullMQ Queue + Worker) | Database / Storage (Redis) | Redis is the durability boundary for in-flight job state only; Postgres remains the source of truth for `Server.status` (D-27) |
| Activity log pagination | API / Backend (Fastify route + Drizzle keyset query) | Database / Storage (Postgres index) | Read-only projection of `activity_events`; no new write path (ACT-01 boundary unchanged) |
| Session/auth guard | API / Backend (`requireSession` Fastify plugin) | — | Delegates to Better Auth's `getSession`; decorates `request.actor` for every downstream service call |
| CSRF-lite Origin check | API / Backend (Fastify `onRequest` hook) | — | Same-origin proxy topology (D-29) makes this a backend-only check; no browser-side component |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bullmq` | **6.3.6** [VERIFIED: npm registry] | Job queue: `connect-server` job type, `Queue`/`Worker` | Confirmed on npm registry; `repository.url` resolves to `github.com/taskforcesh/bullmq` (matches Context7's `/taskforcesh/bullmq`, "High" source reputation). `slopcheck scan --pkg npm bullmq` → `OK`. Already the project's locked stack choice (STACK.md, ARCHITECTURE.md §3/§9) — this research only re-verifies the exact patch version and API shape. |
| `ioredis` | **5.11.1** (recommend — NOT the newly-released `6.0.0`) [VERIFIED: npm registry, version choice ASSUMED — see Open Questions] | Three dedicated Redis connections: BullMQ backend, pub/sub subscriber, pub/sub publisher | `ioredis` itself is legitimate (`repository.url` → `github.com/redis/ioredis`, Context7 `/redis/ioredis`, `slopcheck` → `OK`). The *version pin* is this research's own risk-averse recommendation, not a verified compatibility fact — see Open Questions for why `6.0.0` is flagged. |
| `@testcontainers/redis` | **12.1.0** [VERIFIED: npm registry + official docs] | Ephemeral `redis:7-alpine` container for integration tests (D-31) | Same major version as the already-pinned `testcontainers@12.1.0`/`@testcontainers/postgresql@12.1.0` (keeps the whole testcontainers-node family in lockstep, matching this repo's existing `postgres.ts` pattern). `repository.url` → `github.com/testcontainers/testcontainers-node`. `slopcheck` → `OK`. Official docs (node.testcontainers.org) confirm `RedisContainer` + `getConnectionUrl()` API. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `concurrently` | 10.0.5 [ASSUMED — package name recalled from training data, not resolved via Context7/official docs; slopcheck `OK`, no postinstall script, repo matches `open-cli-tools/concurrently`] | Runs `tsx watch src/server.ts` and `tsx watch src/worker.ts` in one `pnpm dev` invocation (D-23) | Only if the team prefers a single new devDependency over duplicating turbo tasks. **Recommended default is the zero-dependency alternative below** — see Architecture Patterns. |
| `@fastify/type-provider-zod` | 1.0.0 (already pinned, ADR 0001) | `hasZodFastifySchemaValidationErrors` for the D-16 Zod-error-normalization branch in the global error handler | Every new route in this phase; the error-handler helper specifically |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled SSE via `reply.hijack()` + `reply.raw` | `@fastify/sse` (official plugin, Context7 `/fastify/sse`, benchmark 93.47) | `@fastify/sse` is built around one response per SSE session with its own session/replay management (`bufferSize`, `retentionMs`) — it does not natively express "many independent SSE sessions all fed by one shared Redis pub/sub subscription." Adopting it would mean fighting its session abstraction to bolt on the D-03 fan-out, for no benefit over ~20 lines of hand-written `reply.raw.write()` calls that already match D-05's minimal `retry:` + heartbeat-comment contract. Revisit if a future phase needs SSE replay/`Last-Event-ID` (already deferred, see Deferred Ideas). |
| `concurrently` for `pnpm dev` | Two Turborepo tasks (`dev:api`, `dev:worker`) declared in `turbo.json`, both `persistent: true` + the same `passThroughEnv` list | Zero new dependency, reuses the exact `dev` task shape ADR 0003 already established. The only cost is a second `passThroughEnv` block in `turbo.json` (copy-paste) and a second npm script (`dev:worker`) in `apps/control-plane/package.json`. **This is the recommended default** — matches this codebase's demonstrated aversion to adding tooling dependencies (no `zx`, POSIX `sh` installer). |
| `worker.on('stalled', ...)` direct handling | Waiting for BullMQ's `'failed'` event and pattern-matching the error message (`"job stalled more than allowable limit"`) | The `'failed'`-message-matching approach is fragile (relies on an undocumented exact string) and only fires *after* `maxStalledCount` is exhausted, whereas `'stalled'` fires on every stall detection — acting on `'stalled'` directly is both more explicit and fires exactly once per stall, matching D-12's "the worker that recovers it" language literally. |

**Installation:**
```bash
pnpm --filter @noodara/control-plane add bullmq@6.3.6 ioredis@5.11.1
pnpm add -D @testcontainers/redis@12.1.0
# Only if the concurrently route is chosen over the two-turbo-tasks alternative:
pnpm --filter @noodara/control-plane add -D concurrently@10.0.5
```

**Version verification:** ran directly in this research session —
```bash
npm view bullmq version               # 6.3.6
npm view ioredis version              # 6.0.0 (latest) — 5.11.1 is the last pre-RESP3 release
npm view @testcontainers/redis version # 12.1.0
npm view bullmq repository.url         # git+https://github.com/taskforcesh/bullmq.git
npm view ioredis repository.url        # git+https://github.com/redis/ioredis.git
npm view @testcontainers/redis repository.url # git+https://github.com/testcontainers/testcontainers-node.git
npm view bullmq@6.3.6 peerDependencies # { pg: '>=8.0.0', redis: '>=5.0.0', ioredis: '>=5.0.0', 'bullmq-otel': '>=2.0.0' }
```
No `postinstall` script on any of `bullmq`, `ioredis`, `@testcontainers/redis`, or `concurrently` (checked via `npm view <pkg> scripts.postinstall`, all empty).

## Package Legitimacy Audit

| Package | Registry | Age (first publish of current major) | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-------------|-----------|-------------|
| bullmq | npm | long-established, `6.x` line active | `github.com/taskforcesh/bullmq` | `[OK]` | Approved — matches existing STACK.md decision, repo verified |
| ioredis | npm | long-established, `5.x` line stable since 2022; `6.0.0` published 2026-07-31 | `github.com/redis/ioredis` | `[OK]` | Approved for `5.11.1`; `6.0.0` flagged `[SUS-BY-RESEARCH]` — see Open Questions (not a slopcheck finding — a compatibility-risk finding from this research) |
| @testcontainers/redis | npm | long-established (same release train as already-approved `testcontainers@12.1.0`) | `github.com/testcontainers/testcontainers-node` | `[OK]` | Approved |
| concurrently | npm | long-established (`10.x` line) | `github.com/open-cli-tools/concurrently` | `[OK]` | Approved *only if* the planner chooses this route over the zero-dependency turbo-tasks alternative; tag `[ASSUMED]` (package name recalled from training data, never resolved via Context7 in this session) — planner should add a `checkpoint:human-verify` before this specific install if chosen |

**Packages removed due to slopcheck `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none by slopcheck itself. `ioredis@6.0.0` is flagged by this research (not slopcheck) as a *version-compatibility* risk, not a legitimacy risk — the package is genuine, the concern is whether BullMQ 6.3.6 has been validated against ioredis's new RESP3-by-default wire protocol.

## Architecture Patterns

### System Architecture Diagram

```text
Browser (fase 5)
   │
   │ POST /api/servers/:id/connect  (cookie session)
   ▼
┌─────────────────────────── apps/control-plane: api process ───────────────────────────┐
│  requireSession (onRequest hook) ──▶ decorates request.actor                          │
│       │                                                                               │
│       ▼                                                                               │
│  routes/servers.ts: validate params/body (Zod) → call ServerServices.connectAndDiscover│
│  is NOT called directly — instead:                                                    │
│       │                                                                               │
│       ▼                                                                               │
│  queue.add('connect-server', payload, { jobId: 'connect:<id>', attempts: 1, ... })     │
│       │  (ioredis conn #1: Queue producer, commandTimeout ~2s — D-27)                 │
│       │                                                                               │
│       ▼  responds 202 { server, jobId } — never waits for the job                     │
└───────┼─────────────────────────────────────────────────────────────────────────────┘
        │  BullMQ (Redis: queue "servers", prefix "noodara")
        ▼
┌─────────────────────────── apps/control-plane: worker process ────────────────────────┐
│  Worker('servers', handler, { concurrency: NOODARA_WORKER_CONCURRENCY, ... })          │
│       │  (ioredis conn: maxRetriesPerRequest: null — required by BullMQ)              │
│       ▼                                                                               │
│  handler(job): validate payload (Zod) → resolveServerServicesDeps() → same             │
│  ServerServices.connectAndDiscover(deps, { actor, serverId })  [Phase 3, unchanged]    │
│       │                                                                               │
│       ├─▶ Postgres: TX1 (CONNECTING lock) → publish server.updated → SSH work →        │
│       │            TX2 (result) → publish server.updated                              │
│       │                                                                               │
│  worker.on('stalled', jobId) ──▶ failInFlightConnection(...) [never re-runs SSH]       │
└───────┼─────────────────────────────────────────────────────────────────────────────┘
        │  ServerEventPublisher.publish() → redis.publish('noodara:server-events', json)
        │  (ioredis conn #2: dedicated publisher, shared by all Phase-3 services + worker)
        ▼
┌─────────────────────────── apps/control-plane: api process (same as above) ───────────┐
│  dedicated subscriber connection (ioredis conn #3, autoResubscribe: true default)       │
│       │  redis.on('message', (channel, msg) => forward to every open SSE reply.raw)    │
│       ▼                                                                               │
│  GET /api/events (SSE) ──▶ reply.hijack() + reply.raw.write('event: server.updated...')│
└───────┼─────────────────────────────────────────────────────────────────────────────┘
        │  text/event-stream, keepalive comment every ~15s, session re-validated per heartbeat
        ▼
Browser EventSource (fase 5) — no polling
```

### Recommended Project Structure

```
apps/control-plane/src/
├── worker.ts                 # NEW — second entrypoint, mirrors server.ts's env-first-import contract
├── app.ts                    # MODIFIED — registers requireSession scope, error handler, SSE route, Origin guard
├── queue/
│   ├── connect-server-queue.ts   # Queue instance + queue.add wrapper with commandTimeout
│   ├── connect-server-worker.ts  # createWorker(deps): Worker instance + job handler + stalled listener
│   └── job-payload.ts            # Zod schema for the job payload (D-11)
├── events/
│   ├── server-event-publisher.ts # ServerEventPublisher: Redis publish adapter (implements Phase 3's port)
│   └── sse-broadcaster.ts        # subscriber connection + fan-out to open SSE replies
├── routes/
│   ├── servers.ts            # NEW — CRUD + connect/discover/trust-fingerprint routes
│   ├── activity.ts           # NEW — GET /api/activity with keyset pagination
│   ├── config.ts             # NEW — GET /api/config
│   ├── events.ts             # NEW — GET /api/events (SSE)
│   ├── http-errors.ts        # NEW — single code→status map (D-16)
│   ├── setup.ts, sessions.ts # MODIFIED — migrated to { error: 'UPPER_SNAKE', message } shape
│   └── health.ts             # MODIFIED — real version + postgres/redis/worker checks
└── auth/
    └── require-session.ts    # NEW — Fastify plugin, decorates request.actor
```

### Pattern 1: One job type, two route preconditions (SERV-06 + DISC-05)

**What:** `connect-server` is the only BullMQ job name. Both `POST /servers/:id/connect` and `POST /servers/:id/discover` enqueue it with the same payload shape (`trigger` field differs only for logging); the worker handler is a single ~15-line function that always calls `connectAndDiscover`.
**When to use:** Any time two HTTP actions must share one background execution path with different HTTP-level preconditions (404/409 checks live in the route, not the job).
**Example:**
```typescript
// routes/servers.ts — shared by both endpoints, precondition differs
async function enqueueConnect(
  services: ServerServices,
  queue: Queue,
  serverId: string,
  actor: ServiceActor,
  trigger: 'connect' | 'discover',
): Promise<{ code: 'NOT_FOUND' | 'ALREADY_CONNECTING' | 'SERVER_NOT_CONNECTED' } | { jobId: string; server: ServerView }> {
  const server = await services.getServerOrNull(serverId); // read-only lookup, not a service mutation
  if (!server) return { code: 'NOT_FOUND' };
  if (server.status === 'CONNECTING') return { code: 'ALREADY_CONNECTING' };
  if (trigger === 'discover' && server.status !== 'CONNECTED') return { code: 'SERVER_NOT_CONNECTED' };

  const jobId = `connect:${serverId}`;
  const job = await queue.add(
    'connect-server',
    { serverId, actor, requestedAt: new Date().toISOString(), trigger },
    { jobId, attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } },
  );
  return { jobId: job.id!, server };
}
```
```typescript
// queue/connect-server-worker.ts — the one handler both routes ultimately drive
export function createWorker(deps: ServerServicesDeps): Worker {
  const services = createServerServices(deps);
  const worker = new Worker(
    'servers',
    async (job) => {
      const payload = JobPayloadSchema.parse(job.data); // never let a malformed job crash the worker
      const result = await services.connectAndDiscover({ actor: payload.actor, serverId: payload.serverId });
      if (!result.ok) {
        job.log(`connectAndDiscover returned ${result.code}`);
        return { outcome: result.code }; // D-15: an expected failure code completes the job
      }
      return { outcome: 'ok' };
    },
    { connection: workerRedis, concurrency: env.NOODARA_WORKER_CONCURRENCY, prefix: 'noodara',
      lockDuration: computeLockDurationMs(env), stalledInterval: computeLockDurationMs(env),
      maxStalledCount: 0 }, // see Common Pitfalls: prevents silent double-processing
  );

  worker.on('stalled', async (jobId) => {
    const job = await Job.fromId(worker, jobId);
    if (!job) return;
    const payload = JobPayloadSchema.parse(job.data);
    await failInFlightConnection(deps, { serverId: payload.serverId, actor: payload.actor, reason: 'CONNECTION_LOST' });
  });

  return worker;
}
```

### Pattern 2: Redis pub/sub bridge, decoupled from BullMQ (D-03)

**What:** A single Redis channel (`noodara:server-events`) carries `{ type, server | id, at }` JSON messages. The publisher side is a thin `ServerEventPublisher` adapter Phase 3's services call through a new `deps.events` port; the subscriber side lives only in the API process and fans out to every open SSE `reply.raw`.
**When to use:** Any one-directional, best-effort, low-frequency status push where losing a message on a Redis restart is acceptable (D-05: no replay, UI resyncs via GET on reconnect).
**Example:**
```typescript
// events/server-event-publisher.ts
import type Redis from 'ioredis';
export interface ServerEventPublisher {
  publish(event: { type: 'server.updated'; server: ServerView } | { type: 'server.deleted'; id: string }): Promise<void>;
}
export function createRedisServerEventPublisher(redis: Redis): ServerEventPublisher {
  return {
    async publish(event) {
      try {
        await redis.publish('noodara:server-events', JSON.stringify({ ...event, at: new Date().toISOString() }));
      } catch (err) {
        // D-04: never throws out of a service call — SSE is best-effort, Postgres is the truth
        logger.warn({ err }, 'failed to publish server event');
      }
    },
  };
}
```
```typescript
// events/sse-broadcaster.ts — subscriber side, lives once per API process
const subscriber = redisConnection.duplicate(); // D-03: distinct from the Queue's connection
subscriber.on('error', (err) => logger.warn({ err }, 'sse subscriber redis error')); // never throws unhandled
await subscriber.subscribe('noodara:server-events');
const openReplies = new Set<FastifyReply>();
subscriber.on('message', (_channel, message) => {
  for (const reply of openReplies) {
    reply.raw.write(`event: message\ndata: ${message}\n\n`);
  }
});
```

### Pattern 3: SSE route with session re-validation and heartbeat (D-05, D-06, D-07)

**What:** `GET /api/events` hijacks the reply, writes SSE headers manually, re-checks the session on every heartbeat tick, and unregisters itself from the broadcaster set on disconnect.
**Example:**
```typescript
// routes/events.ts
fastify.get('/api/events', async (request, reply) => {
  if (openReplies.size >= env.NOODARA_SSE_MAX_CONNECTIONS) {
    await reply.code(503).header('Retry-After', '5').send({ error: 'SSE_LIMIT_REACHED' });
    return;
  }
  // requireSession's onRequest hook already 401'd an anonymous caller before this handler runs.
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write('retry: 5000\n\n'); // D-05

  openReplies.add(reply);
  const heartbeat = setInterval(async () => {
    const session = await auth.api.getSession({ headers: toFetchHeaders(request.headers) });
    if (!session?.session) {
      cleanup();
      reply.raw.end();
      return;
    }
    reply.raw.write(': keepalive\n\n'); // D-05 — comment line, ignored by EventSource, keeps proxies open
  }, 15_000);

  function cleanup(): void {
    clearInterval(heartbeat);
    openReplies.delete(reply);
  }
  request.raw.on('close', cleanup); // detect client disconnect (Fastify Detecting-When-Clients-Abort guide)
});
```

### Pattern 4: `requireSession` decorating `request.actor` (research question 3)

**What:** Fastify v5's `decorateRequest` throws at boot if given a reference-type default — must decorate with `null`, then assign the real value inside `onRequest`.
```typescript
// auth/require-session.ts
declare module 'fastify' {
  interface FastifyRequest {
    actor: ServiceActor | null;
  }
}

export default fp(async (fastify) => {
  fastify.decorateRequest('actor', null); // NOT decorateRequest('actor', { type: 'user', id: '' }) — throws
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
Registered once, inside the encapsulated scope covering `/api/servers`, `/api/activity`, `/api/config`, `/api/events` — Fastify's plugin encapsulation means an `onRequest` hook added inside one `fastify.register(async (instance) => {...})` call applies only to routes registered in that same context and its children, never to sibling top-level routes (`/health`, `/api/auth/*`, `/api/setup`) — this is what makes D-17's "outside the guard" list work without an explicit allowlist/denylist branch.

### Pattern 5: Zod validation-error normalization in the global error handler (research question 3)

```typescript
// app.ts
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from '@fastify/type-provider-zod';

app.setErrorHandler((error, request, reply) => {
  if (hasZodFastifySchemaValidationErrors(error)) {
    reply.code(400).send({
      error: 'VALIDATION_FAILED',
      message: 'Request does not match the schema',
      issues: error.validation.map((issue) => ({ path: issue.instancePath, message: issue.message })),
    });
    return;
  }
  if (isResponseSerializationError(error)) {
    // A response schema mismatch is always a server bug, never a client-caused 4xx.
    request.log.error({ err: error }, 'response failed schema validation');
    reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal error' });
    return;
  }
  // D-22: opaque 500 for everything else, redacted before logging.
  request.log.error({ message: appRedactor.redact(error.message), requestId: request.id }, 'unhandled error');
  reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal error' });
});
```

### Pattern 6: `version` read from `package.json` without breaking ADR 0003 (D-21)

Both `src/` (via `tsx watch`) and `dist/` (via plain `node`) sit as siblings one level below `apps/control-plane/package.json` — confirmed by inspecting `tsconfig.build.json` (`rootDir: "src"`, `outDir: "dist"`) and `scripts/copy-migration-assets.mjs`'s own `path.resolve(HERE, '..')` pattern. A relative `../../package.json` from any file at depth 1 (`src/config-version.ts` / `dist/config-version.js`) resolves identically in both dev and prod — no build-time constant or asset copy needed.
```typescript
// config-version.ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const CONTROL_PLANE_VERSION: string = (require('../package.json') as { version: string }).version;
```
Note the path is `../package.json` (one level, not two) if this file lives directly in `src/`/`dist/`; adjust the relative depth to match wherever the file actually lands — the key finding is that `dist` and `src` have identical relative depth to the package root, not the exact literal string.

### Pattern 7: Keyset pagination for `GET /api/activity` (D-20)

Verified against Drizzle's own cursor-pagination guide — the two-column tuple comparison for `(occurred_at desc, id desc)`:
```typescript
// routes/activity.ts — the query shape (occurred_at desc, id desc), Drizzle-verified pattern
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
  .limit(limit + 1); // fetch one extra to compute nextCursor / hasMore
```
The existing `activity_events_occurred_at_idx` (single-column, `occurred_at desc`, from Phase 1) is sufficient for v0.1's stated scale ("decenas de servidores", no filters); a composite `(occurred_at desc, id desc)` index would be strictly better for tie-breaking at the same timestamp but is not required to meet this phase's success criteria — note as a nice-to-have, not a blocker.

### Anti-Patterns to Avoid

- **Closing SSE streams in `onClose` instead of `preClose`:** Fastify's `onClose` hook runs *after* the server stops listening and *after* in-flight connections drain — an open SSE stream (which by design never "finishes" on its own) is exactly the kind of connection that would keep that drain phase from ever completing, hanging `app.close()`/`fastify.close()` indefinitely. Fastify's own docs give this exact WebSocket example under `preClose`, explicitly to solve this problem for long-lived streaming connections. Use `preClose` to end every open SSE reply and unsubscribe the Redis subscriber; use `onClose` only for connection-pool-style cleanup with no in-flight streams.
- **Waiting on `app.inject()`'s returned promise for an SSE route in tests:** `inject()` resolves only when the response ends — an SSE response that never ends (by design) will hang the test forever. Use `app.inject({ ..., payloadAsStream: true })` and read `response.stream()` as a `Readable`, asserting on individual chunks, then destroy the stream to end the test — or use `app.listen({ port: 0 })` + a real HTTP client for anything closer to a full E2E proof (D-31's own language: "`app.inject` en modo stream o... cliente `EventSource` contra `app.listen`").
- **Decorating `request.actor` with an object literal default:** `fastify.decorateRequest('actor', { type: 'user', id: '' })` throws synchronously at boot in Fastify v5 ("Using reference types directly will throw an error") — always decorate with `null` (or a factory function) and assign the real value inside a hook.
- **Letting BullMQ's default `maxStalledCount: 1` silently reprocess a stalled `connect-server` job:** see Common Pitfalls below — this directly undermines D-12.
- **Giving the BullMQ Worker's ioredis connection a `commandTimeout`:** the Worker relies on long-blocking Redis commands (BRPOPLPUSH-style) to wait for new jobs; a `commandTimeout` there would make the worker's own idle-wait fail spuriously. Reserve `commandTimeout` for the *Queue producer's* connection only (D-27's ~2s bound), and reserve `maxRetriesPerRequest: null` for the *Worker's* connection only (BullMQ's own hard requirement) — these are two different connections with two different, easily-swapped-by-mistake settings.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Job dedupe / "don't double-enqueue the same connect attempt" | A custom Postgres/Redis lock keyed on `serverId` before calling `queue.add` | BullMQ's deterministic `jobId` (`connect:<serverId>`) — `queue.add` with an existing, still-`waiting`/`active` `jobId` is a documented no-op that returns the existing job | BullMQ's own throttle-jobs pattern (Context7-verified) exists for exactly this; a hand-rolled lock adds a second source of truth that can desync from BullMQ's own job-existence check |
| Stalled-worker recovery | A cron/interval job scanning `servers` for stuck `CONNECTING` rows on a timer | BullMQ's built-in stalled-job detection (`stalledInterval`, the `'stalled'` event) plus a one-time startup scan for jobs that have no corresponding queue entry at all (crash before enqueue vs. crash after) | BullMQ already runs this exact check per `lockDuration`/`stalledInterval`; duplicating it with a separate poller is redundant infrastructure that can drift out of sync with the job's actual queue state |
| SSE keepalive / reconnection backoff | A custom reconnect-with-backoff client wrapper | The browser's native `EventSource` (fase 5) — it already retries using the server-sent `retry:` field with no client code needed | Reinventing `EventSource`'s reconnect logic is unnecessary complexity; D-05 already designs around this native behavior |
| Cross-process pub/sub | A custom Postgres `LISTEN/NOTIFY` bridge, or a bespoke WebSocket relay server | ioredis pub/sub (`publish`/`subscribe` on a dedicated connection) | D-03 already rejected `LISTEN/NOTIFY` (ties the event bus to Postgres connection lifecycle, no fan-out story) and a bespoke WS relay (this phase explicitly stays SSE-only, ARCHITECTURE.md §7) — Redis pub/sub is already a hard dependency of the stack |

**Key insight:** every "don't hand-roll" item in this phase is really the same insight repeated — BullMQ and ioredis already solve dedupe, stalled-recovery, and pub/sub fan-out; the only code this phase should write is the *policy* layer on top (which error code maps to which HTTP status, which job payload shape, which SSE event shape), never the queue/pub-sub mechanics themselves.

## Common Pitfalls

### Pitfall 1: `attempts: 1` + default `maxStalledCount: 1` silently double-processes a stalled `connect-server` job

**What goes wrong:** BullMQ's "at least once" delivery model means a job whose lock expires (worker died mid-SSH-session, or the Node event loop stalled long enough to miss a lock-renewal tick) is, by default, moved back to `waiting` and picked up by *another* worker — the `connect-server` handler runs `connectAndDiscover` a second time for the same `serverId`, contradicting D-12's "the worker that recovers it does not reconnect."
**Why it happens:** BullMQ's default `maxStalledCount` is `1`, meaning a stalled job survives one recovery-and-reprocess cycle before being permanently failed on a second stall. `attempts: 1` only bounds *processor-thrown-exception* retries, not stalled-job reprocessing — these are two independent counters in BullMQ's model (confirmed via `docs/gitbook/bull/important-notes.md` and `docs/gitbook/guide/jobs/stalled.md`).
**How to avoid:** Set `maxStalledCount: 0` on the Worker options so the very first stall detection fails the job immediately (no reprocessing), **and** attach a `worker.on('stalled', async (jobId) => { ... })` listener that calls `failInFlightConnection` directly and synchronously with the stall detection — do not wait for BullMQ's own `'failed'` event, which fires (if at all) on a separate, subsequent tick and conflates "stalled" with "processor threw." This is the mechanism that makes D-12's exact language ("el worker que lo recupera no vuelve a conectar") literally true rather than approximately true.
**Warning signs:** An integration test that kills the worker mid-`connectAndDiscover` and asserts `ERROR`/`CONNECTION_LOST` will flake or show a second SSH connection attempt in logs if `maxStalledCount` is left at its default.

### Pitfall 2: `ioredis@6.0.0`'s RESP3-by-default may not be validated against BullMQ 6.x's Lua-script reply parsing

**What goes wrong:** `ioredis@6.0.0` (published 2026-07-31, ~6 weeks before this research) switches its default wire protocol to RESP3 and requires Node ≥20. BullMQ 6.x's own Lua scripts return specific reply shapes (arrays, maps) that ioredis must decode identically regardless of protocol version for BullMQ's internal parsing to work correctly. BullMQ 6.x's `package.json` only declares `ioredis: ">=5.0.0"` as an *optional* peer dependency with no explicit upper bound and no documented 6.x validation.
**Why it happens:** `ioredis@6.0.0` is genuinely brand new; the ecosystem (including BullMQ's own test suite, as far as this research could verify without cloning and running it) has had very little time to exercise this exact combination.
**How to avoid:** Pin `ioredis@5.11.1` (the last pre-RESP3 release) for this phase, matching what BullMQ has been tested against for years. Revisit the `6.0.0` upgrade as its own small, isolated task once the ecosystem has had more soak time — this is exactly the kind of "adopt once tooling catches up" call this project's own STACK.md already made for TypeScript 7.0 vs `typescript-eslint`.
**Warning signs:** Any BullMQ operation that throws a parsing error, returns `undefined` where a value was expected, or a Lua script `EVAL` call that returns malformed data only under `ioredis@6.x`.

### Pitfall 3: Closing SSE connections in the wrong Fastify shutdown hook

**What goes wrong:** `app.close()` (called on `SIGTERM`) hangs indefinitely if any SSE `reply.raw` stream is still open, because Fastify's shutdown sequence drains in-flight connections *before* running `onClose` hooks — and an SSE stream that only closes inside an `onClose` handler is, by definition, not yet closed during the drain step that's waiting for it.
**Why it happens:** `onClose` and `preClose` sound interchangeable but fire at different points in Fastify's documented shutdown lifecycle; `preClose` is specifically the "close long-lived streams so drain-and-stop can complete" hook (Fastify's own docs use the identical WebSocket example).
**How to avoid:** Register a `preClose` hook that iterates every open SSE reply and calls `reply.raw.end()`, and unsubscribes the Redis subscriber connection there too. Reserve `onClose` for closing the BullMQ `Queue`/database pool, which have no open streaming responses blocking drain.
**Warning signs:** `pnpm test:boot`'s SIGTERM test (or a manual `docker compose stop` in phase 6) never exits within its grace period while an SSE client is connected.

### Pitfall 4: `app.inject()` hangs forever when testing an SSE route the naive way

**What goes wrong:** `await app.inject({ method: 'GET', url: '/api/events' })` never resolves, because `inject()`'s promise resolves only once the response stream ends, and an SSE stream is designed to never end on its own.
**Why it happens:** `light-my-request` (the library behind `.inject()`) buffers the full response body by default; it has no way to know "this stream is done for the purposes of this assertion" without either the server ending the stream or the caller opting into streaming mode.
**How to avoid:** Pass `payloadAsStream: true` to `inject()` and read chunks off the returned `response.stream()` (a `Readable`) as they arrive; destroy the stream once assertions are complete. For a full E2E-adjacent proof (real sshd, D-31), prefer `app.listen({ port: 0 })` + a real HTTP client that can read a genuinely open connection.
**Warning signs:** A test that times out at exactly Vitest's default test timeout with no assertion failure — a strong signal the promise itself never resolved.

## Code Examples

### Deriving `lockDuration`/`stalledInterval` as a pure function (D-14)
```typescript
// Source: derived from D-14's own formula; keep in packages/domain or a pure util for unit testing
export function computeJobLockDurationMs(timeouts: { connectMs: number; discoveryMs: number }): number {
  return timeouts.connectMs * 2 + 2000 + timeouts.discoveryMs + 30000;
}
```

### Graceful worker shutdown racing the D-14 budget (D-25)
```typescript
// Source: https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/going-to-production.md
// (adapted to race against a bound rather than waiting unconditionally)
async function gracefulShutdown(worker: Worker, budgetMs: number): Promise<void> {
  await Promise.race([
    worker.close(), // waits for active jobs to finish (BullMQ source: whenCurrentJobsFinished)
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);
  process.exit(0); // the next startup's CONNECTING sweep (D-12) cleans up anything left mid-flight
}
process.on('SIGTERM', () => void gracefulShutdown(worker, computeJobLockDurationMs(env)));
process.on('SIGINT', () => void gracefulShutdown(worker, computeJobLockDurationMs(env)));
```

### Three distinct ioredis connections, each with the setting D-28 actually needs
```typescript
// Source: https://github.com/redis/ioredis/blob/main/README.md ("Persistent connections > Queue")
// + https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/connections.md
import Redis from 'ioredis';

// 1. Queue producer (API process) — bounded wait, D-27's ~2s timeout
const queueConnection = new Redis(env.REDIS_URL, { commandTimeout: 2000, maxRetriesPerRequest: 1 });

// 2. Worker (worker process) — must wait forever for a working connection (BullMQ hard requirement)
const workerConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

// 3. Pub/sub subscriber (API process) — separate connection because a subscribed client
//    can only issue subscribe/unsubscribe/ping/quit commands (ioredis README, "Pub/Sub")
const subscriberConnection = queueConnection.duplicate();
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `bullmq` bundling `ioredis` as a hard dependency | `ioredis` as an *optional* peer dependency (`bullmq@6.x`) | BullMQ 6.0 | Every project must now explicitly `pnpm add ioredis` alongside `bullmq` — already reflected in this research's Installation section |
| ioredis defaulting to RESP2 | ioredis `6.0.0` defaults to RESP3 (`protocol: 2` restores old behavior) | 2026-07-31 | New enough that this research recommends staying on `5.11.1` for this phase rather than adopting `6.x` immediately |
| Polling `/api/servers/:id` for status | SSE push via `GET /api/events` | This phase (SERV-06) | Directly what this phase implements — no more UI polling |

**Deprecated/outdated:** none specific to this phase beyond the ioredis major-version timing noted above.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Pinning `ioredis@5.11.1` instead of the newly-released `6.0.0` avoids an unvalidated RESP3/BullMQ interaction | Standard Stack, Common Pitfalls #2 | If wrong (i.e., 6.0.0 is actually fine), the only cost is missing out on RESP3's performance benefits for one phase — low risk, easily revisited. If 5.11.1 is *also* wrong for some other reason, BullMQ job processing could silently misbehave; the D-31 integration suite (real Redis via Testcontainers) is the safety net either way |
| A2 | `concurrently` is a reasonable devDependency for `pnpm dev` running api+worker | Standard Stack, Alternatives Considered | Low risk — this research recommends the zero-dependency turbo-tasks alternative as the default specifically to avoid needing this assumption to hold; only relevant if the planner picks `concurrently` anyway |
| A3 | `maxStalledCount: 0` combined with a `'stalled'` event listener is the correct mechanism to satisfy D-12's "never reconnect on stalled recovery" | Common Pitfalls #1, Code Examples | If wrong (e.g., `maxStalledCount: 0` has an undocumented edge case, or the `'stalled'` event fires with stale job data), a stalled connect job could either double-process (SSH reconnects unexpectedly) or never resolve to `ERROR` (server stuck in `CONNECTING`) — D-31's "stalled → failInFlightConnection" integration test is the concrete gate that must pass before this is trusted; treat as a spike-first task, not a direct-to-plan assumption |
| A4 | `dist/` and `src/` share identical relative depth to `apps/control-plane/package.json` in every file this phase adds | Architecture Patterns, Pattern 6 | If a new file is nested deeper than existing files (e.g., inside a new `queue/` or `events/` subdirectory one level deeper than `routes/`), the literal `../package.json` relative path breaks in exactly one of dev/prod — verified against the *existing* directory depth (routes/, services/, activity/ are all one level under src/); any new subdirectory this phase adds should stay at that same depth for `config-version.ts`'s import to need no adjustment |

**If this table is empty:** N/A — see entries above.

## Open Questions

1. **Does BullMQ 6.3.6 actually work correctly against `ioredis@6.0.0`'s RESP3 default, or is `5.11.1` truly required?**
   - What we know: `ioredis@6.0.0` is six weeks old at research time, defaults to RESP3, and BullMQ's peer range (`>=5.0.0`) doesn't exclude it but doesn't confirm testing against it either.
   - What's unclear: Whether BullMQ's Lua-script-based atomic operations (which ioredis must decode) behave identically under RESP3 vs RESP2 — this research could not find an authoritative statement either way.
   - Recommendation: Pin `5.11.1` for this phase (no behavior change risk); if a future phase wants RESP3's benefits, do it as an isolated version-bump task with its own integration-test pass, not bundled into this phase's other work.

2. **Is `maxStalledCount: 0` the right mechanism, or should the worker instead rely on BullMQ's default `1` and distinguish stalled-vs-real failures inside the `'failed'` handler?**
   - What we know: `'stalled'` fires on every stall detection regardless of `maxStalledCount`; `maxStalledCount: 0` fails the job on the very first stall without reprocessing.
   - What's unclear: Whether relying solely on the `'stalled'` listener (without also setting `maxStalledCount: 0`) could still let BullMQ requeue and reprocess the job a second time in a race with `failInFlightConnection`'s own `SELECT ... FOR UPDATE` — Phase 3's row lock should make a second `connectAndDiscover` invocation see the row already transitioned to `ERROR` and correctly retry-connect (not literally "double SSH", since a fresh connect is arguably fine at that point) — but this needs the D-31 integration test to confirm empirically, not just reasoned about here.
   - Recommendation: Implement both (`maxStalledCount: 0` + `'stalled'` listener) as the safer combination; let the planner schedule the D-31 stalled-recovery integration test early enough in the wave sequence to catch a wrong assumption before it propagates into the SSE/route work that depends on `failInFlightConnection` existing.

3. **Should the Origin/CSRF-lite check (D-29) be a hook inside `requireSession`'s scope, or a separate `onRequest` hook scoped only to mutating routes?**
   - What we know: D-29 explicitly leaves this as Claude's Discretion; the check only needs to run for `POST`/`PATCH`/`DELETE`.
   - What's unclear: Whether `requireSession`'s own scope (which also covers `GET` routes like `/api/servers`, `/api/activity`) is the right place, given the check is meaningless for `GET`.
   - Recommendation: A separate `onRequest` hook registered only inside a nested sub-scope for the mutating routes (`POST/PATCH/DELETE /api/servers*`), checked via `request.method !== 'GET'` inside the hook if a single shared scope is simpler to wire — either is defensible; the planner should pick whichever keeps `requireSession` single-purpose (session-only), per this codebase's demonstrated preference for one-responsibility-per-file (`http-errors.ts`, `credential-store.ts`, etc.).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker daemon | Testcontainers Redis (D-31), existing Postgres/sshd integration tests | ✓ | 29.2.0 | — |
| redis-cli (local, informational only) | Manual debugging during implementation | ✓ | 8.6.0 | — |
| Node.js | Runtime | ✓ | v24.13.0 (workspace `engines` requires `>=22.12.0`; CI pins Node 22) | Local machine runs Node 24, which satisfies the `>=22.12.0` floor — no action needed, but note the discrepancy if a Node-22-only API surface issue ever surfaces locally that CI wouldn't catch |
| Redis server (actual instance) | BullMQ Queue/Worker, pub/sub, SSE bridge — all of this phase's runtime behavior | Not persistently running locally, but Testcontainers spins up `redis:7-alpine` on demand for tests, matching the `postgres.ts` pattern already in this repo | `redis:7-alpine` (Docker image) | — |

**Missing dependencies with no fallback:** none — every dependency this phase needs is either already present or ephemeral via Testcontainers.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.0 (already pinned, root `package.json`) |
| Config file | `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration) |
| Quick run command | `pnpm test` (unit, no I/O) |
| Full suite command | `pnpm test:integration` (Testcontainers Postgres + new Redis fixture) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SERV-06 | `POST /connect` enqueues a job and responds 202 immediately, never blocking on SSH | integration | `pnpm test:integration -- tests/integration/routes/servers-connect.test.ts` | ❌ Wave 0 |
| SERV-06 | SSE client receives `server.updated` transitions without polling | integration | `pnpm test:integration -- tests/integration/routes/events-sse.test.ts` | ❌ Wave 0 |
| SERV-06 | A stalled connect job never re-runs SSH; the server lands in `ERROR`/`CONNECTION_LOST` | integration | `pnpm test:integration -- tests/integration/queue/stalled-recovery.test.ts` | ❌ Wave 0 |
| SERV-06 | Worker startup sweep clears any `CONNECTING` row with no active job | integration | `pnpm test:integration -- tests/integration/queue/startup-recovery.test.ts` | ❌ Wave 0 |
| DISC-05 | `POST /discover` on a non-`CONNECTED` server returns 409 `SERVER_NOT_CONNECTED` | unit (route + fake `ServerServices`) | `pnpm test -- routes/servers.discover.test.ts` | ❌ Wave 0 |
| DISC-05 | `POST /discover` on a `CONNECTED` server enqueues the same `connect-server` job as `/connect` | integration | `pnpm test:integration -- tests/integration/routes/servers-discover.test.ts` | ❌ Wave 0 |
| (D-16) | Every service error code maps to the documented HTTP status | unit | `pnpm test -- routes/http-errors.test.ts` | ❌ Wave 0 |
| (D-17) | `requireSession` 401s an anonymous caller and decorates `request.actor` for an authenticated one | unit | `pnpm test -- auth/require-session.test.ts` | ❌ Wave 0 |
| (D-27) | Redis down: `POST /connect` returns 503 `QUEUE_UNAVAILABLE` within ~2s; CRUD/activity/config still work | integration | `pnpm test:integration -- tests/integration/routes/redis-down.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test` (unit — fast, no Docker)
- **Per wave merge:** `pnpm test:integration` (full Testcontainers suite, now including Redis)
- **Phase gate:** Full suite green + `pnpm security:scan-leaks` (extended to HTTP routes/SSE per D-22) + `pnpm test:boot` (api + worker + Redis) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/integration/helpers/redis.ts` — Testcontainers `redis:7-alpine` fixture, `noodara.test=true` label, mirrors `postgres.ts`'s shape (start/stop, connection string)
- [ ] `tests/integration/helpers/app.ts` extension — `startTestApp()` needs an optional Redis-backed variant once routes depend on a live Queue/subscriber
- [ ] Framework install: `pnpm --filter @noodara/control-plane add bullmq@6.3.6 ioredis@5.11.1` and `pnpm add -D @testcontainers/redis@12.1.0` — none of this phase's new test infrastructure exists yet

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `requireSession` delegates to Better Auth's `getSession` (already-verified auth flow, Phase 1); no new auth logic |
| V3 Session Management | yes | SSE stream re-validates the session on every heartbeat (D-06) — closes the gap where a revoked session could keep receiving push updates for up to the heartbeat interval, bounded to ~15s by design |
| V4 Access Control | partial | Single-admin model (no roles in v0.1) — `requireSession` is the only access boundary; not a broader authorization control |
| V5 Input Validation | yes | Every route body/params/query validated with Zod (`@fastify/type-provider-zod`); BullMQ job payloads re-validated with Zod on the *consuming* side too (D-11) — a malformed job in Redis can never crash the worker |
| V6 Cryptography | no new surface | Nothing new; SSH credential handling is unchanged from Phase 3 |
| V13 API Security (OWASP API Top 10 relevant subset) | yes | Same-origin-only (no `@fastify/cors`), CSRF-lite `Origin` header check on mutations (D-29), no cross-origin credentialed requests possible by construction |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Job payload injection via a compromised/misbehaving Redis instance | Tampering | Zod-validate the job payload on consume (D-11); never trust `job.data` shape blindly |
| Session fixation via a long-lived SSE connection surviving logout | Repudiation / Elevation of Privilege | Per-heartbeat session re-validation (D-06) bounds the exposure window to ~15s |
| Cross-origin credentialed request to a mutating route | CSRF | `Origin` header check (D-29) — reject a present-but-mismatched `Origin`, allow absent (non-browser clients, `app.inject`) |
| Leaking `error.message`/stack traces from an unhandled exception | Information Disclosure | Global `setErrorHandler` always redacts via `appRedactor.redact()` before logging, and never returns the original message to the client (D-22) — this is a repeat of Phase 1's canary-tested pattern, now applied to real production routes |
| Redis connection exhaustion from unbounded SSE connections | Denial of Service | `NOODARA_SSE_MAX_CONNECTIONS` cap (D-07) returns 503 instead of accumulating unbounded sockets/subscriptions |

## Sources

### Primary (HIGH confidence)
- Context7 `/taskforcesh/bullmq` — Queue/Worker options, `jobId` throttling pattern, graceful shutdown, stalled-job semantics, `maxRetriesPerRequest: null` requirement, `removeOnComplete`/`removeOnFail` shapes, `Job.attemptsMade` doc comment
- Context7 `/fastify/fastify` — `reply.hijack()`/`reply.raw`, `onRequestAbort`/`preClose`/`onClose` hook semantics and ordering, `decorateRequest` reference-type restriction, TypeScript module augmentation pattern, streaming response guidance
- Context7 `/fastify/fastify-type-provider-zod` — `hasZodFastifySchemaValidationErrors`, `isResponseSerializationError` error-handler pattern
- Context7 `/redis/ioredis` — `duplicate()`, pub/sub connection-mode exclusivity, `commandTimeout`/`maxRetriesPerRequest`/`connectTimeout` option semantics (read directly from linked source excerpts), `autoResubscribe` default
- Context7 `/drizzle-team/drizzle-orm-docs` — cursor-based pagination guide (`or(lt(...), and(eq(...), lt(...)))` compound-cursor pattern), composite index recommendation
- npm registry (`npm view <pkg> version|repository.url|peerDependencies|scripts.postinstall`) — `bullmq@6.3.6`, `ioredis@6.0.0`/`5.11.1`, `@testcontainers/redis@12.1.0`, `concurrently@10.0.5`, all repository URLs, bullmq's peer dependency table, absence of postinstall scripts
- `slopcheck scan --pkg npm <pkg>` — `bullmq`, `ioredis`, `@testcontainers/redis`, `concurrently` all `[OK]`
- This repo's own source: `apps/control-plane/src/{app,server,env}.ts`, `routes/{setup,sessions,health,auth}.ts`, `services/*.ts`, `activity/*.ts`, `db/schema/*.ts`, `tests/integration/helpers/*.ts`, `docs/adr/0000..0003`, `docs/domain/server-state-transitions.md` — read directly in this session, not summarized secondhand

### Secondary (MEDIUM confidence)
- WebSearch: ioredis 6.0.0 release notes/breaking-changes summary (RESP3 default, Node ≥20 requirement, 2026-07-31 publish date) — cross-referenced against multiple independent dependabot-PR titles and the ioredis readthedocs changelog page, consistent across sources
- WebSearch: BullMQ v6's `ioredis` peer-dependency change (optional, `>=5.0.0`, no longer bundled) — cross-referenced against a Medium article and BullMQ's own connections guide language quoted above; the peer-range fact itself was independently confirmed via `npm view bullmq@6.3.6 peerDependencies` (primary source)
- WebFetch `node.testcontainers.org/modules/redis/` — `RedisContainer`/`getConnectionUrl()` API shape (page did not show `withLabels` explicitly, but that method is inherited from the shared `GenericContainer` base already in use for the project's Postgres fixture)

### Tertiary (LOW confidence)
- Whether BullMQ 6.3.6's Lua scripts have been explicitly tested against ioredis 6.0.0's RESP3 default — no authoritative source found either confirming or denying this; treated as an open risk (Open Question 1), not asserted either way

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for bullmq/ioredis/@testcontainers/redis package identity and API shape (Context7 + npm registry); MEDIUM for the specific ioredis version *choice* (5.11.1 vs 6.0.0), which is this research's own risk-averse call, not a verified fact
- Architecture: HIGH — every pattern (SSE hijack, pub/sub bridge, one-job-two-preconditions, requireSession decoration, Zod error normalization, package.json version read, keyset pagination) is either directly sourced from official docs/this repo's existing code, or a straightforward composition of both
- Pitfalls: MEDIUM — the stalled-job/maxStalledCount interaction and the ioredis-6-RESP3 risk are both real, sourced findings, but neither was empirically spiked against this exact stack in this research session; both are flagged as Open Questions with a concrete recommended mitigation and a named integration test (D-31) as the actual gate

**Research date:** 2026-09-16
**Valid until:** 30 days for the Fastify/BullMQ/Drizzle patterns (stable APIs); ~7 days for the ioredis version recommendation specifically, since it depends on ecosystem soak time for a very recently released major version — re-check `npm view ioredis version` and BullMQ's own compatibility notes before actually pinning if this research is used more than a couple of weeks after 2026-09-16

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Research completed: 2026-09-16*
