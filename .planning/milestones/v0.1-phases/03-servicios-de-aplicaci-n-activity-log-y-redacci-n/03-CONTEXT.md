# Phase 3: Servicios de aplicación, activity log y redacción - Context

**Gathered:** 2026-09-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Esta fase entrega los servicios de aplicación de `apps/control-plane/src/services/` que son el único punto de entrada para mutar servidores y dejar constancia de cada operación: registrar, editar y eliminar servidores con su credencial cifrada (SERV-01, SERV-02, SERV-03), un servicio `connectAndDiscover` que orquesta `SshPort.connect` + `runDiscovery` sobre una sola sesión, aplica la state machine de Server, persiste el fingerprint TOFU, escribe un `DiscoverySnapshot` append-only y denormaliza `servers` (DISC-03), un servicio `trustFingerprint` (D-15 de fase 1), la ampliación del activity log a eventos `server.*` tipados escritos solo desde servicios (ACT-01), y la prueba con canary de que ningún secret sale por logs, resultados de servicio, errores, `activity_events` ni `discovery_snapshots` (SEC-02). Incluye la migración `0003` (tabla `discovery_snapshots`, columna `docker_compose_version`, índices únicos de nombre y host+puerto).

Requisitos cubiertos: SERV-01, SERV-02, SERV-03, SEC-02, DISC-03, ACT-01.

Fuera de esta fase: rutas HTTP, worker BullMQ, SSE y el endpoint de trust (fase 4); toda la UI, incluida la confirmación visual de borrado y la narrativa de discovery (fase 5); instalador (fase 6). Los servicios reciben un actor y parámetros ya parseados; no leen `request`, no encolan jobs y no emiten SSE. `packages/ssh` y `packages/domain` no cambian de contrato en esta fase salvo la ampliación del union de acciones de `ActivityEvent` y las funciones puras que la denormalización necesite.

</domain>

<decisions>
## Implementation Decisions

### Connect y discovery como servicios
- **D-01:** Un solo servicio `connectAndDiscover({ serverId, actor })` sobre una única sesión SSH: descifra la credencial a `SecretValue`, transiciona a `CONNECTING`, llama a `SshPort.connect`, aplica el resultado con `applyConnectionResult` (`CONNECTING → CONNECTED | UNREACHABLE | ERROR`), persiste el fingerprint capturado en el primer connect con `host_fingerprint_captured_at` (D-06/D-07 de fase 2) o aparca el observado en `pending_fingerprint` + `pending_fingerprint_seen_at` ante `HOST_KEY_CHANGED`, y si conectó ejecuta `runDiscovery` en la misma sesión, escribe el snapshot, denormaliza `servers` y cierra la sesión. Emite dos eventos (conexión y discovery). Es el servicio que el job `connect-server` de fase 4 invoca y el que DISC-05 (re-run) reutiliza; no existe un connect sin discovery ni un discovery sin connect en v0.1.
- **D-02:** Si la conexión tuvo éxito pero el discovery falla a mitad, el estado lo fija el fallo del discovery con una segunda transición vía `transition()`: `CONNECTED → ERROR` para `COMMAND_TIMEOUT`, `CONNECTED → UNREACHABLE` para `CONNECTION_LOST` (ambas edges existen en la tabla), con `last_error_code` correspondiente. Los facts parciales recolectados se guardan igual en el snapshot (D-06). Un discovery que solo produce advertencias (`UNSUPPORTED_OS`, Docker ausente) mantiene `CONNECTED` con `last_error_code = UNSUPPORTED_OS` cuando aplique (D-11/D-12 de fase 2).
- **D-03:** Tras un run exitoso el servidor **queda `CONNECTED`**; cerrar la sesión SSH no cambia el estado. `CONNECTED` significa "la última operación tuvo éxito". La edge `CONNECTED → DISCONNECTED` (`clean_close`) se reserva para D-14 de fase 1 (editar usuario SSH o credencial) y para futuros cierres de sistema; `connectAndDiscover` nunca la usa. Esta fase actualiza `docs/domain/server-state-transitions.md` (y la tabla de la skill `noodara-domain-model` §2.1) para dejarlo explícito.
- **D-04:** El servicio `trustFingerprint({ serverId, actor })` entra en esta fase (sin endpoint): copia `pending_fingerprint` a `host_fingerprint`, sella `host_fingerprint_captured_at`, limpia `pending_fingerprint`/`pending_fingerprint_seen_at`, transiciona `ERROR → PENDING` con reason `fingerprint_trusted`, y escribe `server.fingerprint_trusted`. Fase 4 solo expone la ruta.
- **D-05:** Si `connectAndDiscover` se invoca con el servidor ya en `CONNECTING` (doble disparo, dos jobs), devuelve el resultado de conflicto `ALREADY_CONNECTING` sin abrir SSH ni escribir evento. La transición a `CONNECTING` se hace dentro de una transacción con lock de fila (`SELECT ... FOR UPDATE`) para que dos invocaciones concurrentes no pasen ambas. Fase 4 lo mapea a 409.

