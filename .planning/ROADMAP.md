# Roadmap: Noodara

## Overview

Noodara v0.1 Foundation prueba el core value del producto — conocer, registrar y comunicarse con infraestructura real de forma segura y consistente — sin construir todavía el resto del PaaS. El camino va de adentro hacia afuera: primero el dominio puro y la persistencia (estado, cifrado, auth), luego el componente de mayor riesgo (el adaptador SSH, aislado y probado contra infraestructura efímera real vía Testcontainers), después los servicios de aplicación que orquestan dominio + SSH + activity log + redacción, luego la superficie HTTP/worker/SSE que expone esos servicios en tiempo real, después la UI web del design system Apple-inspired que cierra el flujo end-to-end, y por último el instalador de un comando — deliberadamente al final, porque solo entonces refleja las variables de entorno, healthchecks y contenedores reales en vez de una suposición.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Dominio, persistencia y autenticación** - Base de datos migrada, dominio ≥95% cubierto y un admin único que inicia/cierra sesión de forma segura. (completed 2026-09-12)
- [x] **Phase 2: Adaptador SSH aislado y probado con Testcontainers** - Conexión SSH con TOFU, timeouts, allowlist de comandos y discovery, validado contra un `sshd` real. (completed 2026-09-15)
- [x] **Phase 3: Servicios de aplicación, activity log y redacción** - Registrar/editar/eliminar servidores, snapshots de discovery y un activity log sin fugas de secrets. (completed 2026-09-16)
- [x] **Phase 4: HTTP routes, worker BullMQ y SSE** - La API expone connect/discover en background y el estado llega a tiempo real sin polling. (completed 2026-09-18)
- [ ] **Phase 5: UI web** - El flujo login → Servers → add → connect → discovery → detail funciona en el design system Apple-inspired, dark y light. (25/25 plans executed 2026-09-20; verification gaps_found — gap closure planned 2026-09-20: 05-26…05-37, 0/12 executed)
- [ ] **Phase 6: Instalador y Docker Compose** - Un comando deja Noodara operativo en un VPS Ubuntu limpio, de forma idempotente.

## Phase Details

### Phase 1: Dominio, persistencia y autenticación

**Goal**: El control plane arranca sobre una base de datos migrada, con el dominio central (entidad Server, state machine de conexión, validadores, cifrado) completamente probado, y un único admin que puede crearse una sola vez, iniciar sesión y cerrarla de forma segura.
**Depends on**: Nothing (first phase)
**Requirements**: INST-06, AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, SERV-05, SEC-01, QA-01, QA-02, QA-06
**Success Criteria** (what must be TRUE):

  1. El proceso del control plane se niega a arrancar (falla rápido, log accionable) si falta o es débil `NOODARA_MASTER_KEY`, el secret de sesión o el password de la base de datos; no existen valores por defecto embebidos.
  2. El primer admin solo puede crearse presentando un setup token válido; el token expira al usarse o a las 24 h, y un segundo intento con el mismo token (o uno expirado) falla.
  3. El admin inicia sesión con email/password (argon2id) y recibe una cookie `HttpOnly`, `Secure`, `SameSite=Lax` con id rotado; la sesión persiste entre recargas del navegador y se invalida en el servidor al cerrarla desde cualquier pantalla.
  4. Los intentos de login fallidos están limitados por tasa (IP y cuenta) y se registran en el activity log sin incluir el password.
  5. Las credenciales SSH se cifran con AES-256-GCM (nonce único por operación, metadato de versión de clave por fila) antes de persistirse, con test de roundtrip que falla ante tamper en ciphertext o tag; `packages/domain` alcanza ≥95% statement/branch coverage en validadores y en la state machine de 6 estados (transiciones centralizadas y validadas); las migraciones aplican limpio desde cero y desde el snapshot de la versión anterior; CI bloquea el merge si falla lint, typecheck, unit, integration ligera, gitleaks o `pnpm audit`.

