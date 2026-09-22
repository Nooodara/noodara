# Phase 2: Adaptador SSH aislado y probado con Testcontainers - Context

**Gathered:** 2026-09-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Esta fase entrega `packages/ssh`: el adaptador que conecta por SSH a un servidor Ubuntu real desde el control plane (sin agent), verifica el host fingerprint con TOFU, ejecuta únicamente comandos de una allowlist de plantillas fijas con timeouts explícitos e independientes, clasifica cada fallo con uno de los siete `error_code` ya definidos en `packages/domain`, y expone `runDiscovery` que recolecta hostname, distribución, versión de OS, arquitectura, CPU, RAM, disco, uptime, Docker y su versión (más la versión del plugin `docker compose`) sobre una sola conexión reutilizada, con los checks de sudo y grupo docker para usuarios no-root. Todo probado contra contenedores `sshd` reales de Ubuntu 22.04 y 24.04 con Testcontainers, cubriendo los ocho escenarios del roadmap §6.5, y con stdout/stderr pasando por el Redactor antes de persistirse o mostrarse.

Requisitos cubiertos: SERV-07, SERV-08, SEC-03, SEC-04, SEC-05, DISC-01, DISC-04, QA-03.

Fuera de esta fase: registrar/editar/eliminar servidores y persistir snapshots de discovery (fase 3), rutas HTTP, worker BullMQ y SSE (fase 4), UI (fase 5), instalador (fase 6). El adaptador recibe una credencial ya descifrada como `SecretValue` y devuelve resultados puros; no lee ni escribe la base de datos. La única excepción de persistencia es la migración que añade las columnas de fecha de captura de fingerprint (D-06), porque las necesita el contrato de resultado.

</domain>

<decisions>
## Implementation Decisions

### Credenciales SSH
- **D-01:** Se aceptan claves privadas en formato OpenSSH y PEM, de tipo ed25519, ECDSA y RSA (RSA mínimo 2048 bits). La UI recomendará ed25519 (fase 5); el adaptador valida formato y tipo y devuelve un error de validación claro antes de intentar conectar.
- **D-02:** Se aceptan claves privadas cifradas con passphrase. La passphrase es un campo adicional de la credencial, cifrado en el mismo envelope AES-256-GCM que la clave, y se entrega al adaptador como `SecretValue`. Una passphrase incorrecta se clasifica como `AUTH_FAILED` con mensaje que lo indique sin revelar nada más.
- **D-03:** Para credenciales de tipo password se intentan los métodos `password` y `keyboard-interactive` con la misma password, respondiendo solo a prompts de password y sin prompts adicionales; cualquier otro prompt aborta con `AUTH_FAILED`.

### Host fingerprint (TOFU)
- **D-04:** El fingerprint se calcula y almacena como `SHA256:<base64 sin padding>` sobre la clave pública del host, igual que `ssh-keygen -lf`, para que el admin pueda compararlo en su terminal.
- **D-05:** Se aceptan host keys ed25519, ECDSA y RSA, negociando ed25519 primero. Se guarda el tipo junto al fingerprint (formato `ssh-ed25519 SHA256:...`); un cambio de tipo de clave cuenta como cambio de host key y produce `HOST_KEY_CHANGED`.
- **D-06:** Ante `HOST_KEY_CHANGED` se conservan ambos fingerprints con su fecha: `host_fingerprint` + `host_fingerprint_captured_at` (el confiado) y `pending_fingerprint` + `pending_fingerprint_seen_at` (el observado). Esta fase añade las dos columnas de fecha por migración. El mensaje de error incluye los dos fingerprints con tipo para que el admin verifique antes de "Trust new fingerprint" (endpoint fase 4, UI fase 5).
- **D-07:** Nunca se auto-acepta un host key distinto del fijado; el adaptador no tiene modo "insecure". En la primera conexión exitosa (sin fingerprint previo) se captura y se devuelve en el resultado para que la capa de aplicación (fase 3) lo persista.

### Timeouts y reintentos
- **D-08:** Timeouts por defecto: conexión 10 s, cada comando 30 s, discovery total 60 s. Son independientes: superar el primero produce `CONNECT_TIMEOUT`, el segundo `COMMAND_TIMEOUT`, y el tercero aborta el discovery devolviendo lo ya recolectado más `COMMAND_TIMEOUT` en el check que estaba en curso.
- **D-09:** Configurables solo por variables de entorno globales validadas en `env.ts` con rangos razonables: `NOODARA_SSH_CONNECT_TIMEOUT_MS`, `NOODARA_SSH_COMMAND_TIMEOUT_MS`, `NOODARA_SSH_DISCOVERY_TIMEOUT_MS`. Sin ajuste por servidor en v0.1. El adaptador recibe los valores por parámetro; no lee `process.env`.
- **D-10:** Un único reintento automático tras 2 s de espera, solo para `CONNECT_TIMEOUT` y `CONNECTION_LOST`. `AUTH_FAILED`, `HOST_KEY_CHANGED`, `HOST_UNRESOLVED` y `COMMAND_TIMEOUT` nunca se reintentan. El resultado registra `attempts` (1 o 2) para el activity log.