### Snapshot de discovery y denormalización
- **D-06:** Tabla `discovery_snapshots` append-only: `id` (UUIDv7), `server_id` (FK a `servers` con `ON DELETE CASCADE`), `collected_at`, `outcome` (`ok | partial | failed`), `error_code` (enum `server_error_code`, nullable), `payload jsonb` con el `DiscoverySnapshot` de `runDiscovery` tal cual (`facts`, `checks`, `warnings`), `created_at`. Los datos denormalizados viven solo en `servers`; el payload no se normaliza en columnas. Índice `(server_id, collected_at desc)`.
- **D-07:** Todo run que llegó a ejecutar al menos un comando escribe su snapshot, también con checks fallidos, timeout parcial o pérdida de conexión (`outcome = partial | failed`). En `servers` se actualizan solo los facts que llegaron con valor: un fact `null` nunca sobrescribe el valor previo. `last_seen_at` se actualiza al conectar con éxito. Snapshot, denormalización, transición de estado y evento de discovery se escriben en la misma transacción.
- **D-08:** Retención ilimitada de snapshots en v0.1 (el discovery es manual; v0.5 decidirá la política cuando exista polling). Al eliminar el servidor se borran en cascada.
- **D-09:** Se añade la columna nullable `docker_compose_version` a `servers` en la misma migración que crea `discovery_snapshots`, para que `DiscoveryFacts.dockerComposeVersion` se denormalice como el resto y la vista de detalle (fase 5) y v0.2 no tengan que leer el snapshot.

### Reglas de registro, edición y eliminación
- **D-10:** Unicidad exigida por índices únicos: `lower(name)` y `(host, ssh_port)`. El servicio devuelve `NAME_TAKEN` / `HOST_TAKEN` (comprobación previa dentro de la transacción y captura de la violación de unicidad como red de seguridad). Un mismo host con dos usuarios SSH no se permite en v0.1.
- **D-11:** Editar o eliminar un servidor en `CONNECTING` se rechaza con `SERVER_BUSY` (fase 4 → 409), para que el job en vuelo nunca escriba estado o fingerprint sobre una fila cambiada o borrada.
- **D-12:** La confirmación por nombre de SERV-03 se aplica en el servicio: `deleteServer({ serverId, confirmName, actor })` compara `confirmName` con el nombre actual (igualdad exacta, case-sensitive) y devuelve `CONFIRMATION_MISMATCH` si no coincide. La UI de fase 5 solo recoge el texto.
- **D-13:** Reemplazar la credencial en `editServer` actualiza la fila de `credentials` en sitio (mismo `credential_id`; nuevos `type`, `encrypted_value`, `key_version`, `updated_at`) en la misma transacción que el `UPDATE` de `servers`. Un servidor tiene siempre exactamente una credencial; cambiar de clave a password solo cambia `type`. La credencial existente nunca se lee ni se devuelve al editar (SERV-02); el input de edición trae la credencial nueva completa o nada.
- **D-14:** Al eliminar: `servers` y su fila de `credentials` se borran en la misma transacción, `discovery_snapshots` cae en cascada, y `activity_events` sobreviven con `entity_id` del servidor borrado (no hay FK, es un audit trail). Se escribe `server.deleted` antes de borrar la fila, dentro de la transacción.
- **D-15:** Una credencial de clave privada con passphrase se guarda dentro del mismo envelope AES-256-GCM como JSON `{ "privateKey": "...", "passphrase": "..." }` (D-02 de fase 2); sin passphrase, la propiedad se omite. El descifrado produce `SshCredential` con `SecretValue` para cada campo; el servicio valida formato y tipo de clave con las reglas de `packages/ssh` (D-01 de fase 2) antes de cifrar y persistir, devolviendo un error de validación claro.