**Plans**: 17 plans in 10 waves

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Automated package provenance check before the first dependency install

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Monorepo workspace, shared config, Vitest harness and the packages/domain skeleton

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — Control-plane bootstrap: Zod type-provider pin, redacting logger, fail-fast env (INST-06)
- [x] 01-04-PLAN.md — Domain: Server state machine and connection-result mapping (SERV-05)
- [x] 01-05-PLAN.md — Domain: SecretValue, Redactor and AES-256-GCM envelope with key versioning (SEC-01)
- [x] 01-06-PLAN.md — Domain: network/identity validators, password policy and ActivityEvent type

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-07-PLAN.md — Postgres schema, first migration applied for real, Testcontainers harness

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 01-08-PLAN.md — Migration tests from scratch and from the previous snapshot (QA-06)
- [x] 01-09-PLAN.md — Single activity-log writer for auth events plus the redaction canary proof
- [x] 01-10-PLAN.md — Better Auth core: argon2id, login/logout, hardened cookies, session-id rotation

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 01-11-PLAN.md — Sliding 7-day session with a 30-day ceiling, plus session list and revoke endpoints
- [x] 01-12-PLAN.md — Setup token module, POST /api/setup and the sign-up gate (AUTH-01)
- [x] 01-13-PLAN.md — Per-IP and per-account progressive login lockout (AUTH-04)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 01-14-PLAN.md — First-boot admin bootstrap, admin reset and secrets rotate CLI

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 01-15-PLAN.md — CI pipeline with the six QA-01 gates and the completed validation contract

**Wave 9** *(gap closure — 01-VERIFICATION.md BLOCKER: the control plane does not boot through any documented command)*

- [x] 01-16-PLAN.md — Real boot path: packages/domain built to dist, `tsx watch` dev, plain-node `start`, child-process boot smoke test

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 01-17-PLAN.md — boot-smoke CI gate, ADR 0003 runtime/module-resolution contract, closed validation map

**Cross-cutting constraints:**

- packages/domain statement and branch coverage stays at or above 95% (QA-02)

### Phase 2: Adaptador SSH aislado y probado con Testcontainers

**Goal**: Noodara se conecta a un servidor Ubuntu real por SSH, verifica su host fingerprint (TOFU), ejecuta únicamente comandos de una allowlist con timeouts explícitos, y clasifica cada fallo con un `error_code` específico — probado contra infraestructura SSH efímera real antes de integrarse al resto del sistema.
**Depends on**: Phase 1
**Requirements**: SERV-07, SERV-08, SEC-03, SEC-04, SEC-05, DISC-01, DISC-04, QA-03
**Success Criteria** (what must be TRUE):

  1. Al conectar contra un contenedor `sshd` real (Ubuntu 22.04 y 24.04) por primera vez, Noodara captura y persiste el host fingerprint (TOFU); si el host key cambia en una reconexión posterior, la conexión falla con `HOST_KEY_CHANGED` hasta una re-confirmación explícita, nunca se auto-acepta.
  2. Cada fallo de conexión produce un `error_code` específico de la lista completa (AUTH_FAILED, HOST_UNRESOLVED, CONNECT_TIMEOUT, COMMAND_TIMEOUT, HOST_KEY_CHANGED, CONNECTION_LOST, UNSUPPORTED_OS), con timeout explícito e independiente para la conexión y para cada comando, y nunca lanza una excepción no controlada.
  3. La validación de un usuario SSH no-root con sudo sin password ejecuta `sudo -n` y comprueba la pertenencia al grupo `docker`, reportando cada check por separado.
  4. `runDiscovery` recolecta hostname, distribución, versión de OS, arquitectura, CPU, RAM, disco, uptime y Docker+versión mediante plantillas de comando fijas (nunca interpoladas con input del usuario) sobre una sola conexión reutilizada; un OS no soportado se marca `UNSUPPORTED_OS` sin bloquear el resto de los datos ya recolectados.
  5. La suite de integración con Testcontainers cubre, para ambas versiones de Ubuntu, conexión exitosa, credenciales inválidas, host inválido, timeout de red, timeout de comando, pérdida de conexión, reconexión y ejecución segura de comandos, limpiando sus recursos después de cada escenario; el stdout/stderr capturado pasa por el redactor antes de persistirse o mostrarse.

