# Pitfalls Research — Noodara v0.1 (Foundation)

**Dominio:** Self-hosted PaaS control plane (categoría Coolify / Dokploy), TypeScript, gestión de servidores vía SSH, credenciales cifradas at-rest.
**Investigado:** 2026-09-10
**Confianza global:** MEDIUM-HIGH (mayoría de hallazgos verificados contra issues públicos de coollabsio/coolify y Dokploy/dokploy, CVEs publicadas y documentación oficial; algunos puntos son de conocimiento general de sysadmin/SSH marcados como tales)

## Critical Pitfalls

### Pitfall 1: Secreto de firma/cifrado con fallback hardcodeado

**What goes wrong:**
El backend cae a un valor por defecto hardcodeado cuando la variable de entorno de secreto no está configurada (auth signing secret, encryption key, etc.). Cualquiera que lea el código fuente puede derivar la clave y forjar sesiones/JWTs o descifrar credenciales de todas las instalaciones que no sobreescribieron esa variable.

**Why it happens:**
Facilita el "funciona out-of-the-box" durante desarrollo/demo; el fallback nunca se elimina antes de producción porque nadie fuerza su ausencia.

**How to avoid:**
- El proceso debe fallar el arranque (`fail-fast`, exit code ≠ 0) si `ENCRYPTION_KEY` / `SESSION_SECRET` no están presentes o no cumplen longitud/entropía mínima (p. ej. ≥32 bytes generados criptográficamente).
- El instalador de un comando debe **generar** el secreto localmente (no traerlo embebido en el repo) y persistirlo solo en el `.env` del servidor del usuario.
- Test unitario: "boot sin `ENCRYPTION_KEY` → proceso lanza error y no sirve tráfico".
- Test estático: grep en CI que falle el build si aparece un string literal usado como valor por defecto de un secreto en código fuente.

**Warning signs:**
- Código con patrones `secret ?? "..."`, `process.env.X || "default"` donde X es criptográfico.
- Documentación que dice "funciona sin configurar nada" para auth/cifrado.

**Phase to address:**
v0.1 — Control Plane / Auth foundation (bloqueante, criterio de aceptación 6.7 "credenciales cifradas" depende de esto).

**Evidencia real:** Dokploy CVE-2026-45631 (CVSS 10.0) — `BETTER_AUTH_SECRET` con fallback `"better-auth-secret-123456789"` permitía forjar JWT y obtener admin en toda instancia sin configurar la variable. Dokploy CVE-2026-24840 — contraseña de base de datos hardcodeada en `install.sh`, compartida por casi todas las instalaciones.

---

### Pitfall 2: Secretos/credenciales expuestos en logs de operación (build, deploy, debug, activity log)

**What goes wrong:**
Las credenciales SSH, tokens y env vars aparecen en texto plano en logs de despliegue, logs de debug o el activity log, aunque la API nunca los devuelva directamente. Los usuarios (y soporte, y backups de logs) terminan con el secreto igualmente.

**Why it happens:**
Los comandos ejecutados remotamente (o el output de `stdout`/`stderr` de subprocesos) se loguean íntegros para debugging sin pasar por un sanitizador; los interpoladores de comandos (`.env` construido dinámicamente, `docker run -e KEY=value`) quedan en el log del comando ejecutado.

**How to avoid:**
- Sanitización centralizada: **todo** log, error, y payload de activity log pasa por un serializador único que redacta por *shape* (campos marcados como `Secret`/`Credential` en el dominio) y no por nombre de variable — evita el caso "solo redacta si está `locked`".
- Nunca loguear el comando SSH completo si contiene interpolación de secretos; loguear una versión con placeholders (`ssh exec: <redacted command>`).
- Test de seguridad automatizado (parte de "Security tests" de 6.9 del roadmap, adelantado a v0.1): fixture con una credencial de prueba reconocible (`TESTSECRET_...`) y un grep sobre toda la salida de logs/API/errores generados por la suite de integración — debe dar 0 matches.
- Redacción por defecto, no opt-in (`locked` como en Coolify demostró ser insuficiente: la UI sugería tratarlo como secreto pero no lo redactaba salvo bloqueado explícitamente).

**Warning signs:**
- Buscar en logs de CI/integración strings iguales a la fixture de contraseña de prueba.
- Cualquier log que incluya el comando SSH crudo ejecutado sobre el servidor remoto.

**Phase to address:**
v0.1 — Server connection & SSH execution (bloqueante; criterios de aceptación 6.7 "ninguna credencial en logs" y "ninguna credencial en response payloads").

**Evidencia real:** Coolify #7019 "Deployment log leaks all my secret environment variables", #6658 "Environment variables/secrets in plain text in debug logs", #7235 "Environment variables exposed in deployment debug logs" — issue recurrente reportado múltiples veces a lo largo de versiones distintas, señal de que la sanitización no estaba centralizada sino parcheada caso por caso.