### Discovery ante fallos parciales
- **D-11:** Un servidor con OS distinto de Ubuntu 22.04/24.04 que conecta correctamente queda en `CONNECTED` con la advertencia `UNSUPPORTED_OS` y el discovery se completa igual. Esto cambia el mapeo de la fase 1, donde `statusForErrorCode('UNSUPPORTED_OS')` devolvía `ERROR`: la fase 2 actualiza la tabla en `packages/domain/src/server/connection-result.ts` (`UNSUPPORTED_OS → CONNECTED`), sus tests y el espejo `docs/domain/server-state-transitions.md`. `UNSUPPORTED_OS` pasa a ser un código de advertencia: se guarda en `last_error_code` para que el detalle lo muestre, pero no impide el estado CONNECTED. En v0.2 el deploy se bloqueará sobre servidores con esta advertencia.
- **D-12:** Docker ausente es una advertencia, no un fallo: `docker_installed = false`, versión nula, estado `CONNECTED`. La detección usa `docker version --format '{{json .}}'` (nunca parsing de texto libre) y, si existe, la versión del plugin `docker compose version --short`. Instalar Docker queda fuera de v0.1.
- **D-13:** Los checks de sudo y grupo docker (SERV-08) se ejecutan solo para usuarios no-root; para root se reportan como `not_applicable`. Para no-root: `sudo -n true` (pass/fail) y pertenencia a `docker` vía `id -nG` (pass/fail). Un check fallido es advertencia con detalle, no `ERROR`, en v0.1. Cada check del discovery se reporta por separado con `status: pass | fail | skipped | not_applicable`, `detail` y duración, alimentando la narrativa paso a paso de la fase 5 (DISC-02).

### Claude's Discretion
- Estructura de `packages/ssh`: cliente sobre `ssh2` (versión fijada en STACK.md) con interfaz `SshPort` (research ARCHITECTURE) para que un agent futuro sea un adaptador alternativo; `connect`, `exec(template, args)`, `close`; sin pool ni conexiones persistentes en v0.1 (D-13 de fase 1).
- Allowlist de comandos: plantillas fijas en `packages/ssh/src/commands/*.ts` (`discovery.hostname`, `discovery.os_release`, `discovery.cpu`, `discovery.memory`, `discovery.disk`, `discovery.uptime`, `docker.version`, `docker.compose_version`, `access.sudo`, `access.docker_group`). Ningún argumento de usuario se interpola en un shell; si una plantilla necesita parámetros, se validan contra un patrón estricto y se escapan con una función testeada. Un test afirma que el conjunto de plantillas es exactamente la lista y que ninguna contiene `${`.
- Parsers de salida en `packages/domain` (puros, testeados con fixtures reales de 22.04 y 24.04): `/etc/os-release`, `nproc`, `/proc/meminfo`, `df -P` del root, `/proc/uptime`, JSON de `docker version`.
- Clasificación de errores de `ssh2` a `ServerErrorCode`: tabla explícita en `packages/ssh` (ENOTFOUND/EAI_AGAIN → `HOST_UNRESOLVED`, ETIMEDOUT/timeout de handshake → `CONNECT_TIMEOUT`, `All configured authentication methods failed` → `AUTH_FAILED`, host key mismatch → `HOST_KEY_CHANGED`, ECONNRESET/socket cerrado durante exec → `CONNECTION_LOST`, exec sin respuesta → `COMMAND_TIMEOUT`). Cualquier error no clasificado se mapea a `CONNECTION_LOST` con el mensaje original redactado; nunca se propaga una excepción no controlada (SERV-07).
- Concurrencia: límite de una conexión activa por servidor dentro del adaptador (mutex en memoria); el límite global vive en el worker (fase 4).
- Redacción: el adaptador devuelve stdout/stderr ya pasados por el Redactor con la credencial registrada; además trunca salidas a 64 KB por comando.
- Imágenes de test: Dockerfiles propios en `tests/integration/images/sshd-ubuntu-22.04/` y `sshd-ubuntu-24.04/` con `openssh-server`, un usuario root con clave, un usuario no-root con sudo NOPASSWD y otro sin sudo, y `docker` CLI instalado en una variante para el check de versión; construidas por Testcontainers desde el Dockerfile con etiqueta `noodara.test=true`. Escenarios de red: `HOST_UNRESOLVED` con un nombre inexistente, `CONNECT_TIMEOUT` con una IP no ruteable (`10.255.255.1`) y timeout corto, `CONNECTION_LOST` matando el contenedor durante un comando largo, `COMMAND_TIMEOUT` con `sleep` mayor que el timeout, `HOST_KEY_CHANGED` regenerando las host keys del contenedor entre conexiones, reconexión conectando de nuevo tras un fallo transitorio.
- Keepalive: `keepaliveInterval` 10 s durante el discovery para detectar pérdida de conexión antes del timeout de comando.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y criterios de aceptación
- `docs/roadmap-v0.1-v0.5.md` §6.1 Discovery, §6.3 Seguridad, §6.5 Integration tests, §6.7 Criterios.
- `.planning/ROADMAP.md` — Phase 2 goal y success criteria 1–5.
- `.planning/REQUIREMENTS.md` — SERV-07, SERV-08, SEC-03, SEC-04, SEC-05, DISC-01, DISC-04, QA-03.

