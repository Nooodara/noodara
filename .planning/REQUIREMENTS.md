# Requirements: Noodara

**Defined:** 2026-09-10
**Core Value:** Noodara puede conocer, registrar y comunicarse con infraestructura real de forma segura y consistente: sin fugas de credenciales, sin estados falsos, sin caídas por fallos del servidor remoto.

Milestone: **v0.1 Foundation**. Fuente de alcance: [docs/roadmap-v0.1-v0.5.md](../docs/roadmap-v0.1-v0.5.md) sección 6, más las adiciones aprobadas tras research (setup token, sudo no-root, narrativa de discovery, pre-seed de admin).

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Installation

- [ ] **INST-01**: El usuario instala Noodara en un VPS Ubuntu 22.04/24.04 limpio con un solo comando `curl | sh` que instala Docker y el plugin Compose si faltan, genera `.env` con secrets aleatorios, levanta api/worker/web/postgres/redis con Docker Compose y aplica migraciones.
- [ ] **INST-02**: Volver a ejecutar el instalador sobre una instalación existente no destruye datos ni secrets: detecta la instalación y actualiza o no hace nada.
- [ ] **INST-03**: El instalador hace preflight (OS soportado, puertos en uso, Docker instalado vía snap, arquitectura, RAM mínima) y falla con un mensaje accionable antes de tocar el sistema.
- [ ] **INST-04**: Al terminar, el instalador imprime la URL del panel y un setup token de un solo uso para crear el admin.
- [ ] **INST-05**: El instalador acepta variables opcionales (`NOODARA_ADMIN_EMAIL`, `NOODARA_ADMIN_PASSWORD`) para crear el admin sin pasar por el setup interactivo.
- [x] **INST-06**: El control plane se niega a arrancar si falta o es débil cualquier secret requerido (clave de cifrado, auth secret, password de base de datos); no existen valores por defecto.

### Auth & Setup

- [x] **AUTH-01**: El primer admin solo puede crearse presentando el setup token; el token expira al usarse o a las 24 h y la ruta de setup desaparece después.
- [x] **AUTH-02**: El admin inicia sesión con email y password (argon2id vía Better Auth) y la sesión persiste entre recargas del navegador.
- [x] **AUTH-03**: El admin cierra sesión desde cualquier pantalla y la sesión queda invalidada en el servidor.
- [x] **AUTH-04**: El login está limitado por tasa por IP y por cuenta; los intentos fallidos se registran en el activity log sin incluir el password.
- [x] **AUTH-05**: Las cookies de sesión son `HttpOnly`, `Secure`, `SameSite=Lax`, con expiración configurable y rotación de id al iniciar sesión.

### Servers

- [ ] **SERV-01**: El admin registra un servidor con nombre, host o IP, puerto SSH (default 22), usuario SSH (default root) y credencial de tipo clave privada (recomendada, ed25519 sugerida) o password (fallback).
- [ ] **SERV-02**: El admin edita nombre, host, puerto y usuario, y puede reemplazar la credencial; la credencial existente nunca se muestra ni se precarga.
- [ ] **SERV-03**: El admin elimina un servidor previa confirmación con su nombre; la credencial se borra en la misma transacción y se registra el evento.
- [ ] **SERV-04**: El admin ve la lista de servidores con nombre, host, status pill y last seen.
- [x] **SERV-05**: Cada servidor tiene un estado explícito PENDING, CONNECTING, CONNECTED, DISCONNECTED, UNREACHABLE o ERROR, con transiciones centralizadas y validadas en el dominio.
- [ ] **SERV-06**: El admin dispara "Connect" explícitamente; la conexión corre en el worker en segundo plano y el estado se refleja en la UI en tiempo real vía SSE sin recargar.
- [x] **SERV-07**: Un fallo de conexión produce un `error_code` específico (AUTH_FAILED, HOST_UNRESOLVED, CONNECT_TIMEOUT, COMMAND_TIMEOUT, HOST_KEY_CHANGED, CONNECTION_LOST, UNSUPPORTED_OS) con mensaje accionable; la API nunca cae.
- [x] **SERV-08**: Un usuario SSH no-root con sudo sin password es soportado; la validación comprueba `sudo -n` y pertenencia al grupo docker y reporta cada check.