---

### Pitfall 3: Pérdida de la clave de cifrado invalida todas las credenciales (sin plan de key rotation/backup)

**What goes wrong:**
La clave maestra de cifrado at-rest (equivalente a `APP_KEY`) vive solo en el filesystem del control plane, separada del backup de la base de datos. Si se restaura la BD en otro servidor, o se rota la clave sin migrar los valores existentes, todas las credenciales cifradas quedan irrecuperables (`MAC invalid` / "unable to decrypt").

**Why it happens:**
Se trata el backup de base de datos como backup completo del sistema, sin documentar ni automatizar que la clave de cifrado es un artefacto igualmente crítico y separado.

**How to avoid:**
- Diseñar desde v0.1 un esquema de **key versioning** explícito: cada blob cifrado guarda qué versión de clave lo cifró; soportar múltiples claves activas para descifrado (current + previous) igual que `APP_PREVIOUS_KEYS`.
- Documentar y, si es posible, automatizar el respaldo conjunto (clave + BD) desde el primer release, no como afterthought de v0.4+.
- Test de integración: cifrar con clave A, rotar a clave B conservando A como "previous", verificar que el valor sigue siendo descifrable; luego remover A y verificar que falla de forma explícita y detectable (no silenciosa).

**Warning signs:**
- Instrucciones de backup que solo mencionan `pg_dump` sin mencionar la clave de cifrado.
- Ausencia de un campo de versión de clave en el esquema de credenciales.

**Phase to address:**
v0.1 diseño del esquema de cifrado (no requiere feature de rotación completa en v0.1, pero el modelo de datos debe soportar versión de clave desde el día uno — cambiarlo después es una migración de datos costosa). Rotación operativa completa puede diferirse, pero **sin** el campo de versión desde v0.1 se vuelve migración retroactiva de todo el dataset cifrado.

**Evidencia real:** Documentación oficial de Coolify sobre backup/restore y issue coolify-docs #350 "MAC invalid errors during backup restoration" — patrón recurrente de soporte: "backup existe pero es inútil sin el APP_KEY original".

---

### Pitfall 4: Estrategia de host key SSH ausente o ingenua (TOFU mal implementado)

**What goes wrong:**
Dos fallos opuestos son comunes: (a) desactivar la verificación de host key (`StrictHostKeyChecking=no` / equivalente) para "que funcione", exponiendo a MITM en la primera conexión y en cada reconexión; o (b) fijar el host key en el primer connect sin permitir su actualización legítima (reinstalación del VPS, rotación de claves del proveedor cloud), generando "Host key verification failed" permanente que el usuario no sabe resolver.

**Why it happens:**
SSH host key management no tiene una UX estándar fuera de la CLI interactiva; los PaaS self-hosted automatizan la conexión y terminan optando por desactivar la verificación por simplicidad, o por fallar duro sin ruta de recuperación.

**How to avoid:**
- Implementar TOFU explícito: en el primer `connect`, capturar el fingerprint vía `ssh-keyscan`-equivalente, mostrarlo al usuario en la UI antes de confirmar (progressive disclosure: fingerprint colapsado por defecto, expandible), y persistirlo asociado al `Server`.
- En conexiones subsiguientes, comparar contra el fingerprint guardado; si cambia, marcar el servidor en estado `ERROR` con motivo explícito "host key changed" y exigir confirmación manual explícita del usuario para re-aceptar (nunca auto-aceptar silenciosamente).
- Test unitario: dado un fingerprint guardado y uno distinto entrante → transición a `ERROR` con código de motivo específico, conexión rechazada.
- Test de integración (Testcontainers): reinstalar el contenedor SSH de prueba (nuevo host key) y verificar que Noodara detecta el cambio y no conecta automáticamente.

**Warning signs:**
- Código con `StrictHostKeyChecking=no` o `ignoreHostKey: true` en la librería SSH cliente.
- Ausencia de un campo `hostFingerprint` en la entidad `Server`.

**Phase to address:**
v0.1 — Server connection (explícitamente listado en 6.3 del roadmap como "Host fingerprint strategy definida"; es un criterio de aceptación bloqueante).

**Evidencia real:** Coolify #5357 "Host key Verification failed" sin ruta de recuperación clara documentada; #7980 "SSH connection fails after system package update" y #3664 "After update: Server is not reachable" — ambos son consecuencia de cambios de host key o de configuración SSH del lado del servidor sin manejo explícito en el control plane.

---

### Pitfall 5: Instalador de un comando falla en VPS no perfectamente limpios

