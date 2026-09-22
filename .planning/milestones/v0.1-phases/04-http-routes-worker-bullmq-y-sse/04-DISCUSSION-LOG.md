# Phase 4: HTTP routes, worker BullMQ y SSE - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-16
**Phase:** 4-HTTP routes, worker BullMQ y SSE
**Areas discussed:** Stream SSE y puente worker→API, Jobs de connect y discover, Contrato de la API HTTP, Proceso worker y operación, Redis caído, Same-origin vs CORS, Cola BullMQ, Rate limit

---

## Stream SSE y puente worker→API

| Option | Description | Selected |
|--------|-------------|----------|
| Un stream global `/api/events` | Una conexión EventSource por pestaña; lista y detalle la comparten; escala a activity/deployments | ✓ |
| Un stream por servidor `/api/servers/:id/events` | N conexiones para la lista; límite de ~6 por origen en HTTP/1.1 | |
| Ambos | Más superficie por el mismo evento | |

| Option | Description | Selected |
|--------|-------------|----------|
| ServerView completo | Mismo shape que GET; sin GET extra tras cada transición; reutiliza allowlist | ✓ |
| Delta mínimo `{id, status, lastErrorCode, updatedAt}` | Evento pequeño; una petición más por transición | |

| Option | Description | Selected |
|--------|-------------|----------|
| Redis pub/sub propio | Canal `noodara:server-events`; cubre cambios que no nacen de un job | ✓ |
| QueueEvents de BullMQ | Solo cambios vía job; CONNECTING y ediciones desde el API no se verían | |
| Postgres LISTEN/NOTIFY | Payload ≤ 8 KB y conexión dedicada fuera de Drizzle | |

| Option | Description | Selected |
|--------|-------------|----------|
| Sin replay; heartbeat y la UI refresca por GET | `retry:` + keepalive ~15 s; sin estado en el API | ✓ |
| Snapshot inicial dentro del stream | Duplica la lógica de listado | |
| Replay con Last-Event-ID | Buffer/Redis Stream extra para un solo admin | |

| Option | Description | Selected |
|--------|-------------|----------|
| Los servicios, tras commit, vía puerto inyectado | `ServerServicesDeps.events`; connectAndDiscover publica tras TX1 y TX2 | ✓ |
| Los callers (rutas y worker) | CONNECTING invisible hasta terminar el job; cada caller debe acordarse | |

| Option | Description | Selected |
|--------|-------------|----------|
| `server.updated` y `server.deleted` | Dos tipos; la UI discrimina por status | ✓ |
| Un tipo por transición | Cada estado nuevo exige tipo nuevo | |
| Solo `server.updated` | Servidor borrado visible hasta el siguiente refresh | |

| Option | Description | Selected |
|--------|-------------|----------|
| Cookie al abrir; cierre al detectar sesión inválida | Re-validación en cada heartbeat; logout corta el push | ✓ |
| Cookie solo al abrir | Contradice AUTH-03 | |

| Option | Description | Selected |
|--------|-------------|----------|
| Límite por env var, default 32, 503 al superarlo | `NOODARA_SSE_MAX_CONNECTIONS` + Retry-After | ✓ |
| Sin límite en v0.1 | Sin techo ante un bug de reconexión | |

**User's choice:** todas las opciones recomendadas.
**Notes:** El usuario pidió una segunda ronda de preguntas en esta área (publisher, tipos, auth, límite).

---

## Jobs de connect y discover

| Option | Description | Selected |
|--------|-------------|----------|
| 202 con ServerView y jobId | Pre-check 404/409; jobId para logs, no polling | ✓ |
| 202 vacío con Location | Pierde jobId para correlación | |
| 200 con resultado completo (síncrono) | Contradice el criterio 1; ata la request al timeout SSH | |

| Option | Description | Selected |
|--------|-------------|----------|
| jobId determinista por servidor + 409 del servicio | `connect:<serverId>`; BullMQ ignora el segundo add; FOR UPDATE como segunda defensa | ✓ |
| Solo pre-comprobación en la ruta | Ventana entre lectura y consumo | |
| Columna `pending_job_id` | Migración y estado a mantener coherente | |

| Option | Description | Selected |
|--------|-------------|----------|
| Mismo job; discover exige CONNECTED, connect vale desde cualquier estado no CONNECTING | Un handler; distinta precondición e intención | ✓ |
| Alias exacto sin precondición | La UI no distingue Connect de Re-run | |
| Dos tipos de job | Duplica tests hoy | |