### Decisiones previas que gobiernan esta fase
- `.planning/phases/01-dominio-persistencia-y-autenticaci-n/01-CONTEXT.md` — D-13 (sin conexiones persistentes), D-14/D-15 (fingerprint, `pending_fingerprint`, Trust), D-16 (tabla de transiciones como fuente de verdad).
- `docs/domain/server-state-transitions.md` — tabla de transiciones y mapeo error_code → estado (se actualiza por D-11).
- `packages/domain/src/server/connection-result.ts` y `server-state.ts` — `ServerErrorCode`, `ConnectionResult`, `applyConnectionResult`, `statusForErrorCode`.
- `apps/control-plane/src/db/schema/servers.ts` — columnas de fingerprint y discovery ya existentes; esta fase añade solo las dos fechas de D-06.

### Reglas de ingeniería (skills de proyecto)
- `.claude/skills/noodara-security/SKILL.md` §3 Redactor, §4 SSH (timeouts, TOFU, allowlist, sanitización).
- `.claude/skills/noodara-domain-model/SKILL.md` §2 Server.
- `.claude/skills/noodara-tdd/SKILL.md` §5 Integration tests con Testcontainers (limpieza, imágenes propias, sin sleep arbitrario).
- `CLAUDE.md` §2, §3.

### Research y arquitectura
- `.planning/research/STACK.md` — `ssh2` 1.17 (hostVerifier/hostHash, timeouts, keepalive).
- `.planning/research/ARCHITECTURE.md` — `SshPort` como interfaz, connect-per-job, límites de concurrencia, redacción.
- `.planning/research/PITFALLS.md` — pitfalls 4 (TOFU), 6 (detección frágil de Docker), 7 (sudo/TTY en exec no interactivo), 8 (flapping por rate limit de UFW), 9 (inyección por identificadores).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/domain/src/server/connection-result.ts`: `ServerErrorCode` (7 códigos), `ConnectionResult`, `applyConnectionResult`, `statusForErrorCode` — el adaptador produce `ConnectionResult`, no estados.
- `packages/domain/src/security/secret-value.ts` y `redactor.ts`: `SecretValue`/`revealSecret` para la clave, passphrase o password; `createRedactor()` para stdout/stderr.
- `packages/domain/src/validators/network.ts`: `validateHost`, `validateSshPort`; `identity.ts`: `validateSshUser`.
- `tests/integration/helpers/postgres.ts`, `app.ts`, `boot-process.ts`: patrón de Testcontainers con etiqueta `noodara.test=true`, limpieza en `afterAll`, esperas acotadas sin GNU `timeout`.
- `apps/control-plane/src/env.ts`: patrón de validación de env con rangos (`parseTuningInt`) para las tres variables de timeout.

### Established Patterns
- `packages/domain` es puro (test de pureza); los parsers de salida de comandos van ahí, la I/O SSH va en `packages/ssh`.
- Turborepo boundaries: `packages/ssh` puede depender de `@noodara/domain` y `@noodara/config`; `packages/domain` no puede depender de `packages/ssh`. Los paquetes se compilan a `dist` con `exports` a `dist` y alias a `src` en Vitest (ADR 0003): `packages/ssh` sigue el mismo contrato.
- TDD con commits RED/GREEN; tablas `satisfies` congeladas; helper `assertDefined` reutilizable.

### Integration Points
- Fase 3 consumirá `SshPort.connect/exec/close` y `runDiscovery` desde servicios de aplicación; fase 4 lo invocará desde el worker BullMQ.
- `last_error_code` en `servers` recibe `UNSUPPORTED_OS` como advertencia (D-11) sin cambiar el estado.
- Las dos columnas nuevas (`host_fingerprint_captured_at`, `pending_fingerprint_seen_at`) requieren migración `0002` y actualización de los tests de migración desde snapshot.

</code_context>

<specifics>
## Specific Ideas

- El fingerprint debe verse exactamente como en `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` para que el admin lo compare sin traducir formatos.
- Dokploy muestra un checklist de validación por servidor con pass/fail y detalle; los checks de discovery deben producir esa estructura para que la fase 5 la pinte sin transformar.

</specifics>

<deferred>
## Deferred Ideas

- Ajuste de timeouts por servidor — después de v0.1 si aparece la necesidad.
- Instalar Docker automáticamente cuando falta — v2 (`SRVX-01`).
- Pool de conexiones SSH y agent instalado — cuando exista polling continuo (v0.5) o se decida el agent.
- Bloquear deploy sobre servidores con `UNSUPPORTED_OS` — fase de v0.2.
- Simulación de red con toxiproxy — solo si los escenarios con IP no ruteable y kill de contenedor resultan inestables.

</deferred>

---

*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Context gathered: 2026-09-12*