**Plans**: 10 plans in 6 waves

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — packages/ssh scaffold, the SshPort/discovery type contracts and the frozen command allowlist
- [x] 02-02-PLAN.md — Project-owned Ubuntu 22.04/24.04 sshd images and the Testcontainers helper
- [x] 02-03-PLAN.md — Migration 0002 fingerprint timestamps, its from-snapshot proof, and the three SSH timeout env knobs

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-04-PLAN.md — Empirical spikes for the three RESEARCH open questions, real discovery fixtures and ADR 0004

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-05-PLAN.md — Pure discovery parsers against real captures, plus D-11's UNSUPPORTED_OS remapping
- [x] 02-06-PLAN.md — Private key loading policy, fingerprint derivation and the TOFU verifier with no bypass
- [x] 02-07-PLAN.md — Exhaustive ssh2 error classification and the per-command timeout/redaction/truncation wrapper

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 02-08-PLAN.md — Ssh2Adapter implementing SshPort, the D-10 single retry and the per-server connection mutex

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 02-09-PLAN.md — runDiscovery orchestration, partial-failure warnings and the public @noodara/ssh surface

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 02-10-PLAN.md — QA-03: all eight roadmap §6.5 scenarios against real sshd containers on both Ubuntu versions

**Cross-cutting constraints:**

- packages/domain statement and branch coverage stays at or above 95% (QA-02)
- `ssh2` is importable only from `packages/ssh`, enforced by Turborepo boundaries and a static guard test
- Every scenario destroys its containers; no `noodara.test=true` resource survives a run

### Phase 3: Servicios de aplicación, activity log y redacción

**Goal**: Las reglas para registrar, editar y eliminar servidores, y para dejar constancia de cada operación relevante, quedan centralizadas en servicios de aplicación reutilizables (el único punto de entrada que usarán después tanto la API como el worker), con un activity log y una redacción de secrets verificable con evidencia.
**Depends on**: Phase 1, Phase 2
**Requirements**: SERV-01, SERV-02, SERV-03, SEC-02, DISC-03, ACT-01
**Success Criteria** (what must be TRUE):

  1. Un servidor se registra con nombre, host, puerto SSH, usuario SSH y credencial (clave privada o password) ya cifrada; la credencial nunca se devuelve en texto plano en el resultado del servicio.
  2. Editar un servidor permite reemplazar su credencial sin precargar ni mostrar nunca la existente; eliminar un servidor borra su credencial en la misma transacción y deja un evento registrado.
  3. Cada discovery exitoso escribe un `DiscoverySnapshot` append-only y, en la misma operación, actualiza los campos denormalizados de `Server` (estado, hostname, OS, recursos, last seen) que leerá después la vista de detalle.
  4. Se registran eventos tipados para setup, login, logout, login fallido, servidor creado/editado/eliminado, intento de conexión con su resultado y discovery ejecutado — escritos solo desde los servicios de aplicación, nunca desde rutas o el worker directamente.
  5. Un test con valores canary alimenta logs de aplicación, errores simulados y `ActivityEvent` con un secret conocido y confirma que no aparece en ninguna salida.

**Plans**: 10 plans in 6 waves

Plans:

**Wave 1** *(parallel)*

- [x] 03-01-PLAN.md — Wiring de @noodara/ssh en control-plane, export aditivo de loadPrivateKey (D-15) y semántica D-03 en el doc de transiciones
- [x] 03-02-PLAN.md — Funciones puras de dominio: mergeDiscoveryFacts, classifySnapshotOutcome, classifyServerEdit y las seis acciones server.*
- [x] 03-03-PLAN.md — [BLOCKING] Esquema + migración 0003: discovery_snapshots, docker_compose_version e índices únicos lower(name) y (host, ssh_port)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-04-PLAN.md — credential-store (envelope ↔ SshCredential, D-15), proyección ServerView (D-19) y dependencias inyectadas + ServiceActor

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-05-PLAN.md — registerServer (SERV-01) y el harness de integración compartido para los servicios

**Wave 4** *(parallel, blocked on Wave 3 completion)*

- [x] 03-06-PLAN.md — editServer (SERV-02): reemplazo de credencial in situ, SERVER_BUSY y transiciones D-14
- [x] 03-07-PLAN.md — deleteServer (SERV-03): confirmación por nombre, evento antes del borrado y cascada de snapshots
- [x] 03-08-PLAN.md — connectAndDiscover (DISC-03): lock D-05, fingerprints, snapshot append-only y denormalización

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 03-09-PLAN.md — trustFingerprint (D-04), factoría createServerServices y boundary test de ACT-01

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 03-10-PLAN.md — SEC-02: canary de flujo completo contra sshd real y `pnpm security:scan-leaks` como gate de CI

**Cross-cutting constraints:**