**What goes wrong:**
El instalador asume un estado ideal (root, sin Docker previo, puertos libres, sin firewall configurado, systemd estándar) y falla silenciosamente o a mitad de camino en VPS reales: Docker instalado vía `snap` (incompatible), puertos 80/443/3000/8000 ocupados por otro servicio, firewall (`ufw`) bloqueando el puerto necesario, o el script no siendo re-ejecutable de forma segura tras un fallo parcial.

**Why it happens:**
El instalador se prueba mayormente contra VPS recién creados desde una imagen limpia del proveedor, no contra VPS con historial (usados previamente para otro proyecto, con Docker Desktop/snap, con Portainer, con Nginx del sistema, etc.).

**How to avoid:**
- Preflight checks explícitos y con mensajes accionables antes de tocar el sistema: usuario root/sudo disponible, Docker no instalado vía snap, puertos objetivo libres (o el instalador pregunta/permite override de puerto), espacio en disco y RAM mínimos.
- El instalador debe ser **idempotente**: correrlo dos veces sobre el mismo servidor no debe romper nada ni duplicar configuración.
- Exit codes y mensajes de error específicos por causa de fallo (no un genérico "installation failed").
- Test de integración con Testcontainers/VM: correr el instalador dos veces seguidas sobre la misma imagen limpia → segunda corrida no falla y el estado final es idéntico. Correr contra una imagen con un servicio ya escuchando en el puerto por defecto → falla con mensaje específico de conflicto de puerto, no cuelgue ni error genérico.

**Warning signs:**
- Instalador que no verifica prerequisitos antes de empezar a escribir archivos/contenedores.
- Ausencia de manejo específico para "puerto en uso" vs "Docker via snap" vs "sin permisos root".

**Phase to address:**
v0.1 — Instalador (criterio de aceptación explícito en PROJECT.md: "un comando en un VPS limpio debe dejar Noodara operativo").

**Evidencia real:** Coolify docs oficiales de troubleshooting confirman: Docker vía snap "no está soportado y romperá el instalador"; issue #3943 "install.sh fails silently on step Docker"; #3693 "coolify-proxy doesn't start if port 80 is in use, even when not configured to use that port"; discusión sobre conflicto recurrente en puerto 8000 (Python dev servers, Portainer, Plausible) que "falla silenciosamente".

---

### Pitfall 6: Detección de Docker frágil (falsos negativos/positivos de versión)

**What goes wrong:**
El discovery reporta "Docker no instalado" cuando sí lo está (parsing de un formato de salida no soportado en versiones nuevas/viejas de Docker), o al revés, valida como compatible una versión de Docker que en realidad no cumple el mínimo requerido.

**Why it happens:**
Se depende de parsear texto de `docker version`/`docker info` con un formato asumido fijo; Docker cambia el formato de salida entre versiones (`docker version --format json` solo existe desde 23.0.5, por ejemplo), y versiones muy nuevas rompen parsers escritos contra versiones antiguas.

**How to avoid:**
- Usar salida estructurada (`--format '{{json .}}'` o el socket/API de Docker directamente) en vez de parsear texto libre, con manejo explícito de "formato no reconocido" como resultado distinto de "no instalado".
- Test unitario con fixtures de salida real de múltiples versiones de Docker (mínima soportada, una intermedia, una muy reciente) para el parser de discovery — debe distinguir claramente `NOT_INSTALLED` de `VERSION_TOO_OLD` de `PARSE_ERROR` (nunca colapsar `PARSE_ERROR` en `NOT_INSTALLED`).

**Warning signs:**
- Parser de discovery que hace regex sobre texto libre de `docker --version`.
- Ausencia de test con múltiples versiones reales de Docker en fixtures.

**Phase to address:**
v0.1 — Discovery.

**Evidencia real:** Coolify #4128 "Docker version wrongly set as valid when validating new server"; #11089 "Coolify doesn't detect version 29.x docker engine"; #2363 "Docker not detected on localhost validation".

---

### Pitfall 7: Ejecución de comandos remotos que requieren sudo/TTY se cuelga o falla sin diagnóstico

**What goes wrong:**
Comandos de discovery o instalación que necesitan privilegios elevados (`sudo`) se ejecutan sobre una sesión SSH no interactiva (sin TTY asignado). `sudo` intenta leer una contraseña de un terminal que no existe y el proceso queda colgado indefinidamente en vez de fallar rápido, consumiendo el timeout completo o, peor, sin timeout, bloqueando el worker.

**Why it happens:**
Las librerías de cliente SSH (ssh2 en Node.js y similares) por defecto no asignan pseudo-TTY para `exec`, y `sudo` sin `NOPASSWD` configurado o sin `-n` intenta pedir contraseña de forma silenciosa.