### Security

- [x] **SEC-01**: Las credenciales SSH se cifran at-rest con AES-256-GCM, nonce único por operación y metadato de versión de clave por fila, listo para rotación.
- [ ] **SEC-02**: Ninguna credencial aparece en respuestas API, logs, mensajes de error, activity log ni telemetría; la redacción es por tipo (branded types) y un test con valores canary lo verifica en todas las salidas.
- [x] **SEC-03**: El host fingerprint se fija en la primera conexión exitosa (TOFU), se muestra al admin, y un cambio posterior falla con HOST_KEY_CHANGED hasta que el admin lo re-confirme explícitamente.
- [x] **SEC-04**: Los comandos SSH provienen de una allowlist de plantillas sin interpolar input del usuario; cada conexión y cada comando tienen timeout explícito.
- [ ] **SEC-05**: stdout/stderr de comandos remotos pasan por el redactor antes de persistirse o mostrarse.

### Discovery

- [ ] **DISC-01**: Tras CONNECTED, Noodara descubre hostname, distribución, versión de OS, arquitectura, núcleos de CPU, RAM total, disco total y usado, uptime, Docker instalado y su versión, usando salidas estructuradas y parsers testeados.
- [ ] **DISC-02**: El admin ve el progreso del discovery check por check (SSH → auth → OS → recursos → Docker → sudo/docker group) con pass/fail y detalle, no un spinner genérico.
- [ ] **DISC-03**: Cada discovery se guarda como snapshot append-only y el estado actual del servidor se denormaliza para la vista de detalle.
- [ ] **DISC-04**: Un OS no soportado se reporta como UNSUPPORTED_OS con aviso claro, sin bloquear el resto de la información recolectada.
- [ ] **DISC-05**: El admin puede volver a ejecutar el discovery bajo demanda desde el detalle del servidor.

### Server Detail

- [ ] **DETL-01**: El detalle del servidor muestra hostname, status, OS, CPU, RAM, disco, uptime, Docker, last seen y host fingerprint, conforme al design system.
- [ ] **DETL-02**: El detalle distingue los estados vacíos "aún no descubierto" y "discovery falló", cada uno con una sola acción.

### Activity Log

- [ ] **ACT-01**: Se registran eventos tipados para setup, login, logout, login fallido, servidor creado/editado/eliminado, intento de conexión y su resultado, discovery ejecutado.
- [ ] **ACT-02**: El admin ve el activity log como lista cronológica inversa con actor, entidad, acción y timestamp; los metadatos nunca contienen valores sensibles.

### Settings

- [ ] **SET-01**: Existe una pantalla de configuración global con información de la instancia (versión, URL pública) como contenedor mínimo para futuros ajustes.

### UI

- [ ] **UI-01**: La app tiene el shell del design system (sidebar, toolbar, contenido, inspector opcional) con dark y light mode y navegación por teclado.
- [ ] **UI-02**: Existen las pantallas de setup, login, lista de servidores, sheet de crear/editar servidor, detalle de servidor, activity log y settings, con estados vacío, carga y error.

### Quality

- [x] **QA-01**: Cada PR corre lint, typecheck, unit tests, integration ligera, gitleaks y `pnpm audit`; el merge se bloquea si algo falla.
- [x] **QA-02**: `packages/domain` mantiene ≥95% statement y ≥95% branch en validadores y state machines, verificado por umbral en CI.
- [x] **QA-03**: La suite de integración usa Testcontainers con sshd para Ubuntu 22.04 y 24.04 y cubre conexión exitosa, credenciales inválidas, host inválido, timeout de red, timeout de comando, pérdida de conexión, reconexión y ejecución segura de comandos, limpiando sus recursos.
- [ ] **QA-04**: El E2E de Playwright cubre login → Servers → add server → connect → discovery → detail; nightly lo repite 20 veces y ejecuta 100 conexiones consecutivas.
- [ ] **QA-05**: Un job de CI y nightly siembra secrets canary y verifica que no aparecen en ninguna salida.
- [x] **QA-06**: Las migraciones se prueban desde cero y desde el snapshot de la versión anterior.

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Projects & Services (v0.2)