- Sin rutas HTTP, worker BullMQ, SSE, UI ni instalador: esta fase entrega solo servicios de aplicación
- Todo evento de `activity_events` se escribe únicamente desde `src/services/` (test de boundary estático)
- packages/domain sigue puro y con cobertura ≥95% statement/branch (QA-02)
- `pnpm security:scan-leaks`, `pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint` y `turbo boundaries` en verde antes de verificar la fase

### Phase 4: HTTP routes, worker BullMQ y SSE

**Goal**: El admin puede disparar acciones sobre un servidor vía la API HTTP y ver su estado cambiar en tiempo real sin recargar la página, mientras el trabajo pesado de SSH corre en el worker sin bloquear el proceso de la API.
**Depends on**: Phase 3
**Requirements**: SERV-06, DISC-05
**Success Criteria** (what must be TRUE):

  1. `POST /servers/:id/connect` encola un job en BullMQ y responde de inmediato; la conexión SSH se ejecuta en el worker, fuera del hilo de la API.
  2. Un cliente conectado al endpoint SSE recibe las transiciones de estado del servidor (PENDING → CONNECTING → CONNECTED/UNREACHABLE/ERROR) sin hacer polling.
  3. El discovery puede volver a dispararse bajo demanda (`POST /servers/:id/discover`) en cualquier momento después de CONNECTED, reutilizando el mismo `DiscoverServerService` que el flujo automático post-connect.
  4. Las rutas de auth, servers, activity y config validan su input con Zod y devuelven códigos HTTP correctos; un host inválido o un timeout de conexión responden con un error controlado y el proceso de la API sigue vivo.

**Plans**: 11 plans in 6 waves

Plans:

**Wave 1** *(parallel — foundation, no cross-dependencies)*

- [x] 04-01-PLAN.md — Dependencias verificadas (bullmq/ioredis/@testcontainers/redis), env knobs, fixture de Redis y el presupuesto puro del job
- [x] 04-02-PLAN.md — Vocabulario de la API: mapa único código→status (D-16), plugin `requireSession` (D-17) y guard de `Origin` (D-29)
- [x] 04-03-PLAN.md — Puerto `events` en `ServerServicesDeps` y publicación post-commit en los cinco servicios de fase 3 (D-04)

**Wave 2** *(parallel, blocked on Wave 1)*

- [x] 04-04-PLAN.md — Composición de `app.ts`: error handler global (D-22), scope `/api` con guard y migración D-18 de setup/sessions/health
- [x] 04-05-PLAN.md — `failInFlightConnection` y `listConnectingServerIds`: un servidor nunca queda en CONNECTING (D-12)
- [x] 04-06-PLAN.md — Contrato del job, conexiones ioredis por rol y productor de cola acotado con dedupe (D-09, D-27, D-28)

**Wave 3** *(parallel, blocked on Wave 2)*

- [x] 04-07-PLAN.md — Worker BullMQ: handler, política de desenlace (D-15), recuperación de stalled/arranque, heartbeat y `worker.ts` + scripts (D-23)
- [x] 04-08-PLAN.md — Rutas `/api/servers`: CRUD, trust-fingerprint y el 202 de connect/discover (SERV-06, DISC-05)

**Wave 4** *(blocked on Wave 3)*

- [x] 04-09-PLAN.md — Puente Redis pub/sub, broadcaster y `GET /api/events` con heartbeat, re-validación de sesión, límite y `preClose`

**Wave 5** *(blocked on Wave 4)*

- [x] 04-10-PLAN.md — `GET /api/activity` con cursor keyset (D-20), `GET /api/config` (D-21) y `/health` con checks postgres/redis/worker (D-26)

**Wave 6** *(blocked on Wave 5 — puerta de fase)*

- [x] 04-11-PLAN.md — E2E de la API contra sshd real vía SSE, canary de fugas ampliado a HTTP/SSE, boot-smoke de api+worker y contrato de validación cerrado

**Cross-cutting constraints:**

- Solo `src/services/` y `src/activity/` escriben `activity_events` (boundary test de fase 3 sin cambios)
- `packages/domain` y `packages/ssh` no cambian de contrato; `auth/auth.ts` y `routes/auth.ts` no se tocan
- Cada tarea sigue RED → GREEN → REFACTOR con un `<automated>` verify propio
- `pnpm test`, `pnpm test:integration`, `pnpm test:boot`, `pnpm security:scan-leaks`, `pnpm typecheck`, `pnpm lint` y `pnpm boundaries` en verde antes de verificar la fase

