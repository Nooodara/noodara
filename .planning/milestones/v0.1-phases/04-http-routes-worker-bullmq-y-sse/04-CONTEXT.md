# Phase 4: HTTP routes, worker BullMQ y SSE - Context

**Gathered:** 2026-09-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Esta fase expone sobre HTTP los servicios de aplicación de la fase 3 y saca el trabajo SSH del proceso del API. Entrega: (1) las rutas `/api/servers` (crear, listar, detalle, editar, eliminar), `POST /api/servers/:id/connect`, `POST /api/servers/:id/discover` (DISC-05), `POST /api/servers/:id/trust-fingerprint`, `GET /api/activity` y `GET /api/config`, todas validadas con Zod y con un único mapa de códigos de servicio → HTTP; (2) un segundo entrypoint `worker.ts` del mismo paquete `apps/control-plane` que consume la cola BullMQ `servers` y ejecuta `connectAndDiscover` fuera del hilo del API (SERV-06), con recuperación de servidores atascados en `CONNECTING`; (3) un stream SSE global `GET /api/events` que empuja `ServerView` en cada transición de estado, alimentado por Redis pub/sub desde los servicios; (4) un plugin de sesión `requireSession` y un error handler global opaco y redactado, aplicados también a las rutas ya existentes (`setup.ts`, `sessions.ts`, `health.ts`) para unificar el vocabulario de la API antes de que la fase 5 escriba el cliente; (5) `/health` ampliado con checks de Postgres, Redis y heartbeat del worker.

Requisitos cubiertos: SERV-06, DISC-05. Criterios de éxito 1–4 de la fase en ROADMAP.md.

Fuera de esta fase: toda la UI, incluido el cliente EventSource y la resincronización por GET (fase 5); `docker-compose.yml`, healthchecks de contenedor y `stop_grace_period` (fase 6); rate limit de rutas de mutación, replay de eventos SSE, configuración global editable, cola de deployments (post v0.1 / v0.3). `packages/domain` y `packages/ssh` no cambian de contrato; `auth.ts` no se toca. Los servicios de fase 3 solo ganan el puerto de publicación de eventos y un servicio nuevo de recuperación (`failInFlightConnection`).

</domain>

<decisions>
## Implementation Decisions

### Stream SSE y puente worker → API
- **D-01:** Un único stream global `GET /api/events` (`text/event-stream`), autenticado por la cookie de sesión como el resto de `/api`. No hay stream por servidor. La lista y el detalle de la fase 5 comparten la misma conexión; activity y deployments añadirán tipos de evento a esta misma ruta más adelante (research §7/§9: ruta SSE separada y aditiva de cualquier WebSocket futuro).
- **D-02:** Dos tipos de evento en esta fase: `server.updated` con el `ServerView` completo (mismo shape y misma allowlist de 27 campos que `GET /api/servers/:id`, fase 3 D-19) y `server.deleted` con `{ id }`. No hay un tipo por transición: la UI discrimina por `status`. El test de allowlist de `ServerView` es la garantía de no-fuga del stream.
- **D-03:** El puente entre procesos es Redis pub/sub propio: canal `noodara:server-events`, mensaje JSON `{ type, server | id, at }`. El API mantiene una conexión ioredis dedicada en modo suscriptor (distinta de la de BullMQ) y reenvía cada mensaje a todos los SSE abiertos. No se usan `QueueEvents` de BullMQ (solo cubrirían cambios nacidos en un job) ni `LISTEN/NOTIFY` de Postgres.
- **D-04:** Quien publica es el servicio, no el caller: `ServerServicesDeps` gana un puerto `events: ServerEventPublisher` (`publish(event): Promise<void>`) y cada servicio de fase 3 publica **después** de que su transacción confirme (`registerServer`, `editServer`, `trustFingerprint` una vez; `deleteServer` publica `server.deleted`; `connectAndDiscover` publica dos veces: tras TX1 con `CONNECTING` y tras TX2 con el resultado). Así cualquier caller (ruta, worker, CLI futuro) emite igual y `CONNECTING` es visible en cuanto el worker toma el job. Un fallo al publicar se loggea a warn y nunca revierte ni hace fallar la operación (Postgres es la verdad; SSE es best-effort). Tests unitarios con un publisher falso; el adaptador Redis vive en un archivo aparte.
- **D-05:** Sin replay ni `Last-Event-ID`: el stream envía `retry:` al abrir y un comentario keepalive cada ~15 s para que proxies no corten la conexión. Cuando `EventSource` reconecta, la UI (fase 5) resincroniza con `GET /api/servers` y sigue escuchando. El API no guarda buffer de eventos.
- **D-06:** El stream valida la sesión al abrir (401 `{ error: 'UNAUTHORIZED' }` sin abrir el stream) y **re-valida en cada heartbeat**; si la sesión expiró o fue revocada, cierra el stream. Logout y revocación (AUTH-03) cortan el push en menos de un heartbeat; el `EventSource` reintenta, recibe 401 y la UI redirige a login.
- **D-07:** Límite de conexiones SSE simultáneas por proceso API: `NOODARA_SSE_MAX_CONNECTIONS` validado en `env.ts` con `parseTuningInt` (default 32, rango razonable). Al superarlo el API responde 503 `{ error: 'SSE_LIMIT_REACHED' }` con `Retry-After` en lugar de acumular sockets. Todas las conexiones se cierran en el `onClose` de Fastify.