| Option | Description | Selected |
|--------|-------------|----------|
| Sin reintentos; stalled → ERROR CONNECTION_LOST vía servicio | `failInFlightConnection` + recorrido de CONNECTING al arrancar | ✓ |
| Reintentar el job una vez | El segundo intento encuentra ALREADY_CONNECTING | |
| Dejarlo en CONNECTING | Estado falso hasta intervención manual | |

| Option | Description | Selected |
|--------|-------------|----------|
| `{ serverId, actor, requestedAt, trigger }` | Sin host/usuario/credencial; validado con Zod al consumir | ✓ |
| Solo `{ serverId, actor }` | Sin trigger no se distingue en logs | |

| Option | Description | Selected |
|--------|-------------|----------|
| No; solo log pino con jobId | Coherente con el descarte de `server.connection_skipped` | ✓ |
| Sí, `server.connection_requested` | Ruido en ACT-02 y ampliación del union | |

| Option | Description | Selected |
|--------|-------------|----------|
| Sin timeout propio; lockDuration derivado de los timeouts SSH | Suma de presupuestos + 30 s | ✓ |
| Timeout de job fijo por env var | Abortar a mitad deja sesión y fila sin el finally | |

| Option | Description | Selected |
|--------|-------------|----------|
| Resultado no-ok = job completed con log; excepción = job failed | `failed` siempre significa bug o infraestructura | ✓ |
| Todo resultado no-ok marca el job failed | Mezcla borrado por el admin con Postgres caído | |

**User's choice:** todas las opciones recomendadas.
**Notes:** Segunda ronda solicitada (payload, activity al encolar, presupuesto, desenlace).

---

## Contrato de la API HTTP

| Option | Description | Selected |
|--------|-------------|----------|
| Tabla fija código→status; body `{ error, message }` | UPPER_SNAKE del servicio; Zod → 400 VALIDATION_FAILED con issues | ✓ |
| Mantener `{ error: 'snake_case' }` | Dos vocabularios | |
| RFC 9457 problem+json | Más pesado para cliente propio | |

| Option | Description | Selected |
|--------|-------------|----------|
| Plugin con onRequest hook y decorador `request.actor` | Scope encapsulado para /api/servers, /api/activity, /api/config, /api/events | ✓ |
| Comprobación dentro de cada handler | Fácil de olvidar | |

| Option | Description | Selected |
|--------|-------------|----------|
| DELETE `/api/servers/:id` con body `{ confirmName }` | REST correcto; Zod valida body | ✓ |
| POST `/api/servers/:id/delete` | Rompe simetría | |
| DELETE con query | Nombre en logs de acceso | |

| Option | Description | Selected |
|--------|-------------|----------|
| Cursor keyset por (occurred_at, id) con limit | Estable con eventos nuevos; limit 1–200 | ✓ |
| Offset y limit | Se desplaza al entrar eventos | |
| Sin paginación, últimos 100 | Contrato a cambiar en v0.3 | |

| Option | Description | Selected |
|--------|-------------|----------|
| `{ version, publicUrl, masterKeyFingerprint, sshTimeouts, workerConcurrency }` solo lectura | Derivado de env; sin tabla ni PUT | ✓ |
| Solo `{ version, publicUrl }` | Settings tendría que ampliar la API después | |
| Tabla settings con GET y PUT | Capacidad nueva no exigida | |

| Option | Description | Selected |
|--------|-------------|----------|
| Migrar setup.ts/sessions.ts/health.ts ahora, sin cambiar semántica | Un solo vocabulario antes del cliente de fase 5 | ✓ |
| Solo rutas nuevas, migrar después | Fase 5 manejaría dos formas de error | |

| Option | Description | Selected |
|--------|-------------|----------|
| Lista completa ordenada por nombre; PATCH parcial con credential opcional | `{ items }` sin paginar; POST 201 | ✓ |
| Lista con paginación cursor | Innecesario en v0.1 | |
| PUT con recurso completo | Complica D-14 | |

| Option | Description | Selected |
|--------|-------------|----------|
| Error handler global: 500 `INTERNAL_ERROR` opaco, log redactado | Canary extendido a rutas HTTP | ✓ |
| Handler por defecto de Fastify | Mensaje original al cliente | |

**User's choice:** todas las opciones recomendadas.
**Notes:** Segunda ronda solicitada (config, migración de rutas, lista/PATCH, 500s).