### Phase 5: UI web

**Goal**: El admin completa de punta a punta el flujo login → Servers → add server → connect → discovery → detail usando el shell del design system Apple-inspired de Noodara, en dark y light, con estados vacío/carga/error en cada pantalla.
**Depends on**: Phase 4
**Requirements**: SERV-04, DETL-01, DETL-02, ACT-02, SET-01, UI-01, UI-02, DISC-02, QA-04, QA-05
**Success Criteria** (what must be TRUE):

  1. El shell de la app (sidebar, toolbar, contenido) funciona en dark y light con navegación por teclado, y existen las pantallas de setup, login, lista de servidores, sheet de crear/editar servidor, detalle de servidor, activity log y settings, cada una con estado vacío, de carga y de error.
  2. La lista de servidores muestra nombre, host, status pill y last seen; el detalle muestra hostname, status, OS, CPU, RAM, disco, uptime, Docker, last seen y host fingerprint, distinguiendo "aún no descubierto" de "discovery falló" con una única acción cada uno.
  3. El progreso del discovery se muestra check por check (SSH → auth → OS → recursos → Docker → sudo/grupo docker) con pass/fail y detalle por check, nunca un spinner genérico.
  4. El activity log se ve como lista cronológica inversa con actor, entidad, acción y timestamp sin metadatos sensibles; settings muestra la versión y la URL pública de la instancia.
  5. El E2E de Playwright cubre login → Servers → add server → connect → discovery → detail, y el nightly lo repite 20/20 veces; un job de canary secrets confirma en el mismo run que ningún secret aparece en ninguna salida de la UI ni de la API a lo largo de ese flujo completo.

**Plans**: 37 plans (25 executed in 15 waves + 12 gap-closure plans in 4 waves)

Plans:

**Wave 1** *(parallel — remediación de seguridad de fase 4, bloquea todo lo demás por D-17)*

- [x] 05-01-PLAN.md — Cierre del bypass TOFU UF-01 en `editServer` y acotado de las dos búsquedas de sesión (T-4-02)
- [x] 05-02-PLAN.md — Serializador `err` central en pino (T-4-10/T-4-38) y secuencia de apagado del worker endurecida (T-4-32)

**Wave 2** *(parallel, blocked on Wave 1)*

- [x] 05-03-PLAN.md — Puertas: procedencia de los 22 paquetes nuevos (incluido el stack de test de componentes), addendum ADR-0000 y firma de `04-SECURITY.md` (checkpoint humano)
- [x] 05-04-PLAN.md — Callback `onCheck` en `runDiscovery`, evento `server.discovery_progress` y allowlist del broadcaster (D-05)

**Wave 3** *(parallel, blocked on Wave 2)*

- [x] 05-05-PLAN.md — `GET /api/servers/:id/discovery` con schema Zod y drift guard, más extensión del canary (DISC-02, QA-05)
- [x] 05-06-PLAN.md — Scaffold de `packages/ui`, proyecto Vitest `dom` + arnés `@noodara/ui/testing`, `tokens.css`, tema Tailwind v4 y ADR-0005

**Wave 4** *(parallel, blocked on Wave 3)*

- [x] 05-07-PLAN.md — Scaffold de `apps/web`: proxy same-origin, tema sin flash, cliente de API probado y ADR-0006
- [x] 05-22-PLAN.md — `tone`, `cn`, `Button` y `StatusPill` test-first: las cuatro variantes y los seis estados con cobertura de comportamiento

**Wave 5** *(parallel, blocked on Wave 4)*

- [x] 05-08-PLAN.md — Componentes de formulario en Radix test-first: `Field`, `Input`, `Textarea`, `SegmentedControl`
- [x] 05-10-PLAN.md — Arnés Playwright real: stack completo (Postgres, Redis, API, worker, web), config y smoke spec (QA-04)

**Wave 6** *(blocked on Wave 5)*

- [x] 05-23-PLAN.md — Overlays y lectura de fichero test-first: `confirm-match`, `FileButton`, `Sheet`, `Dialog` (D-04, D-12)

**Wave 7** *(blocked on Wave 6)*

- [x] 05-09-PLAN.md — Formatters puros y componentes de estado test-first: `Banner`, `Notice`, `EmptyState`, `Skeleton` (UI-02)