### Jobs de connect y discover
- **D-08:** `POST /api/servers/:id/connect` y `POST /api/servers/:id/discover` comprueban que el servidor existe (404) y no está `CONNECTING` (409 `ALREADY_CONNECTING`), encolan y responden **202** `{ server: ServerView, jobId }`. `jobId` es para logs, tests y correlación, nunca para polling: el progreso llega por SSE. Nunca se espera al job dentro de la petición (criterio 1 de la fase).
- **D-09:** Dedupe de doble disparo en dos capas: el job se encola con `jobId` determinista `connect:<serverId>`, de modo que BullMQ ignora un segundo `add` mientras el anterior esté `waiting`/`active` y la ruta responde 202 idempotente con el mismo `jobId`; si aun así dos jobs llegan al worker, el `SELECT ... FOR UPDATE` de fase 3 (D-05) devuelve `ALREADY_CONNECTING` y el segundo job termina sin efecto. No se añade columna `pending_job_id`.
- **D-10:** Un solo tipo de job `connect-server` y un solo handler para ambas rutas, que llama al mismo `connectAndDiscover` (fase 3 D-01: no hay connect sin discovery). La diferencia es la precondición y la intención: `/discover` es "Re-run discovery" (DISC-05) y la ruta responde 409 `SERVER_NOT_CONNECTED` si el servidor no está `CONNECTED` (el roadmap lo define "después de CONNECTED"); `/connect` vale desde cualquier estado distinto de `CONNECTING` (`PENDING`, `ERROR`, `UNREACHABLE`, `DISCONNECTED`, y también `CONNECTED` para reconectar).
- **D-11:** Payload del job: `{ serverId, actor, requestedAt, trigger: 'connect' | 'discover' }`, con `actor` exactamente como lo define fase 3 D-17 (`{ type: 'user', id }`); nunca host, usuario ni credencial (el worker relee la fila y descifra él mismo). El payload se valida con Zod al consumir para que un job malformado en Redis nunca tumbe el worker.
- **D-12:** Sin reintentos BullMQ (`attempts: 1`): el adaptador SSH ya reintenta transitorios (fase 2 D-10) y `connectAndDiscover` nunca lanza por SSH (SERV-07). Cuando un job queda `stalled` porque el worker murió a mitad, el worker que lo recupera **no vuelve a conectar**: llama a un servicio nuevo `failInFlightConnection({ serverId, actor, reason })` que, bajo lock de fila, transiciona `CONNECTING → ERROR` con `last_error_code = CONNECTION_LOST`, escribe `server.connection_attempted` con `outcome: failure` y publica `server.updated`. Además, al arrancar, el worker recorre los servidores en `CONNECTING` que no tienen job activo en la cola y les aplica el mismo servicio. Un servidor nunca queda en `CONNECTING` indefinidamente.
- **D-13:** Encolar no escribe evento de activity: `server.connection_attempted` y `server.discovery_completed` (fase 3 D-16) ya cuentan la historia atribuida al admin vía `actor`. La ruta loggea a `info` con `serverId`, `jobId` y `trigger`. (Coherente con el descarte de `server.connection_skipped` en fase 3.)
- **D-14:** El job no tiene timeout propio. `lockDuration` y `stalledInterval` del worker se derivan de `NOODARA_SSH_*` con margen: `connectMs × 2 + 2 000 + discoveryMs + 30 000` ms con los valores efectivos de `env.ts`, para que un job legítimo nunca sea marcado `stalled` a mitad y ningún `Promise.race` corte la sesión SSH fuera del `finally` del servicio.
- **D-15:** Desenlace del job: un resultado `{ ok: false, code }` del servicio (`NOT_FOUND` porque el admin borró el servidor mientras esperaba, `ALREADY_CONNECTING`) es un desenlace esperado → el job **completa** devolviendo `{ outcome: code }` y se loggea a `warn`. Solo una excepción real (Postgres caído, bug) marca el job `failed`, con log a `error` que incluye `jobId` y nunca el payload completo ni datos sensibles. Así `failed` en BullMQ siempre significa bug o infraestructura.

