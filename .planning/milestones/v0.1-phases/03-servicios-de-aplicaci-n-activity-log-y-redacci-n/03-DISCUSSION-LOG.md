# Phase 3: Servicios de aplicación, activity log y redacción - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-15
**Phase:** 3-Servicios de aplicación, activity log y redacción
**Areas discussed:** Connect y discovery como servicios, Snapshot de discovery y denormalización, Reglas de registro/edición/eliminación, Taxonomía de eventos y canary

---

## Connect y discovery como servicios

### ¿Cómo se organizan connect y discovery?

| Option | Description | Selected |
|--------|-------------|----------|
| Un servicio connectAndDiscover sobre una sesión | Un solo servicio conecta, aplica el resultado, descubre en la misma sesión, escribe snapshot y cierra; un job en fase 4, un handshake, dos eventos | ✓ |
| Dos servicios: connectServer y discoverServer | Flujo connect-server → discover-server de ARCHITECTURE con dos jobs y dos handshakes | |
| Un servicio con flag discover: boolean | Siempre conecta, opcionalmente descubre; permite "Test connection" sin discovery | |

**User's choice:** Un servicio connectAndDiscover sobre una sesión.

### Estado cuando el discovery falla a mitad

| Option | Description | Selected |
|--------|-------------|----------|
| El estado lo fija el discovery: ERROR/UNREACHABLE con last_error_code | Segunda transición según el error; facts parciales se guardan | ✓ |
| Queda CONNECTED con last_error_code como advertencia | Solo el código viaja; un servidor que perdió conexión quedaría CONNECTED | |
| No se transiciona a CONNECTED hasta que el discovery termina | Un solo resultado al final; la UI no distingue "descubriendo" | |

**User's choice:** El estado lo fija el discovery.

### ¿trustFingerprint en fase 3 o 4?

| Option | Description | Selected |
|--------|-------------|----------|
| Fase 3: el servicio, sin endpoint | Mutación de Server con transición y evento; fase 4 solo expone la ruta | ✓ |
| Fase 4, junto con el endpoint | Asignación literal de D-15 | |

**User's choice:** Fase 3, el servicio.

### Doble disparo con el servidor en CONNECTING

| Option | Description | Selected |
|--------|-------------|----------|
| Rechazar con ALREADY_CONNECTING y sin evento | Lock de fila, sin SSH, sin evento; fase 4 → 409 | ✓ |
| Rechazar y registrar evento de intento ignorado | Igual pero con server.connection_skipped | |
| Encolar/esperar a que termine el anterior | Coordinación que pertenece a BullMQ | |

**User's choice:** Rechazar con ALREADY_CONNECTING y sin evento.

### Estado tras un cierre limpio (pregunta añadida al detectar ambigüedad en server-state-transitions.md)

| Option | Description | Selected |
|--------|-------------|----------|
| Queda CONNECTED; cerrar la sesión no cambia el estado | CONNECTED = última operación exitosa; clean_close reservado para D-14 y cierres de sistema; se actualiza el doc | ✓ |
| Pasa a DISCONNECTED al cerrar; CONNECTED solo dura el run | Lectura literal de D-13; servidores sanos se verían DISCONNECTED | |

**User's choice:** Queda CONNECTED.

---

## Snapshot de discovery y denormalización

### Forma de discovery_snapshots

| Option | Description | Selected |
|--------|-------------|----------|
| jsonb con facts + checks + warnings tal cual | Una fila por run con outcome, error_code y payload jsonb; denormalización solo en servers | ✓ |
| Columnas normalizadas para facts + jsonb para checks | Duplica el esquema de servers; migración por cada fact nuevo | |
| Todo normalizado, tabla hija de checks | Máxima consultabilidad, más tablas y joins | |

**User's choice:** jsonb con el DiscoverySnapshot tal cual.

### Snapshot y denormalización en runs parciales

| Option | Description | Selected |
|--------|-------------|----------|
| Snapshot siempre; servers solo con facts no nulos | outcome partial/failed; un fact nulo no borra el valor anterior | ✓ |
| Snapshot siempre; servers se sobrescribe entero | Refleja el último run aunque deje huecos | |
| Snapshot y servers solo cuando el discovery es completo | Sin evidencia parcial para diagnóstico | |

**User's choice:** Snapshot siempre; servers solo con facts no nulos.

### Retención

| Option | Description | Selected |
|--------|-------------|----------|
| Ilimitada en v0.1 | Discovery manual, volumen trivial; v0.5 decide; cascada al eliminar | ✓ |
| Tope fijo, p. ej. últimos 50 por servidor | Poda al insertar | |
| Tope configurable por env var | Una variable más para un problema inexistente | |

**User's choice:** Ilimitada en v0.1.

### docker_compose_version en servers

| Option | Description | Selected |
|--------|-------------|----------|
| Sí: añadir docker_compose_version a servers | Misma migración; detalle y v0.2 no leen el snapshot | ✓ |
| No: queda solo en el payload del snapshot | Dos fuentes de datos para el detalle | |

**User's choice:** Sí, añadir la columna.

---

## Reglas de registro, edición y eliminación