**Wave 8** *(blocked on Wave 7)*

- [x] 05-24-PLAN.md — Presentación de datos test-first: `Tooltip`, `RelativeTime`, `CopyButton`, `StatTile`, `LabelValue` (D-11)

**Wave 9** *(blocked on Wave 8)*

- [x] 05-25-PLAN.md — Interacción test-first: `ListRow`, `RowMenu`, `Disclosure`, `ThemeToggle` (D-09, D-16)

**Wave 10** *(parallel, blocked on Wave 9)*

- [x] 05-11-PLAN.md — Pantallas de setup y login con mapa de copy de errores exhaustivo, sin oráculo de existencia de cuenta
- [x] 05-12-PLAN.md — Shell autenticado (UI-01): sidebar, toolbar, sign out y el único `EventSource` con resync

**Wave 11** *(parallel, blocked on Wave 10)*

- [x] 05-13-PLAN.md — Lista de servidores con filas de 44px, actualización en vivo y los tres estados (SERV-04, D-09)
- [x] 05-14-PLAN.md — Detalle: cuatro stat tiles, grupos System/Docker/Connection y los dos estados de DETL-02
- [x] 05-15-PLAN.md — Activity log: frases por acción, claves curadas, agrupación por día y paginación por cursor (ACT-02)
- [x] 05-16-PLAN.md — Settings de solo lectura con grupos Instance y Advanced (SET-01, D-16)

**Wave 12** *(parallel, blocked on Wave 11)*

- [x] 05-17-PLAN.md — Sheet de alta/edición con credencial leída en el navegador y diálogo de borrado (D-01, D-04)
- [x] 05-18-PLAN.md — Narrativa de discovery: seis pasos, severidades honestas y la regla de no inventar progreso (DISC-02)

**Wave 13** *(blocked on Wave 12)*

- [x] 05-19-PLAN.md — Superficies de host key: aviso TOFU único, banner `HOST_KEY_CHANGED` y diálogo de confianza (D-02, D-03, D-17)

**Wave 14** *(blocked on Wave 13)*

- [x] 05-20-PLAN.md — Critical path E2E contra el contenedor sshd real, job de CI y workflow nightly 20/20 (QA-04)

**Wave 15** *(blocked on Wave 14)*

- [x] 05-21-PLAN.md — Canary de secrets en las superficies del navegador, `check:ui-safety`, suite completa y revisión de design system (QA-05)

**Gap closure** *(planned 2026-09-20 from 05-VERIFICATION.md, 8 gaps; 12 plans in 4 waves, after Wave 15)*

**Gap Wave 1** *(parallel-safe: disjoint files)*

- [x] 05-26-PLAN.md — CONNECTING wedge: try/catch tras TX1 en `connect-and-discover.ts` y listener `failed` del worker → `failInFlightConnection` (gap 2 backend, WR-A-01)
- [x] 05-27-PLAN.md — Trust de host key en backend: body `{ fingerprint }`, promote atómico condicional, 409 `FINGERPRINT_MISMATCH`, limpieza de `pendingFingerprint` en todo edit de identidad (gap 6, WR-A-02)
- [ ] 05-28-PLAN.md — Hardening de navegador: timeout con `AbortSignal` en `api-client.ts`, guard de clipboard, `safe-storage.ts`, `(shell)/error.tsx` (gap 4)
- [ ] 05-30-PLAN.md — Errores de campo del servidor se pintan (`normalizeFieldPath`), tres fallos de setup distinguibles, token fuera de la URL y `Referrer-Policy` (gap 5)
- [ ] 05-32-PLAN.md — Activity log correcto durante el refresh, reproducir antes de arreglar (gap 7, WR-B-04/05/06)
- [ ] 05-34-PLAN.md — Fuga de slots SSE, serializer de `err` en `server.ts`, `main()` del worker sin try/catch (gap 8: WR-A-03, WR-A-04, UF-02)
- [ ] 05-36-PLAN.md — CI: `playwright install` en el job `security`, permisos/timeouts por job, actions fijadas por SHA, provenance gate desde el lockfile, `docs/ci-readiness.md` (gap 3 local, WR-C-14)

**Gap Wave 2** *(blocked on Gap Wave 1)*