### Contrato de la API HTTP
- **D-16:** Un único mapa código → status en un helper testeado (`apps/control-plane/src/routes/http-errors.ts` o equivalente), no un `switch` por ruta: `VALIDATION_FAILED`, `INVALID_CREDENTIAL` → 400; `UNAUTHORIZED` → 401; `NOT_FOUND` → 404; `NAME_TAKEN`, `HOST_TAKEN`, `SERVER_BUSY`, `ALREADY_CONNECTING`, `SERVER_NOT_CONNECTED`, `NO_PENDING_FINGERPRINT`, `CONFIRMATION_MISMATCH` → 409; `QUEUE_UNAVAILABLE`, `SSE_LIMIT_REACHED` → 503; `INTERNAL_ERROR` → 500. Body de error siempre `{ error: '<CODE>', message }` con el código del servicio tal cual (UPPER_SNAKE) y su mensaje ya redactado. Los errores de esquema Zod de Fastify se normalizan al mismo shape con `error: 'VALIDATION_FAILED'` y un array `issues: [{ path, message }]`.
- **D-17:** Guard de sesión como plugin `requireSession`: hook `onRequest` que llama a `auth.api.getSession` con las cabeceras (`toFetchHeaders`), responde 401 `{ error: 'UNAUTHORIZED' }` si no hay sesión y decora `request.actor = { type: 'user', id }` listo para pasar a los servicios. Se registra en un scope encapsulado de Fastify que agrupa `/api/servers`, `/api/activity`, `/api/config` y `/api/events`. Fuera del guard: `/health`, `/api/auth/*`, `/api/setup`, `/api/recovery`.
- **D-18:** Las rutas existentes se migran en esta fase **sin cambiar semántica**: `setup.ts` y `sessions.ts` pasan al shape `{ error: 'UPPER_SNAKE', message }` (`not_found` → `NOT_FOUND`, `unauthorized` → `UNAUTHORIZED`), `sessions.ts` usa el plugin `requireSession`, `health.ts` deja de devolver el `'0.0.0'` fijo. El 404 de `/api/setup` cuando ya existe admin (fase 1 D-02) y todas las reglas de auth se mantienen idénticas; los tests de integración de fase 1 se actualizan al nuevo shape. `auth.ts` no se toca; `app.ts` sí (registro de plugins, error handler, cierre ordenado).
- **D-19:** Recursos: `POST /api/servers` → 201 `ServerView`; `GET /api/servers` → 200 `{ items: ServerView[] }` ordenado por `name`, sin paginar (un admin, decenas de servidores); `GET /api/servers/:id` → 200 `ServerView`; `PATCH /api/servers/:id` → 200 `ServerView`, body parcial con cualquier subconjunto de `name`, `host`, `sshPort`, `sshUser` y `credential` completa opcional (exactamente `EditServerInput`, fase 3 D-13), la credencial nunca vuelve en la respuesta; `DELETE /api/servers/:id` con body `{ confirmName }` → 200 `{ ok: true, serverId }` (fase 3 D-12/D-19; `CONFIRMATION_MISMATCH` → 409); `POST /api/servers/:id/trust-fingerprint` → 200 `ServerView`. El shape del body de `POST`/`PATCH` sigue los inputs de fase 3 (`credential: { type: 'ssh_private_key', privateKey, passphrase? } | { type: 'ssh_password', password }`).
- **D-20:** `GET /api/activity` → 200 `{ items, nextCursor }` con paginación keyset por `(occurred_at desc, id desc)`: `?limit=50` (1–200) `&cursor=<opaco base64url>`. Cada item expone `id`, `occurredAt`, `actorType`, `actorId`, `entityType`, `entityId`, `action`, `outcome`, `errorCode`, `metadata` (ya redactada por fase 3). Sin filtros ni búsqueda (REQUIREMENTS Out of Scope).
- **D-21:** `GET /api/config` → 200 solo lectura `{ version, publicUrl, masterKeyFingerprint, sshTimeouts: { connectMs, commandMs, discoveryMs }, workerConcurrency }`: `version` leída de `package.json` en build (no un literal), `publicUrl` = `NOODARA_PUBLIC_URL`, `masterKeyFingerprint` el mismo SHA-256 truncado que fase 1 D-12 loggea al arrancar. Sin tabla `settings` ni `PUT`: la configuración editable no entra en v0.1. `health.ts` reutiliza la misma fuente de `version`.
- **D-22:** Error handler global en `app.ts` (`app.setErrorHandler`): toda excepción no controlada responde 500 `{ error: 'INTERNAL_ERROR', message: 'Internal error' }` sin mensaje original ni stack, y loggea `appRedactor.redact(error.message)` junto al `requestId`, como probó el canary de fase 1 que debían hacer las rutas reales. El proceso sigue vivo (criterio 4). El canary full-flow de fase 3 (`security:scan-leaks`) se extiende a las rutas HTTP: ninguna respuesta 2xx/4xx/5xx ni evento SSE contiene los canaries.