**How to avoid:**
- Nunca depender de `sudo` interactivo: exigir (y documentar en el flujo de add-server) que el usuario SSH configurado tenga los permisos necesarios sin prompt (usuario con acceso directo a Docker socket, o `NOPASSWD` explícito documentado), o evitar por completo comandos que requieran privilegios elevados en el happy path de v0.1.
- Usar siempre `sudo -n` (non-interactive) cuando sea inevitable, de forma que falle inmediatamente con código de error distinguible en vez de colgarse.
- Timeout explícito por comando (ya listado en 6.3 del roadmap) como red de seguridad, pero no como estrategia primaria — un comando colgado por 30s en cada discovery es una mala UX aunque no rompa el sistema.
- Test de integración: ejecutar un comando que requiere sudo sin `NOPASSWD` configurado → debe fallar rápido con un código de error específico ("privilege escalation required"), nunca colgarse hasta el timeout genérico.

**Warning signs:**
- Discovery que usa `sudo` para leer información que podría obtenerse sin privilegios (la mayoría de CPU/RAM/disk/uptime no los requiere).
- Tiempo de respuesta de discovery cercano al timeout máximo configurado en pruebas manuales.

**Phase to address:**
v0.1 — Server connection / SSH execution (afecta directamente "safe command execution" de 6.5 y "timeouts se reportan correctamente" de 6.7).

**Evidencia real:** Patrón de sysadmin ampliamente documentado (sudo `askpass`/no-tty errors en automatización SSH); issue ssh2 #895 sobre autenticación keyboard-interactive terminando de forma inesperada. Confianza MEDIUM (no es un issue específico de Coolify/Dokploy, pero es la causa raíz típica detrás de "discovery se cuelga" en herramientas de este tipo).

---

### Pitfall 8: Estado de conexión "flapping" por falsos negativos de red/firewall

**What goes wrong:**
Un solo intento de conexión fallido (por rate-limiting de `ufw`, latencia puntual, o una race condition entre el firewall y Docker arrancando) marca el servidor como `UNREACHABLE`/`ERROR` de forma inmediata y definitiva, generando notificaciones falsas y una UI que no refleja la realidad del servidor (que sigue sano).

**Why it happens:**
Se trata cada intento de conectividad como fuente de verdad única, sin distinguir "fallo transitorio de red" de "servidor realmente inaccesible", y sin retry/backoff antes de cambiar el estado visible al usuario.

**How to avoid:**
- La transición a `UNREACHABLE` no debe depender de un único intento fallido: implementar reintentos rápidos con backoff corto antes de marcar el estado como definitivo (patrón: 1 fallo se descarta, 3 fallos rápidos consecutivos sí confirman).
- Diferenciar en el dominio entre "check transitorio" (no cambia el estado persistido) y "check confirmado" (sí lo cambia y dispara activity log).
- Test unitario de la state machine: secuencia de 1 fallo + 1 éxito → estado permanece `CONNECTED`; secuencia de 3 fallos consecutivos rápidos → transición a `UNREACHABLE`.
- Test de integración (Testcontainers): simular una caída de red de ~2s durante el healthcheck periódico → no debe producirse cambio de estado visible ni entrada duplicada en activity log.

**Warning signs:**
- Cambios de estado a `UNREACHABLE`/`CONNECTED` alternando en ventanas cortas de tiempo (segundos/minutos) en logs de desarrollo.
- Firewall del servidor de pruebas con reglas de rate-limit en el puerto SSH (patrón típico en Hetzner/UFW).

**Phase to address:**
v0.1 — Connection state machine (directamente relacionado con los 6 estados mínimos de 6.1 y con el criterio "100 conexiones exitosas consecutivas" de 6.7 — un mecanismo de flapping falso rompería ese criterio en CI).

**Evidencia real:** Coolify #5315 y #4407 "false unreachable notifications"; PR #4586 que introduce exactamente el patrón de descartar el primer fallo y confirmar con 3 checks rápidos; #8151 "Infinite SSH Connection Refused loop due to UFW/Docker race condition on Hetzner".

---

### Pitfall 9: Inyección de comandos al construir shell commands con datos de usuario

**What goes wrong:**
Valores provistos por el usuario (nombre de servidor, futuro `appName` de servicios en v0.2+) se interpolan directamente en strings de shell ejecutados vía SSH o localmente, permitiendo que un usuario autenticado (o un dato "de confianza" mal validado) inyecte comandos arbitrarios con los privilegios del proceso que ejecuta.