- [ ] 05-29-PLAN.md — Discovery sin progreso inventado (`lastReceivedIndex`) y guard de orden snapshot-vs-evento en el detalle (`applyServer`) (gap 1, gap 2 frontend)
- [ ] 05-31-PLAN.md — El diálogo de trust captura el fingerprint al abrir y envía exactamente ese valor; E2E de swap a mitad de revisión (gap 6 frontend, WR-B-12)
- [ ] 05-35-PLAN.md — Ruta `/`, hydration de ThemeToggle, redirect de sesión revocada (gap 8: WR-B-15, WR-C-01, WR-B-10)

**Gap Wave 3** *(blocked on Gap Wave 2; NOT autonomous — decisión del usuario)*

- [ ] 05-33-PLAN.md — Contraste AA: candidatos medidos, el usuario elige los colores, cambio de tokens y gate automático ≥4.5:1 (gap 4, UX FLAG 1, WR-C-08)

**Gap Wave 4** *(blocked on Gap Wave 3; NOT autonomous — verificación humana)*

- [ ] 05-37-PLAN.md — Gate completo de todas las suites en una corrida, auditoría por gap re-derivada del código y checkpoint de los ítems solo-humanos (QA-04/QA-05 siguen Pending hasta un run real de CI)

**Cross-cutting constraints:**

- D-17 es bloqueante: nada de `packages/ui` ni `apps/web` se toca antes de que las cinco amenazas de fase 4 estén cerradas con evidencia
- `packages/domain` y `packages/ssh` solo cambian de forma aditiva (`onCheck`); ningún cambio de esquema de base de datos en esta fase
- Toda dependencia nueva pasa por `scripts/check-package-provenance.mjs` antes de instalarse (ADR-0000)
- Cada tarea sigue RED → GREEN → REFACTOR con un `<automated>` verify propio; los componentes se verifican con tests de componente Vitest colocados (proyecto `dom`, jsdom + Testing Library) escritos **antes** del componente, y Playwright cubre flujos, teclado real, theming y fugas de credenciales (ADR-0005, CLAUDE.md §2.1)
- Tokens y componentes solo desde la skill `noodara-ux-apple`; cero literales de color, cero spinners, cero `dangerouslySetInnerHTML` salvo el bootstrap de tema revisado
- `pnpm test`, `pnpm test:integration`, `pnpm test:boot`, `pnpm test:e2e`, `pnpm security:scan-leaks`, `pnpm check:ui-safety`, `pnpm typecheck`, `pnpm lint` y `pnpm boundaries` en verde antes de verificar la fase

**UI hint**: yes

### Phase 6: Instalador y Docker Compose

**Goal**: Cualquiera instala Noodara en un VPS Ubuntu 22.04/24.04 limpio con un solo comando, al nivel de simplicidad de Coolify y Dokploy, y volver a ejecutar el instalador sobre una instalación existente no destruye nada.
**Depends on**: Phase 5
**Requirements**: INST-01, INST-02, INST-03, INST-04, INST-05
**Success Criteria** (what must be TRUE):

  1. Un `curl | sh` en un VPS limpio instala Docker y el plugin Compose si faltan, genera un `.env` con secrets aleatorios, levanta api/worker/web/postgres/redis con Docker Compose y aplica las migraciones, sin ningún paso manual de SSH.
  2. El preflight falla con un mensaje accionable antes de tocar el sistema si el OS no es soportado, hay puertos en uso, Docker está instalado vía snap, la arquitectura no es compatible o la RAM es insuficiente.
  3. Volver a ejecutar el instalador sobre una instalación existente la detecta y actualiza o no hace nada, sin destruir datos ni secrets.
  4. Al terminar, el instalador imprime la URL del panel y un setup token de un solo uso; alternativamente, con `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` definidas crea el admin directamente, sin pasar por el setup interactivo.

**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Dominio, persistencia y autenticación | 17/17 | Complete    | 2026-09-12 |
| 2. Adaptador SSH aislado y probado con Testcontainers | 10/10 | Complete    | 2026-09-15 |
| 3. Servicios de aplicación, activity log y redacción | 10/10 | Complete   | 2026-09-16 |
| 4. HTTP routes, worker BullMQ y SSE | 11/11 | Complete   | 2026-09-18 |
| 5. UI web | 27/37 | In Progress|  |
| 6. Instalador y Docker Compose | 0/TBD | Not started | - |