### Unicidad

| Option | Description | Selected |
|--------|-------------|----------|
| Nombre único (case-insensitive) y host+puerto únicos | Índices lower(name) y (host, ssh_port); NAME_TAKEN / HOST_TAKEN | ✓ |
| Solo nombre único | host+puerto repetible con distintos usuarios | |
| Sin unicidad | El id es la identidad | |

**User's choice:** Nombre único y host+puerto únicos.

### Editar o eliminar en CONNECTING

| Option | Description | Selected |
|--------|-------------|----------|
| Rechazar ambos con SERVER_BUSY | Conflicto; el job en vuelo nunca escribe sobre una fila cambiada | ✓ |
| Permitir editar solo nombre; rechazar el resto | | |
| Permitir todo; el job en vuelo se descarta al terminar | Comprobación de updated_at al final; fácil dejar estados falsos | |

**User's choice:** Rechazar ambos con SERVER_BUSY.

### Confirmación por nombre (SERV-03)

| Option | Description | Selected |
|--------|-------------|----------|
| En el servicio: deleteServer exige confirmName igual al nombre | CONFIRMATION_MISMATCH; backend enforcement | ✓ |
| Solo en la UI; el servicio borra por id | Protección desaparece para clientes API | |

**User's choice:** En el servicio.

### Reemplazo de credencial

| Option | Description | Selected |
|--------|-------------|----------|
| Actualizar en sitio: mismo credential_id, nuevo envelope | UPDATE de credentials en la misma transacción; sin filas huérfanas | ✓ |
| Insertar nueva y borrar la anterior | Dos filas transitorias, id cambia | |

**User's choice:** Actualizar en sitio.

**Notes:** Al pasar de área el usuario aceptó dos asunciones: `discovery_snapshots` se borran en cascada y `activity_events` sobreviven con `entity_id` del servidor borrado; la passphrase de una clave se guarda dentro del mismo envelope como JSON `{ privateKey, passphrase }`.

---

## Taxonomía de eventos y canary

### Acciones server.* y metadata

| Option | Description | Selected |
|--------|-------------|----------|
| Seis acciones con metadata mínima y tipada | created, updated {changedFields, credentialReplaced}, deleted, connection_attempted, discovery_completed, fingerprint_trusted; fingerprints en metadata | ✓ |
| Mismas seis acciones, metadata con valores antes/después | Expone hosts históricos en el activity log | |
| Un solo server.connected/failed en vez de attempted + discovery | Contradice el criterio 4 del roadmap | |

**User's choice:** Seis acciones con metadata mínima y tipada.

### Actor de eventos ejecutados en el worker

| Option | Description | Selected |
|--------|-------------|----------|
| El admin que lo disparó: el servicio recibe actorId | El worker propaga actor desde el job; system para disparos automáticos futuros | ✓ |
| Siempre system para lo que corre en el worker | El log no dice quién pidió la conexión | |

**User's choice:** El admin que lo disparó.

### Forma del canary SEC-02

| Option | Description | Selected |
|--------|-------------|----------|
| Flujo completo contra sshd real + salidas unitarias | register → connectAndDiscover → edit → delete con canaries; volcado de logs, resultados, activity_events, snapshots, error simulado; script pnpm security:scan-leaks | ✓ |
| Solo el flujo completo, sin script separado | Script y nightly en fase 5 | |
| Pruebas por salida, sin sshd real | SshPort falso; no prueba el camino real | |

**User's choice:** Flujo completo contra sshd real + script scan-leaks.

### Resultado de registerServer / editServer

| Option | Description | Selected |
|--------|-------------|----------|
| Vista pública ServerView completa | Todos los campos de servers + credentialType, sin credentialId ni envelope; test por lista de claves | ✓ |
| Solo { id } | Dos consultas por operación en fase 4 | |
| ServerView sin credentialType | La sheet de edición no podría indicar el tipo configurado | |

**User's choice:** ServerView completa con credentialType.

---

## Claude's Discretion

- Contrato de errores de los servicios (resultados `{ ok: false, code }` para fallos esperados; excepciones solo para bugs/infraestructura).
- Inyección de `SshPort`, timeouts, reloj y DB por factoría sin contenedor DI.
- Helper único de cifrado/descifrado de credenciales y ciclo de vida del `SecretValue` en `appRedactor`.
- Funciones puras en `packages/domain`: `mergeDiscoveryFacts`, clasificación `ok | partial | failed`, `classifyServerEdit`, `validateServerName`.
- Forma de la migración `0003` y ampliación de `representative-data.ts`.
- Test de boundary que impide importar `writeActivityEvent` fuera de `services/` y `activity/`.

## Deferred Ideas

- Endpoint de trust y rutas de servidores — fase 4.
- Retención/poda de snapshots — v0.5.
- Evento `server.connection_skipped` — descartado.
- Varios usuarios SSH por host:puerto — reconsiderar si aparece la necesidad.
- Metadata antes/después en `server.updated` — descartado.
- Nightly de QA-05 sobre `security:scan-leaks` — fase 5.
- Test connection sin discovery — descartado para v0.1.