### Taxonomía de eventos y canary
- **D-16:** `packages/domain` amplía el union de acciones con seis acciones `server.*`, cada una con metadata mínima y tipada:
  - `server.created` — `{ name, host, sshPort, sshUser, credentialType }`
  - `server.updated` — `{ changedFields: string[], credentialReplaced: boolean }` (nunca valores nuevos ni viejos de host, puerto, usuario o nombre)
  - `server.deleted` — `{ name, host }`
  - `server.connection_attempted` — `outcome success | failure`, `errorCode` cuando falla, `{ attempts, durationMs, fingerprintCaptured }`
  - `server.discovery_completed` — `outcome success | failure`, `errorCode` cuando falla, `{ snapshotId, warnings, checksFailed: string[] }`
  - `server.fingerprint_trusted` — `{ previousFingerprint, newFingerprint }`
  Los fingerprints son públicos y sí van en metadata. `entity_type = 'server'`, `entity_id = serverId` en todas.
- **D-17:** El actor de `server.connection_attempted` y `server.discovery_completed` es el admin que disparó la operación: todos los servicios reciben `actor: { type: 'user', id } | { type: 'system' }` como parámetro y el worker de fase 4 lo propaga desde el payload del job. Un disparo automático futuro pasará `system`.
- **D-18:** El canary de SEC-02 es un test de integración de flujo completo contra el contenedor sshd de fase 2: registra un servidor con password y con clave privada canary (valores generados por run), ejecuta `connectAndDiscover`, edita reemplazando la credencial, ejecuta `trustFingerprint` cuando aplique y elimina; después vuelca los logs pino capturados, el JSON de cada resultado de servicio, `activity_events.metadata`, `discovery_snapshots.payload` y un error simulado del servicio, y afirma que ninguna salida contiene los canaries ni `BEGIN OPENSSH PRIVATE KEY`. Además se añade el script `pnpm security:scan-leaks` (skill `noodara-security` §9) que ejecuta esta suite en CI y queda listo para el nightly de QA-05.
- **D-19:** `registerServer`, `editServer`, `trustFingerprint` y `connectAndDiscover` devuelven una vista pública `ServerView`: todos los campos de `servers` (id, name, host, sshPort, sshUser, status, hostFingerprint, pendingFingerprint y sus fechas, facts denormalizados incluido dockerComposeVersion, lastSeenAt, lastErrorCode, createdAt, updatedAt) más `credentialType` (`'ssh_private_key' | 'ssh_password'`), sin `credentialId` ni envelope. Un test unitario afirma por lista de claves que ningún campo de credencial existe en `ServerView`. Es el shape que la ruta `GET` de fase 4 devuelve sin transformar.

### Claude's Discretion
- **Contrato de errores de los servicios:** fallos esperados (validación, `NOT_FOUND`, `NAME_TAKEN`, `HOST_TAKEN`, `SERVER_BUSY`, `ALREADY_CONNECTING`, `CONFIRMATION_MISMATCH`, `NO_PENDING_FINGERPRINT`) como resultado `{ ok: false, code, message }` siguiendo el patrón de `setup-service.ts`; excepciones solo para bugs e infraestructura. `connectAndDiscover` nunca lanza por fallos SSH (SERV-07): un fallo de conexión es `{ ok: true, server: ServerView, connection: ..., discovery?: ... }` con el estado ya aplicado.
- **Inyección de dependencias:** los servicios reciben `SshPort`, timeouts (`NOODARA_SSH_*` de `env.ts`), reloj y handle de DB por parámetro o factoría (`createServerServices({ db, ssh, timeouts, now })`), sin contenedor DI. Los tests unitarios usan un `SshPort` falso; los de integración usan `createSsh2Adapter` contra Testcontainers.
- **Cifrado/descifrado de credenciales:** helper único en `apps/control-plane/src/services/credential-store.ts` (o nombre equivalente) sobre `packages/domain/src/security/envelope.ts`, el único sitio que convierte entre el envelope y `SshCredential`; la credencial descifrada vive solo como `SecretValue` registrada en `appRedactor` durante la operación y se libera al terminar (como hace el adaptador de fase 2).
- **Función pura de denormalización:** `mergeDiscoveryFacts(current, facts)` en `packages/domain` (facts no nulos sobrescriben, nulos conservan), testeada exhaustivamente; la clasificación `ok | partial | failed` del snapshot también como función pura sobre `checks`.
- **Entidad `Server` en dominio:** validadores existentes (`validateHost`, `validateSshPort`, `validateSshUser`) más un `validateServerName` (longitud y caracteres razonables); reglas de qué campos cambian identidad (D-14 fase 1) como función pura `classifyServerEdit(before, after)` que devuelve `none | identity | access`.
- **Migración `0003`:** una sola migración para `discovery_snapshots`, `servers.docker_compose_version` y los dos índices únicos; tests de migración desde cero y desde el snapshot `0002` (QA-06); `representative-data.ts` se amplía con filas de la nueva tabla.
- **Enforcement de "solo servicios escriben eventos":** mantener `writeActivityEvent` como único insert y añadir un test de boundary que afirma que ningún archivo fuera de `src/services/` y `src/activity/` importa `writeActivityEvent` ni `activityEvents`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y criterios de aceptación
- `.planning/ROADMAP.md` — Phase 3 goal y success criteria 1–5.
- `.planning/REQUIREMENTS.md` — SERV-01, SERV-02, SERV-03, SEC-02, DISC-03, ACT-01 (y ACT-02, DISC-02, DISC-05, DETL-01 como consumidores en fases 4–5).
- `docs/roadmap-v0.1-v0.5.md` §6.2 Servers/Discovery, §6.3 Seguridad, §6.4 Tests unitarios, §6.7 Criterios.

