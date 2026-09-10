# Roadmap: Noodara

## Overview

Noodara v0.1 Foundation prueba el core value del producto — conocer, registrar y comunicarse con infraestructura real de forma segura y consistente — sin construir todavía el resto del PaaS. El camino va de adentro hacia afuera: primero el dominio puro y la persistencia (estado, cifrado, auth), luego el componente de mayor riesgo (el adaptador SSH, aislado y probado contra infraestructura efímera real vía Testcontainers), después los servicios de aplicación que orquestan dominio + SSH + activity log + redacción, luego la superficie HTTP/worker/SSE que expone esos servicios en tiempo real, después la UI web del design system Apple-inspired que cierra el flujo end-to-end, y por último el instalador de un comando — deliberadamente al final, porque solo entonces refleja las variables de entorno, healthchecks y contenedores reales en vez de una suposición.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Dominio, persistencia y autenticación** - Base de datos migrada, dominio ≥95% cubierto y un admin único que inicia/cierra sesión de forma segura.
- [ ] **Phase 2: Adaptador SSH aislado y probado con Testcontainers** - Conexión SSH con TOFU, timeouts, allowlist de comandos y discovery, validado contra un `sshd` real.
- [ ] **Phase 3: Servicios de aplicación, activity log y redacción** - Registrar/editar/eliminar servidores, snapshots de discovery y un activity log sin fugas de secrets.
- [ ] **Phase 4: HTTP routes, worker BullMQ y SSE** - La API expone connect/discover en background y el estado llega a tiempo real sin polling.
- [ ] **Phase 5: UI web** - El flujo login → Servers → add → connect → discovery → detail funciona en el design system Apple-inspired, dark y light.
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

**Plans**: 15 plans in 8 waves

Plans:
**Wave 1**

- [ ] 01-01-PLAN.md — Automated package provenance check before the first dependency install

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 01-02-PLAN.md — Monorepo workspace, shared config, Vitest harness and the packages/domain skeleton

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 01-03-PLAN.md — Control-plane bootstrap: Zod type-provider pin, redacting logger, fail-fast env (INST-06)
- [ ] 01-04-PLAN.md — Domain: Server state machine and connection-result mapping (SERV-05)
- [ ] 01-05-PLAN.md — Domain: SecretValue, Redactor and AES-256-GCM envelope with key versioning (SEC-01)
- [ ] 01-06-PLAN.md — Domain: network/identity validators, password policy and ActivityEvent type

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 01-07-PLAN.md — Postgres schema, first migration applied for real, Testcontainers harness

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 01-08-PLAN.md — Migration tests from scratch and from the previous snapshot (QA-06)
- [ ] 01-09-PLAN.md — Single activity-log writer for auth events plus the redaction canary proof
- [ ] 01-10-PLAN.md — Better Auth core: argon2id, login/logout, hardened cookies, session-id rotation

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 01-11-PLAN.md — Sliding 7-day session with a 30-day ceiling, plus session list and revoke endpoints
- [ ] 01-12-PLAN.md — Setup token module, POST /api/setup and the sign-up gate (AUTH-01)
- [ ] 01-13-PLAN.md — Per-IP and per-account progressive login lockout (AUTH-04)

**Wave 7** *(blocked on Wave 6 completion)*

- [ ] 01-14-PLAN.md — First-boot admin bootstrap, admin reset and secrets rotate CLI

**Wave 8** *(blocked on Wave 7 completion)*

- [ ] 01-15-PLAN.md — CI pipeline with the six QA-01 gates and the completed validation contract

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

**Plans**: TBD

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

**Plans**: TBD

### Phase 4: HTTP routes, worker BullMQ y SSE

**Goal**: El admin puede disparar acciones sobre un servidor vía la API HTTP y ver su estado cambiar en tiempo real sin recargar la página, mientras el trabajo pesado de SSH corre en el worker sin bloquear el proceso de la API.
**Depends on**: Phase 3
**Requirements**: SERV-06, DISC-05
**Success Criteria** (what must be TRUE):

  1. `POST /servers/:id/connect` encola un job en BullMQ y responde de inmediato; la conexión SSH se ejecuta en el worker, fuera del hilo de la API.
  2. Un cliente conectado al endpoint SSE recibe las transiciones de estado del servidor (PENDING → CONNECTING → CONNECTED/UNREACHABLE/ERROR) sin hacer polling.
  3. El discovery puede volver a dispararse bajo demanda (`POST /servers/:id/discover`) en cualquier momento después de CONNECTED, reutilizando el mismo `DiscoverServerService` que el flujo automático post-connect.
  4. Las rutas de auth, servers, activity y config validan su input con Zod y devuelven códigos HTTP correctos; un host inválido o un timeout de conexión responden con un error controlado y el proceso de la API sigue vivo.

**Plans**: TBD

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

**Plans**: TBD
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
| 1. Dominio, persistencia y autenticación | 0/15 | Planned | - |
| 2. Adaptador SSH aislado y probado con Testcontainers | 0/TBD | Not started | - |
| 3. Servicios de aplicación, activity log y redacción | 0/TBD | Not started | - |
| 4. HTTP routes, worker BullMQ y SSE | 0/TBD | Not started | - |
| 5. UI web | 0/TBD | Not started | - |
| 6. Instalador y Docker Compose | 0/TBD | Not started | - |