**Why it happens:**
Es más simple construir un string de comando (`` `docker start ${name}` ``) que usar ejecución parametrizada; la sanitización que se aplica (trim, lowercase, quitar espacios) no cubre metacaracteres de shell (`;`, `` ` ``, `$()`, `|`, `&`).

**How to avoid:**
- Nunca construir comandos remotos por concatenación de strings con datos de usuario. Usar allowlists estrictas de caracteres (regex) para cualquier identificador que termine en un comando (`^[a-zA-Z0-9_.-]+$`), validadas tanto en el dominio (unit test) como en el schema de la API (doble capa, no solo una).
- Cuando la librería SSH lo permita, preferir ejecución con argumentos separados en vez de un string único de shell; si no es posible (SSH exec siempre es un string), el identificador debe pasar por el validador de allowlist **antes** de construir el string, nunca "sanitizar" post-hoc con reemplazos parciales.
- Test unitario: fixture con `appName`/`hostname` conteniendo `; rm -rf /`, backticks, `$()`, pipes → debe ser rechazado por el validador de dominio, no llegar nunca a la capa de ejecución.

**Warning signs:**
- Cualquier `execAsync`/`exec` de Node.js que reciba un template string con una variable no validada por allowlist.
- Validación de nombres que solo hace `.trim().toLowerCase()`.

**Phase to address:**
v0.1 — sienta el patrón de validación de identificadores (hostname, nombre de servidor) que se reutilizará en v0.2 para `appName`/nombres de servicio, donde el riesgo crece al ejecutar comandos Docker con esos valores.

**Evidencia real:** Dokploy GHSA-fcgq-jjfg-hrhj (CVSS 9.9) — `cleanAppName()` solo quitaba espacios y pasaba a minúsculas; `appName` llegaba sin restricción de regex al schema de API y se interpolaba en `execAsync`/`execAsyncRemote`, permitiendo RCE con privilegios del servidor.

---

### Pitfall 10: Migraciones de base de datos que rompen el upgrade in-place

**What goes wrong:**
Un upgrade de versión falla a mitad de la migración (constraint que no existe, tabla duplicada, agotamiento de memoria durante una migración pesada) dejando la base de datos en un estado intermedio inconsistente, y el control plane entra en crash-loop porque el proceso de arranque exige que las migraciones completen.

**Why it happens:**
Las migraciones no son idempotentes ni verifican precondiciones (`DROP CONSTRAINT IF EXISTS` en vez de `DROP CONSTRAINT`), se asumen recursos de servidor generosos, y no hay un mecanismo de rollback automático ni de backup pre-migración.

**How to avoid:**
- Todas las migraciones deben ser escritas de forma defensiva (`IF EXISTS`/`IF NOT EXISTS`) y probadas contra un snapshot representativo del esquema anterior, no solo contra una base vacía.
- Backup automático (o al menos snapshot) antes de aplicar migraciones en el flujo de upgrade, desde v0.1 aunque el mecanismo de upgrade formal no exista todavía — establecer la disciplina de migraciones reversibles desde la primera migración.
- Test de integración: aplicar migraciones N-1 → poblar con datos representativos → aplicar migración N → verificar integridad de datos y ausencia de errores, como parte de CI (no solo migrar sobre BD vacía).

**Warning signs:**
- Migraciones sin cláusula `IF EXISTS`/`IF NOT EXISTS` en operaciones destructivas.
- CI que solo prueba migraciones contra una base de datos recién creada.

**Phase to address:**
v0.1 sienta la disciplina (toda migración desde la primera debe ser defensiva e idempotente); el mecanismo formal de "upgrade seguro" en producción puede diferirse a una versión posterior, pero corregir migraciones ya escritas de forma no defensiva es mucho más caro que empezar bien.

**Evidencia real:** Coolify #3848 "Running migrations fails when upgrading... attempted to drop a constraint that did not exist"; #2820 "unable to start service db-migration" en crash-loop; #3618 "Duplicate Table Error During Migration"; #5776 "migration stopped by memory exhaustion".

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|--------------------|-----------------|------------------|
| Desactivar `StrictHostKeyChecking` para "que conecte ya" | Setup más rápido en demos | MITM en cada conexión; imposible de retirar sin romper servidores ya registrados | Nunca |
| Loguear `stdout`/`stderr` de comandos SSH sin sanitizar "por ahora" | Debugging más simple durante desarrollo | Fuga de credenciales en logs de producción/soporte, difícil de auditar retroactivamente | Solo en modo debug local explícito, nunca en build por defecto ni en CI |
| Migraciones sin `IF EXISTS` porque "la BD está vacía en dev" | Escribir la migración más rápido | Rompe el primer upgrade real contra datos existentes | Nunca — el costo de escribirlo bien es mínimo |
| Redactar secretos "si están marcados como locked" en vez de por tipo de dato | Menos cambios en el modelo de datos existente | Falsa sensación de seguridad; cualquier secreto no marcado se filtra | Nunca |
| Postergar el campo de versión de clave de cifrado "hasta que haya rotación" | Modelo de datos más simple ahora | Migración de datos retroactiva sobre todo el dataset cifrado cuando se necesite rotar | Nunca en v0.1 (el campo es barato de agregar ahora) |
| Validar `appName`/hostname con `.trim()` en vez de allowlist regex | Menos código de validación | Vector de inyección de comandos reutilizado en cada feature nueva que ejecuta shell | Nunca |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| SSH (cliente Node.js tipo ssh2/ssh2-promise) | Asumir TTY disponible para `exec`; no distinguir timeout de conexión vs timeout de comando | Timeouts separados y explícitos por fase (`connect`, `handshake`, `exec`, `command`); nunca depender de sudo interactivo |
| Docker (vía SSH, sin agent) | Parsear texto libre de `docker version`/`docker info` | Usar formato JSON estructurado y clasificar resultados en `NOT_INSTALLED` / `VERSION_UNSUPPORTED` / `PARSE_ERROR` como estados distintos |
| PostgreSQL (cifrado at-rest de credenciales) | Guardar el blob cifrado sin versión de clave asociada | Cada fila cifrada referencia la versión de clave usada; soporte de múltiples claves activas para descifrado |
| Firewall del servidor remoto (ufw/iptables) | Tratar cualquier fallo de conexión SSH como "servidor inaccesible" permanente | Reintentos rápidos con backoff antes de confirmar `UNREACHABLE`; documentar reglas de firewall recomendadas para el usuario |
| Testcontainers para SSH | Reutilizar el mismo contenedor/host key entre tests, ocultando bugs de manejo de host key | Cada escenario de host-key-change debe usar un contenedor con host key regenerada explícitamente, y limpiar recursos tras cada test (ya exigido en 6.5 del roadmap) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Discovery ejecuta múltiples comandos SSH secuenciales sin pipeline/batch | Latencia de discovery proporcional al RTT × número de comandos | Agrupar comandos de discovery en un único `exec` (script combinado) cuando sea seguro, o paralelizar sobre el mismo canal SSH | Servidores con latencia alta (VPS en otra región) o muchos servidores registrados en paralelo |
| Instalador/build sin verificar RAM disponible antes de operaciones pesadas | VPS de 512MB-1GB se cuelga o el proceso es OOM-killed durante instalación/build | Preflight check de RAM mínima recomendada; sugerir/activar swap si no existe, documentado explícitamente | VPS por debajo de ~1-2GB de RAM sin swap configurado |
| Un solo worker/proceso maneja todas las conexiones SSH activas de forma síncrona | Timeouts en cascada cuando un servidor está lento, afectando el resto de servidores registrados | Aislar timeouts y fallos por servidor; una conexión lenta no debe bloquear el healthcheck de otros servidores | A partir de unos pocos servidores conectados simultáneamente (relevante ya en v0.1 con "100 conexiones consecutivas" en la suite) |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Fallback hardcodeado para secretos de firma/cifrado | Compromiso total de todas las instalaciones que no sobreescriben la variable (CVSS 10.0 en Dokploy) | Fail-fast en boot si el secreto no está configurado con entropía suficiente |
| Redacción de secretos condicionada a un flag manual (`locked`) en vez de por tipo de dato en el dominio | Fuga de secretos "no marcados" en logs/debug | Redacción automática basada en el tipo `Secret`/`Credential` del dominio, nunca opt-in |
| Interpolación de datos de usuario en comandos de shell | RCE con privilegios del proceso/servidor (CVSS 9.9 en Dokploy) | Allowlist regex + ejecución parametrizada, validado en dos capas (schema API + dominio) |
| Deshabilitar verificación de host key SSH | MITM en la conexión al servidor gestionado, robo de credenciales de infraestructura completa | TOFU explícito con fingerprint visible al usuario y confirmación manual ante cambios |
| Eliminar un `Server` sin garantizar el borrado de sus credenciales asociadas (delete no transaccional, soft-delete que deja el blob cifrado) | Credenciales huérfanas persistentes tras "eliminar" el servidor, contradice criterio 6.3 | Test de integración: eliminar servidor → verificar ausencia física de la fila de credenciales (no solo un flag `deleted`) en la base de datos |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Mensaje genérico "connection failed" para cualquier fallo SSH | Usuario no sabe si es host key, timeout, credencial inválida o puerto cerrado, y no puede autodiagnosticar | Motivos de error específicos y accionables por categoría (host key changed, auth failed, timeout, port closed), reflejados en el estado `ERROR` con detalle |
| Fingerprint de host key mostrado como bloque técnico crudo sin contexto | Usuario acepta cualquier fingerprint sin entender qué está confirmando (rompe progressive disclosure) | Mostrar primero "primera vez que te conectás a este servidor" en lenguaje simple, con el fingerprint técnico colapsado/expandible para quien quiera verificarlo |
| Estado `UNREACHABLE` sin indicar hace cuánto se perdió la conexión (`last seen`) | Usuario no puede distinguir "se cayó ahora" de "lleva días sin conectar" | `last seen` visible siempre en el detalle del servidor, ya contemplado en 6.1 — asegurar que se actualiza solo en checks confirmados, no en cada intento transitorio |

## "Looks Done But Isn't" Checklist

- [ ] **Cifrado de credenciales at-rest:** Verificar que el modelo de datos incluye versión de clave, no solo el valor cifrado — de lo contrario "funciona" hasta el primer intento de rotación o restore en otro servidor.
- [ ] **Sanitización de logs:** Verificar con un test que busca la fixture de secreto en **toda** la superficie (API responses, logs de aplicación, activity log, mensajes de error/excepciones), no solo en el log de "deployment" — Coolify tuvo el mismo bug reportado repetidamente en logs distintos.
- [ ] **Timeouts SSH:** Verificar que existen timeouts separados para connect/handshake/exec/command, no un único timeout global — un timeout global "que funciona en el happy path" no cubre el caso sudo-sin-tty colgado.
- [ ] **Estado de conexión:** Verificar que la transición a `UNREACHABLE` requiere confirmación (varios checks), no un único fallo — de lo contrario el criterio de "100 conexiones exitosas consecutivas" en CI es frágil ante cualquier red inestable en el runner.
- [ ] **Eliminar servidor:** Verificar borrado físico (no solo lógico) de la fila de credenciales asociada, con test de integración explícito.
- [ ] **Instalador idempotente:** Verificar corriendo el script dos veces sobre la misma VM limpia — "funciona la primera vez" no implica idempotencia.
- [ ] **Validación de identificadores:** Verificar que hostname/nombre de servidor rechazan metacaracteres de shell, no solo espacios — la ausencia de un caso de prueba con `; rm -rf /` es la señal de que falta.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|-----------------|------------------|
| Secreto de cifrado/firma con fallback hardcodeado ya en producción | HIGH | Rotar el secreto real, invalidar todas las sesiones activas, forzar reautenticación, re-cifrar credenciales existentes con la nueva clave (requiere el versionado de clave del Pitfall 3 para no perder datos) |
| Falta de versión de clave en credenciales cifradas, detectado tarde | HIGH | Migración de datos: descifrar con la clave única existente, re-cifrar añadiendo metadato de versión; ventana de riesgo si se pierde la clave original antes de completar la migración |
| Fuga de secretos ya detectada en logs históricos | MEDIUM | Rotar todas las credenciales expuestas, purgar/reescribir logs históricos si es posible, agregar el test de fixture de secreto a CI para prevenir regresión |
| Instalador no idempotente ya publicado | LOW-MEDIUM | Documentar workaround manual de limpieza mientras se corrige; agregar test de doble ejecución antes del siguiente release |
| Migración de BD rota en un upgrade ya lanzado | MEDIUM-HIGH | Publicar hotfix con migración defensiva (`IF EXISTS`) + guía de recuperación manual para quienes ya fallaron; agregar test de upgrade sobre snapshot poblado a CI |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase (v0.1) | Verification |
|---------|--------------------------|---------------|
| Secreto hardcodeado con fallback | Control Plane / Auth foundation | Test: boot sin secreto configurado → falla explícitamente; grep en CI contra defaults literales |
| Secretos en logs | Server connection & SSH execution | Test de seguridad: fixture de secreto ausente en toda salida de logs/API/errores de la suite de integración |
| Pérdida de clave de cifrado sin versión | Diseño de esquema de cifrado (Control Plane) | Test de integración: rotación de clave con "previous key" soportada; dato sigue siendo descifrable |
| Host key SSH sin estrategia TOFU | Server connection | Test de integración: cambio de host key entre reconexiones → `ERROR` explícito, nunca auto-aceptado |
| Instalador falla en VPS no limpio | Instalador (fuera del control plane en sí, pero criterio de aceptación de PROJECT.md) | Test manual/CI en VM: doble ejecución idempotente; ejecución con puerto ocupado da error específico |
| Detección de Docker frágil | Discovery | Test unitario con fixtures de múltiples versiones reales de Docker |
| Sudo/TTY colgado en comandos remotos | Server connection & SSH execution | Test de integración: comando que requiere sudo sin `NOPASSWD` falla rápido, no cuelga |
| Flapping de estado de conexión | Connection state machine | Test unitario de state machine: 1 fallo no cambia estado; 3 fallos rápidos sí |
| Inyección de comandos vía identificadores de usuario | Server connection (sienta el patrón para v0.2+) | Test unitario: identificadores con metacaracteres de shell rechazados por el validador de dominio |
| Migraciones que rompen upgrade | Toda migración desde la primera (Control Plane) | Test de integración: migrar sobre snapshot poblado del esquema anterior, no solo BD vacía |

## Sources

- [Coolify #7980 — SSH connection fails after system package update](https://github.com/coollabsio/coolify/issues/7980)
- [Coolify #5357 — Host key Verification failed](https://github.com/coollabsio/coolify/issues/5357)
- [Coolify #3664 — After update: Server is not reachable](https://github.com/coollabsio/coolify/issues/3664)
- [Coolify #8151 — Infinite SSH Connection Refused loop, UFW/Docker race condition on Hetzner](https://github.com/coollabsio/coolify/issues/8151)
- [Coolify Docs — Install script failed troubleshooting](https://coolify.io/docs/troubleshoot/installation/install-script-failed)
- [Coolify #3943 — install.sh fails silently on step Docker](https://github.com/coollabsio/coolify/issues/3943)
- [Coolify #3693 — coolify-proxy doesn't start if port 80 is in use](https://github.com/coollabsio/coolify/issues/3693)
- [Coolify #4128 — Docker version wrongly set as valid when validating new server](https://github.com/coollabsio/coolify/issues/4128)
- [Coolify #11089 — Coolify doesn't detect version 29.x docker engine](https://github.com/coollabsio/coolify/issues/11089)
- [Coolify #2363 — Docker not detected on localhost validation](https://github.com/coollabsio/coolify/issues/2363)
- [Coolify #5315 — false 'Your server is unreachable' notifications](https://github.com/coollabsio/coolify/issues/5315)
- [Coolify #4407 — Multiple false 'Your server is unreachable' mails](https://github.com/coollabsio/coolify/issues/4407)
- [Coolify PR #4586 — Fix: Unreachable Notifications](https://github.com/coollabsio/coolify/pull/4586)
- [Coolify #7019 — Deployment log leaks all my secret environment variables](https://github.com/coollabsio/coolify/issues/7019)
- [Coolify #6658 — Environment variables/secrets in plain text in debug logs](https://github.com/coollabsio/coolify/issues/6658)
- [Coolify #7235 — Environment variables exposed in deployment debug logs](https://github.com/coollabsio/coolify/issues/7235)
- [Coolify-docs #350 — MAC invalid errors during backup restoration](https://github.com/coollabsio/coolify-docs/issues/350)
- [Coolify Docs — Backup and Restore Coolify](https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify)
- [Coolify #3848 — Running migrations fails when upgrading beta.357 to beta.358](https://github.com/coollabsio/coolify/issues/3848)
- [Coolify #2820 — unable to start service db-migration](https://github.com/coollabsio/coolify/issues/2820)
- [Coolify #3618 — Duplicate Table Error During Migration](https://github.com/coollabsio/coolify/issues/3618)
- [Coolify #5776 — Coolify stops DB migration caused by memory exhaustion](https://github.com/coollabsio/coolify/issues/5776)
- [Coolify Docs — Raspberry Pi Crashes](https://coolify.io/docs/troubleshoot/server/raspberry-crashes)
- [Dokploy #3474 — Continuous SSH Disconnects on New Remote Nodes](https://github.com/Dokploy/dokploy/issues/3474)
- [Dokploy #2467 — Connecting to a remote server doesn't work](https://github.com/Dokploy/dokploy/issues/2467)
- [Dokploy #4628 — Native multi-architecture Docker build support (amd64 + arm64)](https://github.com/Dokploy/dokploy/issues/4628)
- [Dokploy #35 — Is dokploy not supporting Raspberry Pi?](https://github.com/Dokploy/dokploy/issues/35)
- [Dokploy Security Advisory GHSA-fcgq-jjfg-hrhj — Command Injection in Service Operations](https://github.com/Dokploy/dokploy/security/advisories/GHSA-fcgq-jjfg-hrhj)
- [SentinelOne — CVE-2026-45631: Dokploy Auth Bypass (hardcoded BETTER_AUTH_SECRET)](https://www.sentinelone.com/vulnerability-database/cve-2026-45631/)
- [SentinelOne — CVE-2026-24840: Dokploy hardcoded DB credentials](https://www.sentinelone.com/vulnerability-database/cve-2026-24840/)
- SSH TOFU / host key theory: [Wikipedia — Trust on first use](https://en.wikipedia.org/wiki/Trust_on_first_use), [dev.to — Understanding known_hosts and Host Key Verification](https://dev.to/mahafuz/understanding-knownhosts-and-host-key-verification-what-it-protects-against-and-how-tofu-works-pid)
- Sudo/TTY en automatización SSH (conocimiento general de sysadmin, MEDIUM confidence): [simplified.guide — How to fix sudo no tty askpass errors over SSH](https://www.simplified.guide/ssh/sudo-no-tty-askpass), [ssh2 #895](https://github.com/mscdex/ssh2/issues/895)

---
*Pitfalls research for: Noodara v0.1 Foundation (self-hosted PaaS control plane)*
*Researched: 2026-09-10*