### Decisiones previas que gobiernan esta fase
- `.planning/phases/01-dominio-persistencia-y-autenticaci-n/01-CONTEXT.md` — D-09/D-10 (master key, formato de envelope y `key_version`), D-13/D-14/D-15 (semántica de estados, edición, trust), D-16 (tabla de transiciones como fuente de verdad).
- `.planning/phases/02-adaptador-ssh-aislado-y-probado-con-testcontainers/02-CONTEXT.md` — D-01/D-02/D-03 (tipos de credencial y passphrase), D-06/D-07 (persistencia de fingerprints y fechas), D-08/D-09 (timeouts por env), D-10 (`attempts`), D-11/D-12/D-13 (advertencias y checks).
- `docs/domain/server-state-transitions.md` — tabla de transiciones, edges con reason y mapeo error_code → estado (se actualiza por D-03 de esta fase).
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` — contrato tsc/tsx/node que los nuevos módulos deben respetar.
- `docs/adr/0004-ssh-adapter-empirical-contracts.md` — comportamiento medido del adaptador que `connectAndDiscover` orquesta.

### Contratos de código existentes
- `packages/ssh/src/ssh-port.ts` y `packages/ssh/src/index.ts` — `SshPort`, `ConnectInput`, `ConnectOutcome`, `SshCredential`, `HostFingerprint`, `runDiscovery`, `formatFingerprint`/`parseFingerprint`: la única superficie que los servicios pueden usar.
- `packages/domain/src/server/server-state.ts` y `connection-result.ts` — `transition`, `applyConnectionResult`, `statusForErrorCode`.
- `packages/domain/src/discovery/types.ts` — `DiscoverySnapshot`, `DiscoveryFacts`, `DiscoveryCheck`.
- `packages/domain/src/activity/activity-event.ts` — union de acciones a ampliar y guard `SensitiveMetadataError`.
- `packages/domain/src/security/envelope.ts`, `secret-value.ts`, `redactor.ts` — cifrado, `SecretValue`, `Redactor`.
- `apps/control-plane/src/activity/write-activity-event.ts` y `redaction.ts` — único insert en `activity_events`, `appRedactor`, `toLogSafe`.
- `apps/control-plane/src/db/schema/servers.ts`, `credentials.ts`, `activity-events.ts` — esquema actual; esta fase añade `discovery_snapshots` y `docker_compose_version`.
- `apps/control-plane/src/services/setup-service.ts` y `session-service.ts` — patrón de servicio transaccional con `writeActivityEvent` a seguir.

### Reglas de ingeniería (skills de proyecto)
- `.claude/skills/noodara-security/SKILL.md` §1–§3 (branded types, cifrado, Redactor), §8 logging, §9 scan de fuga, §10 checklist.
- `.claude/skills/noodara-domain-model/SKILL.md` §2 Server, §7 ActivityEvent, §9 migraciones, §10 checklist.
- `.claude/skills/noodara-tdd/SKILL.md` — RED/GREEN/REFACTOR, Testcontainers, coverage.
- `CLAUDE.md` §2, §3, §4.

### Research y arquitectura
- `.planning/research/ARCHITECTURE.md` §3 (servicios como único punto de entrada), §5 (snapshot vs estado actual), §6 (activity log), §9 (decisiones a fijar en v0.1).
- `.planning/research/PITFALLS.md` — pitfalls sobre secrets en logs y estados falsos.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `writeActivityEvent(handle, input, now)` compone en una transacción Drizzle (`tx`) y ya redacta metadata con `appRedactor`; los servicios solo tienen que llamarlo dentro de `db.transaction`.
- `appRedactor` (registra master key y auth secret al cargar) y `toLogSafe` (allowlist de `credentials` a `{ id, type, keyVersion }`) para todo log de servidor o credencial.
- `packages/domain/src/security/envelope.ts` (`encrypt`/`decrypt` con `key_version`) y `SecretValue`/`revealSecret` para el helper de credenciales.
- `SshPort.connect` + `runDiscovery(session, ...)` de `@noodara/ssh`; `createSsh2Adapter` para integración; `formatFingerprint`/`parseFingerprint` para el formato `"<keyType> SHA256:..."` que se persiste en `host_fingerprint`.
- `applyConnectionResult` (solo desde `CONNECTING`) y `transition` con reasons `identity_changed`, `fingerprint_trusted`, `clean_close`.
- Validadores `validateHost`, `validateSshPort`, `validateSshUser`, patrón `ValidationResult<T>`.
- `tests/integration/helpers/ssh.ts` (`startSshd` con fixtures root/deployer, passphrase inyectada, variante con Docker CLI) y `helpers/app.ts`/`postgres.ts` para el canary de flujo completo; `tests/integration/activity/canary.test.ts` como patrón de captura de logs y error handler.
- `tests/integration/helpers/migrations.ts` (`applyMigrationsUpTo`) y `fixtures/representative-data.ts` para los tests de la migración `0003`.

### Established Patterns
- Servicios como funciones exportadas que abren `db.transaction` y devuelven `{ ok: true, ... } | { ok: false, code, message }` (`setup-service.ts`); errores tipados solo para auth/no-encontrado (`session-service.ts`). Esta fase unifica hacia resultados para fallos esperados.
- `packages/domain` puro (test de pureza, `now: Date` por parámetro); toda regla nueva (merge de facts, clasificación de edición, validación de nombre) va allí con ≥95% de cobertura.
- Turborepo boundaries: `apps/control-plane` puede importar `@noodara/domain` y `@noodara/ssh`; nada más importa `packages/ssh` internals.
- Migraciones Drizzle numeradas (`0000`–`0002`) con tests desde cero y desde snapshot; enums de Postgres derivados de constantes del dominio.
- Env vars validadas en `env.ts` con `parseTuningInt`; los timeouts SSH ya existen (`NOODARA_SSH_*`) y se pasan por parámetro.
- Commits Conventional en inglés, ciclo RED/GREEN por tarea.

### Integration Points
- Fase 4: rutas `POST/PATCH/DELETE /servers`, `POST /servers/:id/connect` (encola job que llama a `connectAndDiscover`), `POST /servers/:id/trust-fingerprint`, `GET /servers/:id` devolviendo `ServerView`; el worker propaga `actor` desde el job.
- Fase 5: detalle lee los campos denormalizados de `servers` y el último `discovery_snapshots.payload.checks` para DISC-02; activity log lista `activity_events` (ACT-02).
- `activity_events.action` es `text`, así que ampliar el union no requiere migración; `discovery_snapshots.error_code` reutiliza el enum `server_error_code`.
- `docs/domain/server-state-transitions.md` y skill `noodara-domain-model` §2.1 se actualizan por D-03.

</code_context>

<specifics>
## Specific Ideas

- El activity log debe poder decir "Admin conectó srv-1" y "Discovery de srv-1 completó con 2 advertencias" sin exponer hosts históricos ni credenciales: metadata mínima, fingerprints públicos.
- La lista de servidores debe mostrar un servidor sano como CONNECTED aunque no exista sesión abierta: el estado describe la última operación, no un socket.
- El canary debe recorrer el mismo camino que un admin real (credencial cifrada → descifrada → ssh2 → salidas), no un doble; es la base del `security:scan-leaks` nightly.

</specifics>

<deferred>
## Deferred Ideas

- Endpoint `POST /servers/:id/trust-fingerprint` y rutas de servidores — fase 4 (el servicio queda listo aquí).
- Política de retención/poda de `discovery_snapshots` — v0.5, cuando exista polling continuo.
- Evento `server.connection_skipped` para disparos redundantes — descartado para v0.1; el 409 basta.
- Permitir varios usuarios SSH para el mismo host:puerto — reconsiderar si aparece la necesidad; hoy la unicidad `(host, ssh_port)` lo impide.
- Metadata con valores antes/después en `server.updated` — descartado; solo `changedFields`.
- Job nightly de QA-05 sobre `pnpm security:scan-leaks` — fase 5 (el script y la suite nacen aquí).
- Test connection sin discovery ("flag discover") — descartado para v0.1; un solo camino connect + discover.

</deferred>

---

*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Context gathered: 2026-09-15*