---

## Proceso worker y operación

| Option | Description | Selected |
|--------|-------------|----------|
| `src/worker.ts` como segundo entrypoint; dev arranca api y worker | start / start:worker con node plano; test:boot cubre el worker | ✓ |
| Un solo proceso con flag `--worker` | Mezcla ciclos de vida | |
| Worker embebido en dev, separado en prod | dev no probaría la topología real | |

| Option | Description | Selected |
|--------|-------------|----------|
| `NOODARA_WORKER_CONCURRENCY` default 5 (1–20); SIGTERM espera al job en vuelo | worker.close() con presupuesto derivado de timeouts SSH | ✓ |
| Concurrencia fija 1 | Lento para 100 conexiones consecutivas | |

| Option | Description | Selected |
|--------|-------------|----------|
| `/health` ampliado con redis y worker heartbeat | Heartbeat TTL 30 s; degraded sigue siendo 200 | ✓ |
| Solo comprobar Redis en /health | Worker caído sin señal | |
| Puerto HTTP propio en el worker | Listener extra | |

| Option | Description | Selected |
|--------|-------------|----------|
| Redis en Testcontainers + worker in-process en el test | `helpers/redis.ts`; SshPort falso y sshd real; E2E POST connect → SSE | ✓ |
| Mock de BullMQ y Redis en todos los tests | No prueba lock, stalled ni pub/sub reales | |

**User's choice:** todas las opciones recomendadas.

---

## Redis caído

| Option | Description | Selected |
|--------|-------------|----------|
| Arranca igual; encolar falla con 503; SSE sigue abierto sin eventos | `QUEUE_UNAVAILABLE`; ioredis reconecta y re-suscribe | ✓ |
| El API se niega a arrancar sin Redis | Un reinicio de Redis tumbaría el API | |

| Option | Description | Selected |
|--------|-------------|----------|
| Worker reconecta a Redis solo; ante Postgres caído el job falla y no se reintenta | Fail-fast solo al arrancar | ✓ |
| process.exit ante cualquier pérdida; Compose reinicia | Pierde el job activo de forma no controlada | |

**User's choice:** opciones recomendadas.

---

## Same-origin vs CORS

| Option | Description | Selected |
|--------|-------------|----------|
| Same-origin: Next.js proxya `/api/*`; sin CORS | Rechazo de Origin distinto en mutaciones como defensa CSRF | ✓ |
| CORS con credentials restringido a NOODARA_PUBLIC_URL | Preflights y SameSite=None sin necesidad | |

**User's choice:** opción recomendada.

---

## Cola BullMQ

| Option | Description | Selected |
|--------|-------------|----------|
| Cola `servers`, prefijo `noodara`, conservar 100 completados / 500 fallidos | ioredis maxRetriesPerRequest null; conexiones separadas | ✓ |
| Una cola por tipo de acción desde ya | Ya decidido un solo tipo de job | |
| Sin retención | Sin rastro para depurar | |

**User's choice:** opción recomendada.

---

## Rate limit

| Option | Description | Selected |
|--------|-------------|----------|
| No en v0.1; jobId determinista y sesión única bastan | Diferido a multiusuario/API keys | ✓ |
| `@fastify/rate-limit` por sesión en POST connect/discover | El 202 idempotente ya absorbe bucles | |

**User's choice:** opción recomendada.

---

## Claude's Discretion

- Nombres exactos de archivos y plugins dentro de `apps/control-plane/src/`.
- Formato del cursor de activity y del `workerId`.
- Cómo compartir `version` entre `health.ts` y `config.ts` respetando ADR 0003.
- Implementación SSE en Fastify 5 (`reply.raw` + `hijack()` vs plugin).
- Forma de `failInFlightConnection` y del recorrido de `CONNECTING` al arrancar.
- Dónde vive el check de `Origin` (hook del scope de mutaciones o `requireSession`).

## Deferred Ideas

- Rate limit por sesión/IP — multiusuario / API keys.
- Replay SSE con Last-Event-ID — v0.3 (logs de deploy) o más de un consumidor.
- Cola `deployments` — v0.3.
- Configuración global editable (tabla + PUT) — post v0.1.
- `server.connection_requested` — descartado.
- Stream SSE por servidor — descartado.
- Puerto HTTP en el worker — descartado.
- CORS con credentials — descartado para v0.1.
- Timeout de job por env var — descartado.