### Proceso worker y operación
- **D-23:** `apps/control-plane/src/worker.ts` es el segundo entrypoint del mismo paquete e imagen (fase 1 Claude's Discretion, research §1). Importa `./env.js` primero (mismo fail-fast INST-06), abre Postgres y Redis, resuelve `ServerServicesDeps` una vez con `resolveServerServicesDeps` y crea el worker con `createWorker(deps)`. Scripts: `dev` arranca api y worker en paralelo (`tsx watch` de ambos, vía `concurrently` o dos tareas turbo con el mismo `passThroughEnv`), `start` = `node dist/server.js`, `start:worker` = `node dist/worker.js` (ADR 0003). `pnpm test:boot` añade el arranque real del worker. La fase 6 usará `command` distinto por contenedor.
- **D-24:** Concurrencia global del worker: `NOODARA_WORKER_CONCURRENCY` validada en `env.ts` con `parseTuningInt` (default 5, rango 1–20; research §4). El límite por servidor lo garantiza el servicio (fase 3 D-05) más el `jobId` determinista (D-09).
- **D-25:** Apagado limpio: en `SIGTERM`/`SIGINT` el worker deja de tomar jobs y espera a los activos con `worker.close()` hasta el mismo presupuesto de D-14; si se excede, sale igual y la recuperación de `CONNECTING` del próximo arranque (D-12) limpia. El API cierra los SSE abiertos y la suscripción Redis en `onClose`. Al arrancar, el worker sí exige Postgres y Redis (fail-fast); en vida, reconecta a Redis solo (ioredis/BullMQ con backoff, log a `warn`, nunca `process.exit`) y un Postgres caído dentro de un job lo marca `failed` (D-15) sin reintento.
- **D-26:** Observabilidad: el worker escribe un heartbeat `noodara:worker:<workerId>` en Redis con TTL 30 s cada ~10 s. `GET /health` pasa a responder 200 `{ status: 'ok' | 'degraded', version, checks: { postgres, redis, worker } }` con `pass | fail` por check; `degraded` (Redis sin respuesta o sin heartbeat de worker) sigue siendo 200 para que el orquestador no reinicie el API por culpa del worker. El worker no abre puerto HTTP. Postgres caído en `/health` sí es 503.
- **D-27:** Redis caído en el API: el API arranca y sirve CRUD, activity y config sin Redis (Postgres es la verdad). `POST connect/discover` intenta `queue.add` con timeout corto (~2 s) y responde 503 `QUEUE_UNAVAILABLE` sin tocar la fila. `/api/events` acepta la conexión y manda heartbeats aunque la suscripción esté caída; ioredis reconecta y re-suscribe solo. Ningún fallo de Redis lanza fuera de un handler.
- **D-28:** Cola y claves: cola BullMQ `servers` con job name `connect-server` (v0.3 añadirá una cola `deployments` aparte); `prefix: 'noodara'` en BullMQ y todas las claves propias (`noodara:server-events`, `noodara:worker:<id>`) bajo el mismo espacio para no colisionar en un Redis compartido. `removeOnComplete: { count: 100 }`, `removeOnFail: { count: 500 }`. ioredis con `maxRetriesPerRequest: null` (requisito de BullMQ) y conexiones separadas para cola, suscriptor y publicador. Versiones exactas de `bullmq`/`ioredis` las fija research con `scripts/check-package-provenance.mjs` (STACK.md apunta BullMQ 6.3.4).
- **D-29:** Same-origin: la UI de fase 5 (Next.js) proxya `/api/*` al API (`rewrites` en dev, proxy en Compose en fase 6). El API **no** registra `@fastify/cors` ni acepta orígenes cruzados; cookies `SameSite=Lax` y `EventSource` funcionan sin configuración extra y solo se expone un puerto. Como defensa CSRF barata, las rutas de mutación rechazan con 403 `FORBIDDEN_ORIGIN` un header `Origin` presente y distinto del de `NOODARA_PUBLIC_URL` (ausente = permitido, para `app.inject` y clientes no-navegador).
- **D-30:** Sin rate limit en rutas de mutación en v0.1: sesión de un único admin, lockout de login (fase 1 D-07), dedupe por `jobId` y concurrencia del worker bastan. `@fastify/rate-limit` no se añade.

### Testing (aplicación de `noodara-tdd` a esta fase)
- **D-31:** Integración con Redis real: `tests/integration/helpers/redis.ts` arranca `redis:7-alpine` con Testcontainers y etiqueta `noodara.test=true` (mismo patrón que `postgres.ts`). El worker se instancia **in-process** en el test con el mismo `createWorker(deps)` que usa `worker.ts`, con un `SshPort` falso para los tests de rutas y con el sshd real de fase 2 para un test de API de punta a punta: `POST connect` → 202 → eventos SSE `CONNECTING → CONNECTED` leídos con `app.inject` en modo stream o con un cliente `EventSource` contra `app.listen` en puerto efímero. Se cubren además: dedupe (dos POST → un job), `discover` sobre no-CONNECTED → 409, stalled → `failInFlightConnection`, recuperación al arrancar, Redis caído → 503, cierre de SSE por sesión revocada, límite de SSE → 503, `Origin` distinto → 403.
- **D-32:** Unit: rutas con `app.inject` y `ServerServices` falsos (mapa de errores y esquemas Zod cubiertos por tabla); publisher y suscriptor Redis con fakes estructurales; `requireSession` con `getSession` falso; cálculo de `lockDuration` como función pura. CI: el job `integration` añade Redis; `boot-smoke` arranca api + worker con Redis y comprueba `/health` con `worker: pass`; `security` sigue ejecutando `security:scan-leaks` ampliado (D-22).

### Claude's Discretion
- Nombres exactos de archivos y plugins (`routes/servers.ts`, `routes/activity.ts`, `routes/config.ts`, `routes/events.ts`, `auth/require-session.ts`, `queue/`, `events/`), mientras respeten la estructura de `apps/control-plane/src/` y el test de boundary de fase 3 (solo `services/` y `activity/` escriben eventos de activity).
- Formato del cursor de activity (base64url de `occurred_at|id` o similar) y del `workerId` (hostname + pid o UUID).
- Cómo se comparte el `version` entre `health.ts` y `config.ts` (constante generada en build o lectura de `package.json` con `createRequire`), respetando ADR 0003.
- Detalles de la implementación SSE en Fastify 5 (`reply.raw` con `hijack()` frente a un plugin), siempre que el guard, el heartbeat, la re-validación y el `onClose` de D-05..D-07 se cumplan y el canary lo cubra.
- Forma exacta de `failInFlightConnection` (archivo propio en `services/`, expuesto vía `createServerServices`) y del recorrido de `CONNECTING` al arrancar (consulta a la cola por `jobId` determinista vs. `getJob`).
- Si el `Origin` check de D-29 es un hook del scope de mutaciones o parte de `requireSession`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y criterios de aceptación
- `.planning/ROADMAP.md` — Phase 4 goal y success criteria 1–4; Phase 5 (consumidor de `/api/events`, `ServerView`, activity y config) y Phase 6 (Compose con `api`/`worker`).
- `.planning/REQUIREMENTS.md` — SERV-06, DISC-05 (esta fase); SERV-04, DETL-01, ACT-02, SET-01, DISC-02, QA-04, QA-05 como consumidores en fase 5; Out of Scope (sin filtros de activity, sin multiusuario).
- `docs/roadmap-v0.1-v0.5.md` §6.1 Control Plane/Servers, §6.3 Seguridad, §6.7 Criterios.

### Decisiones previas que gobiernan esta fase
- `.planning/phases/03-servicios-de-aplicaci-n-activity-log-y-redacci-n/03-CONTEXT.md` — D-01 (un solo `connectAndDiscover`), D-04 (`trustFingerprint` sin ruta), D-05 (`ALREADY_CONNECTING` → 409, lock de fila), D-11 (`SERVER_BUSY` → 409), D-12 (`confirmName`), D-13 (`EditServerInput`), D-16/D-17 (eventos `server.*` y `actor` propagado desde el job), D-18 (canary full-flow y `security:scan-leaks`), D-19 (`ServerView` sin transformar), Claude's Discretion (contrato `{ ok, code, message }`, `createServerServices`).
- `.planning/phases/01-dominio-persistencia-y-autenticaci-n/01-CONTEXT.md` — D-02 (404 de setup), D-05..D-08 (sesión y cookies), D-12 (fingerprint de master key en Settings), D-13 (sin Disconnect), D-15 (trust como acción explícita), Claude's Discretion (dos entrypoints `api`/`worker` en una app).
- `.planning/phases/02-adaptador-ssh-aislado-y-probado-con-testcontainers/02-CONTEXT.md` — D-08/D-09 (timeouts SSH y env vars de las que se deriva `lockDuration`), D-10 (`attempts` y reintento único en el adaptador).
- `docs/domain/server-state-transitions.md` — edges válidas (`CONNECTING → ERROR` para `failInFlightConnection`) y edges con reason.
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` — contrato tsc/tsx/node que `worker.ts` y los nuevos scripts deben respetar.
- `docs/adr/0001-fastify-zod-type-provider.md` — type provider Zod fijado para todas las rutas.
- `docs/adr/0000-package-legitimacy-approvals.md` y `scripts/check-package-provenance.mjs` — procedimiento para aprobar `bullmq`, `ioredis` y cualquier dependencia nueva.

### Contratos de código existentes
- `apps/control-plane/src/services/server-services.ts`, `server-service-deps.ts` — `createServerServices`, `ServerServicesDeps` (gana `events`), `ServiceActor`, `resolveServerServicesDeps`.
- `apps/control-plane/src/services/connect-and-discover.ts` — TX1/SSH/TX2, puntos donde publicar `server.updated`; `register-server.ts`, `edit-server.ts`, `delete-server.ts`, `trust-fingerprint.ts` — inputs y códigos de resultado que las rutas mapean.
- `apps/control-plane/src/services/server-view.ts` — `ServerView`, `SERVER_VIEW_KEYS` (payload de SSE y de las rutas).
- `apps/control-plane/src/services/session-service.ts` — `toFetchHeaders`, `UnauthorizedError`, patrón `auth.api.getSession` para `requireSession`.
- `apps/control-plane/src/routes/setup.ts`, `sessions.ts`, `health.ts`, `auth.ts` — rutas a migrar (D-18) y patrón `withTypeProvider<ZodTypeProvider>()`; `auth.ts` intocable.
- `apps/control-plane/src/app.ts`, `server.ts` — `buildApp` sin red (para `app.inject`), orden de arranque a replicar en `worker.ts`.
- `apps/control-plane/src/env.ts` — `parseTuningInt`, `REDIS_URL` ya obligatorio, variables `NOODARA_SSH_*`; nuevas `NOODARA_WORKER_CONCURRENCY`, `NOODARA_SSE_MAX_CONNECTIONS` (y `turbo.json` `passThroughEnv`).
- `apps/control-plane/src/activity/redaction.ts`, `write-activity-event.ts`, `boundary.test.ts` — `appRedactor` para el error handler; restricción de quién escribe eventos.
- `apps/control-plane/src/db/schema/activity-events.ts` — `occurred_at` + índice desc para el keyset de D-20.
- `packages/domain/src/server/server-state.ts` — `transition` para `CONNECTING → ERROR`.
- `tests/integration/helpers/app.ts`, `postgres.ts`, `ssh.ts`, `boot-process.ts` — fixtures a extender con `redis.ts`; `tests/integration/activity/canary.test.ts` y `tests/integration/services/*` — patrón de canary y de tests de servicio.

### Reglas de ingeniería (skills de proyecto)
- `.claude/skills/noodara-security/SKILL.md` — §3 Redactor en errores HTTP, §5 sesiones, §8 logging sin secretos, §9 scan de fuga, §10 checklist (esta fase toca sesión, shell remoto vía worker y logs).
- `.claude/skills/noodara-domain-model/SKILL.md` — §2 Server (estados), §7 ActivityEvent.
- `.claude/skills/noodara-tdd/SKILL.md` — RED/GREEN/REFACTOR, Testcontainers, coverage.
- `CLAUDE.md` §2 (DoD: ningún fallo de infraestructura tumba la API), §3.2 comandos (añadir `start:worker`, mantener la tabla al día), §7.

### Research y arquitectura
- `.planning/research/ARCHITECTURE.md` §1 (topología `api`/`worker`/`web` en Compose, same-origin), §3 (servicios como único punto de entrada de rutas y worker), §4 (concurrencia por servidor y global), §7 (SSE, no WebSocket), §9 (decisiones a fijar en v0.1).
- `.planning/research/STACK.md` — BullMQ 6.3.4, ioredis, Fastify 5.12, Zod 4; "What NOT to use".
- `.planning/research/PITFALLS.md` — fila sobre un solo proceso síncrono con timeouts en cascada (aislar por servidor); pitfalls de secrets en logs y estados falsos.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `createServerServices(deps)` y `resolveServerServicesDeps(overrides)`: las rutas y el worker obtienen los cinco servicios de fase 3 con una sola llamada; los tests inyectan `db`, `ssh`, `now` y (nuevo) `events` falsos.
- `connectAndDiscover` ya devuelve `{ ok: true, server: ServerView, connection, discovery? }` sin lanzar por SSH: el handler del job solo lo llama y loggea.
- `toServerView` + `SERVER_VIEW_KEYS`: payload de SSE y de todas las respuestas de servidor sin transformación; su test de allowlist es la garantía de no-fuga.
- `toFetchHeaders` y `auth.api.getSession` (session-service.ts): base del plugin `requireSession`.
- Patrón de ruta con `withTypeProvider<ZodTypeProvider>()`, esquemas de `response` por status y handler que solo mapea códigos (setup.ts, sessions.ts).
- `appRedactor.redact` y el patrón de `app.setErrorHandler` probado en `tests/integration/activity/canary.test.ts`.
- `parseTuningInt` en `env.ts` para las dos env vars nuevas; `turbo.json` `passThroughEnv` como lista a ampliar.
- `tests/integration/helpers/postgres.ts` (Testcontainers con etiqueta `noodara.test=true`, limpieza) como molde de `redis.ts`; `helpers/ssh.ts` para el E2E de API con sshd real; `helpers/boot-process.ts` para el boot-smoke del worker.
- `transition('CONNECTING', 'ERROR')` en `packages/domain` para `failInFlightConnection`; `writeActivityEvent` para su evento.

### Established Patterns
- Servicios como única puerta de mutación: rutas y worker no tocan Drizzle directamente; `boundary.test.ts` restringe `writeActivityEvent` a `services/` y `activity/` (el nuevo `failInFlightConnection` vive en `services/`).
- Resultados `{ ok: true, ... } | { ok: false, code, message }` para fallos esperados; excepciones solo para bugs/infra — el mapa HTTP de D-16 y la política de jobs de D-15 se apoyan en esto.
- `env.ts` fail-fast importado primero en cada entrypoint; dependencias env-sensibles cargadas con `await import` en tests.
- Rutas bajo `/api/*`; `/health` fuera; `buildApp()` nunca abre socket (los tests usan `app.inject`).
- `packages/domain` puro y con ≥95 % de cobertura para toda función nueva (cálculo de presupuesto del job, cursor de activity si se decide ponerlo ahí).
- Dependencias nuevas pasan por `scripts/check-package-provenance.mjs` y ADR 0000.
- Commits Conventional en inglés, RED/GREEN por tarea, sin atribución a IA.

### Integration Points
- `app.ts`: registra `requireSession`, el error handler global, el scope de rutas nuevas, el suscriptor Redis y su cierre en `onClose`; `server.ts` no cambia salvo lo que necesite el cierre ordenado.
- `worker.ts` (nuevo) y scripts `dev`/`start:worker`/`test:boot`; `turbo.json` `passThroughEnv` con las dos env vars nuevas; `.github/workflows/ci.yml` con Redis en `integration` y `boot-smoke`.
- `ServerServicesDeps.events` y las publicaciones post-commit en los cinco servicios de fase 3 + `failInFlightConnection`.
- Fase 5 consumirá `GET /api/servers`, `/api/servers/:id`, `/api/events` (`server.updated`/`server.deleted`), `/api/activity` con cursor y `/api/config`, todo con el shape de error de D-16 y el 401 de D-17.
- Fase 6 definirá `docker-compose.yml` con `api` (`node dist/server.js`), `worker` (`node dist/worker.js`), healthchecks sobre `/health` y `stop_grace_period` acorde a D-25.

</code_context>

<specifics>
## Specific Ideas

- El estado que ve el admin debe cambiar "solo": pulsar Connect responde al instante y la pill pasa a CONNECTING y luego a CONNECTED/ERROR sin recargar ni hacer polling; `jobId` existe para depurar, no para que la UI pregunte.
- `failed` en BullMQ tiene que significar siempre "bug o infraestructura", nunca "el admin borró el servidor mientras conectaba".
- Un Redis reiniciado no puede dejar al admin sin ver sus servidores: el API sirve lectura y CRUD sin cola; solo Connect responde 503.
- Un servidor nunca se queda en CONNECTING para siempre: cualquier muerte del worker acaba en ERROR/CONNECTION_LOST con su evento.
- Un solo vocabulario de errores (`{ error: 'CODE', message }`) antes de que exista el cliente de fase 5, aunque eso implique migrar las rutas de fase 1.

</specifics>

<deferred>
## Deferred Ideas

- Rate limit por sesión/IP en rutas de mutación (`@fastify/rate-limit`) — cuando exista multiusuario o API keys.
- Replay de eventos SSE con `Last-Event-ID` / Redis Streams — cuando haya eventos de alta frecuencia (logs de deploy, v0.3) o más de un consumidor.
- Cola `deployments` separada y tipos de job adicionales — v0.3.
- Configuración global editable (tabla `settings` + `PUT /api/config`) — post v0.1; `GET /api/config` queda read-only.
- Evento de activity `server.connection_requested` al encolar — descartado; pino basta.
- Stream SSE por servidor (`/api/servers/:id/events`) — descartado; el global cubre lista y detalle.
- Puerto HTTP propio en el worker — descartado; heartbeat en Redis + `/health` del API.
- CORS con credentials para servir web y api en orígenes distintos — descartado para v0.1; same-origin vía proxy.
- Timeout de job por env var (`NOODARA_JOB_TIMEOUT_MS`) — descartado; el presupuesto se deriva de los timeouts SSH.
- Filtros, búsqueda y export del activity log — fuera de alcance por REQUIREMENTS.

</deferred>

---

*Phase: 04-http-routes-worker-bullmq-y-sse*
*Context gathered: 2026-09-16*