- **PROJ-01**: Crear, editar, archivar y listar proyectos y environments.
- **PROJ-02**: Crear servicios desde Git, Dockerfile o imagen y desplegarlos en un servidor.
- **PROJ-03**: Operaciones Docker (pull, build, create, start, stop, restart, remove, inspect, logs).

### Deployment Engine (v0.3)

- **DEPL-01**: State machine de deployment con queue, webhooks, healthchecks, rollback y cancelación.

### Domains & Secrets (v0.4)

- **DOM-01**: Traefik, dominios, HTTPS automático, env vars con precedence y secrets referenciados.

### Observability & AI (v0.5)

- **OBS-01**: Métricas históricas, logs con stream y filtro, Infrastructure Graph, AI read-only BYOK con evals.

### Server extras

- **SRVX-01**: Auto-instalar Docker en el servidor cuando falta (hoy solo se detecta).
- **SRVX-02**: Soporte Debian y otras distribuciones.
- **SRVX-03**: Noodara Agent instalado en el servidor como adaptador alternativo a SSH.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Métricas históricas / series de tiempo en v0.1 | Es v0.5 Observability; v0.1 muestra snapshot puntual |
| Agent en el servidor | v0.1 opera por SSH; el agent es un adaptador futuro sobre la misma interfaz |
| Clustering / relaciones entre servidores | Sin proyectos ni servicios no hay nada que orquestar |
| Rol build server vs deploy server | Sin deployment engine (v0.3) el rol no significa nada |
| Multiusuario, roles, equipos, SSO | Un admin local basta para indie devs; roadmap lo pospone a después de v0.5 |
| Búsqueda, filtros y export del activity log | Lista tipada mínima; no reemplazar Datadog/Loki |
| Integraciones con proveedores cloud para crear servidores | Ni Coolify ni Dokploy lo tienen en su flujo base; sin mandato en el roadmap |
| Kubernetes, Terraform, CI/CD genérico, DB HA, billing, multi-tenancy | Fuera hasta después de v0.5 por roadmap |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INST-06 | Phase 1 | Complete |
| AUTH-01 | Phase 1 | Complete |
| AUTH-02 | Phase 1 | Complete |
| AUTH-03 | Phase 1 | Complete |
| AUTH-04 | Phase 1 | Complete |
| AUTH-05 | Phase 1 | Complete |
| SERV-05 | Phase 1 | Complete |
| SEC-01 | Phase 1 | Complete |
| QA-01 | Phase 1 | Complete |
| QA-02 | Phase 1 | Complete |
| QA-06 | Phase 1 | Complete |
| SERV-07 | Phase 2 | Complete |
| SERV-08 | Phase 2 | Complete |
| SEC-03 | Phase 2 | Complete |
| SEC-04 | Phase 2 | Complete |
| SEC-05 | Phase 2 | Pending |
| DISC-01 | Phase 2 | Pending |
| DISC-04 | Phase 2 | Pending |
| QA-03 | Phase 2 | Complete |
| SERV-01 | Phase 3 | Pending |
| SERV-02 | Phase 3 | Pending |
| SERV-03 | Phase 3 | Pending |
| SEC-02 | Phase 3 | Pending |
| DISC-03 | Phase 3 | Pending |
| ACT-01 | Phase 3 | Pending |
| SERV-06 | Phase 4 | Pending |
| DISC-05 | Phase 4 | Pending |
| SERV-04 | Phase 5 | Pending |
| DETL-01 | Phase 5 | Pending |
| DETL-02 | Phase 5 | Pending |
| ACT-02 | Phase 5 | Pending |
| SET-01 | Phase 5 | Pending |
| UI-01 | Phase 5 | Pending |
| UI-02 | Phase 5 | Pending |
| DISC-02 | Phase 5 | Pending |
| QA-04 | Phase 5 | Pending |
| QA-05 | Phase 5 | Pending |
| INST-01 | Phase 6 | Pending |
| INST-02 | Phase 6 | Pending |
| INST-03 | Phase 6 | Pending |
| INST-04 | Phase 6 | Pending |
| INST-05 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 42 total (corregido: el conteo original de 40 en este archivo estaba desactualizado; hay 42 IDs únicos listados arriba)
- Mapped to phases: 42
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-10*
*Last updated: 2026-09-10 after roadmap creation (traceability mapped, coverage corrected from 40 to 42)*
