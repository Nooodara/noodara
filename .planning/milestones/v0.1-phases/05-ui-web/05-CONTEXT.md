# Phase 5: UI web - Context

**Gathered:** 2026-09-19
**Status:** Ready for planning

<domain>
## Phase Boundary

El admin completa en un navegador el flujo login → Servers → add server → connect → discovery → detail, dentro del shell del design system Apple-inspired de Noodara (sidebar, toolbar, contenido), en dark y light, con navegación por teclado y estados vacío, de carga y de error en cada pantalla. Pantallas: setup, login, lista de servidores, sheet de crear/editar servidor, detalle de servidor, activity log y settings.

Incluye el E2E de Playwright del flujo crítico (QA-04), su repetición nightly 20/20 y el job de canary secrets (QA-05).

Requisitos: SERV-04, DETL-01, DETL-02, ACT-02, SET-01, UI-01, UI-02, DISC-02, QA-04, QA-05.

`apps/web` y `packages/ui` no existen todavía: la fase es greenfield en frontend. La API HTTP de fase 4 ya cubre casi todo lo que la UI consume. **Única adición de backend aceptada en esta fase:** lo necesario para que el progreso del discovery check por check sea real (D-05), porque hoy ningún endpoint ni evento expone los checks y DISC-02 es criterio de aceptación de esta fase.

Fuera de la fase: instalador y Docker Compose (fase 6), cualquier entidad de v0.2+ (projects, services, domains), configuración editable, pantalla de sesiones, historial de discoveries.

</domain>

<decisions>
## Implementation Decisions

### Heredado de fases anteriores (bloqueado, no se re-discutió)
- Next.js 16 App Router como cliente delgado de la API Fastify (PROJECT.md, aprobado por el usuario). Nunca habla con Postgres ni Redis.
- Same-origin: Next proxya `/api/*` al API con `rewrites` en dev; sin CORS; cookies `SameSite=Lax` y `EventSource` sin configuración extra (fase 4 D-29). Las mutaciones llevan `Origin` igual a `NOODARA_PUBLIC_URL` o el API responde 403 `FORBIDDEN_ORIGIN`.
- Un único stream SSE global `GET /api/events` compartido por lista y detalle. Sin replay: al reconectar `EventSource`, la UI resincroniza con `GET /api/servers`. Un 401 en el stream o en cualquier ruta redirige a login (fase 4 D-01, D-05, D-06). `503 SSE_LIMIT_REACHED` trae `Retry-After`.
- `connect` y `discover` responden 202 y el progreso llega solo por SSE; `jobId` nunca se usa para polling (fase 4 D-08).
- Vocabulario único de errores `{ error: 'CODE', message }` y `VALIDATION_FAILED` con `issues: [{ path, message }]` (fase 4 D-16).
- Crear/editar en sheet lateral; credencial nunca precargada, muestra `••••••••` + "Replace"; borrar exige escribir el nombre y el API ya lo valida (`CONFIRMATION_MISMATCH`, fase 3 D-12).
- ed25519 recomendado en la UI (fase 2 D-01). El fingerprint se muestra exactamente como `ssh-keygen -lf` (`ssh-ed25519 SHA256:...`, fase 2 D-04/D-05).
- `CONNECTED` significa "la última operación tuvo éxito", no un socket abierto (fase 3 D-03). `UNSUPPORTED_OS` y Docker ausente son advertencias con el servidor en CONNECTED (fase 2 D-11/D-12).
- Tokens, escala tipográfica, status pills, layout y reglas Do/Don't: skill `noodara-ux-apple`. Tailwind + Radix, dark primero, light obligatorio, toggle de tema persistido, copy en inglés sentence case.

### Flujo de alta y conexión
- **D-01:** El botón primario del sheet de alta es **"Save and connect"**: registra el servidor, dispara `POST /connect`, cierra el sheet y navega a la página de detalle, donde se ve el progreso. Un secundario discreto **"Save without connecting"** deja el servidor en PENDING. Connect sigue siendo explícito (SERV-06) porque el botón lo dice.
- **D-02:** Primer connect exitoso (TOFU): la página de detalle muestra un **aviso neutro y descartable, una sola vez**, que dice que la host key se confió en la primera conexión, muestra el fingerprint y el comando `ssh-keygen -lf` para verificarlo en el servidor. Además el fingerprint queda **permanentemente** como fila en mono con su fecha de captura y botón de copiar. No se bloquea el flujo ni se cambia la semántica de fase 3.
- **D-03:** `HOST_KEY_CHANGED`: banner de error en el detalle con **ambos fingerprints apilados en mono** (el confiado y el observado, cada uno con su fecha) y el comando de verificación. "Trust new fingerprint" abre un **diálogo pequeño que exige escribir el nombre del servidor**, la misma fricción que borrar. Es la única acción que puede entregar credenciales a un host impostor.
- **D-04:** Credencial en el sheet: control segmentado con **"Private key" seleccionado por defecto** y "Password" como fallback. La clave se pega en un textarea mono o se carga con **"Choose file"**, que lee el archivo en el navegador y rellena el textarea (el archivo nunca se sube como multipart; el body sigue siendo el JSON de fase 4 D-19). Campo opcional de passphrase. Texto de ayuda recomienda ed25519. Al editar: puntos + "Replace".

### Narrativa de progreso del discovery (DISC-02)
- **D-05:** Progreso **en vivo, check por check**: cada check pasa de pending → running → resultado según el worker lo termina, con su línea de detalle. Esto añade backend en esta fase: (a) `runDiscovery` gana un callback por check, (b) el worker publica un **nuevo tipo de evento de progreso** en el stream SSE existente, (c) un **endpoint de lectura** devuelve los checks del último run para cargas de página, (d) el canary de fugas se extiende al nuevo evento y al nuevo endpoint. Regla dura: la UI **nunca muestra progreso que no ha recibido**.
- **D-06:** Estructura del checklist: **seis pasos con nombre, expandibles a los checks crudos**. "SSH reachable" y "Authenticated" se resuelven del resultado de la conexión (no son checks de discovery). Los otros cuatro agrupan los once `DISCOVERY_CHECK_IDS`: **OS** = `hostname`, `os_release`, `arch`; **Resources** = `cpu`, `memory`, `disk`, `uptime`; **Docker** = `docker_version`, `docker_compose_version`; **Access** = `sudo`, `docker_group`. Un paso pasa solo si todos sus checks pasan. Expandir muestra cada check con `detail` y `durationMs` en mono.
- **D-07:** El checklist vive en una **sección "Discovery" de la página de detalle**: expandida y en vivo durante un run; al terminar se asienta en un resumen de una línea (p. ej. "Discovered 2 minutes ago, 6 of 6 passed, 1 warning") que expande al checklist del último run. "Re-run discovery" vive en esa sección. **Solo el último run** tiene UI en v0.1.
- **D-08:** Tres desenlaces visuales: **pass** (`--status-ok`), **warning** ámbar (`--status-warn`) para un check fallido que deja el servidor utilizable (sin Docker, OS no soportado, sin sudo sin password, fuera del grupo docker), con una línea que explica la consecuencia; **fail** rojo (`--status-error`) solo para el check que terminó el run (`COMMAND_TIMEOUT`, `CONNECTION_LOST`). `not_applicable` y `skipped` en gris idle. El rojo solo aparece cuando algo está realmente roto.

### Lista y detalle de servidores
- **D-09:** Lista en **filas** hairline de 44px: nombre, `host:port` en mono, status pill, last seen relativo con tooltip ISO. Click en la fila abre el servidor. Editar y borrar en un menú `⋯` de fila. Sin cards ni layout alterno para pocos servidores.
- **D-10:** El detalle es **su propia página con URL propia**: nombre del servidor como título de página con la pill al lado, "Connect" o "Re-run discovery" en la toolbar (un solo primario), enlace de vuelta a la lista. Es donde aterriza D-01. El inspector no se usa en v0.1.
- **D-11:** Facts del detalle (DETL-01): fila de **cuatro stat tiles** — CPU cores, RAM, disco (usado de total con un medidor fino de 1px) y uptime — en mono con numerales tabulares. Debajo, pares label/valor agrupados: **System** (hostname, OS, arquitectura), **Docker** (engine y compose), **Connection** (host, puerto, usuario, tipo de credencial, fingerprint, last seen). Todo valor se etiqueta **"as of" la hora del último discovery**; son snapshots puntuales, nunca métricas en vivo.
- **D-12:** Dos estados distintos (DETL-02), una sola acción cada uno. **Nunca conectado:** tiles y pares ceden a un estado vacío "Not discovered yet", una frase, un botón "Connect". **Falló:** banner hairline de error que dice qué pasó y qué hacer, redactado por `error_code`, con el código en mono al final y una acción ("Retry", o "Trust new fingerprint" para host key cambiada). Los facts del último discovery bueno **se mantienen debajo, atenuados y con su fecha** (el backend nunca sobrescribe un valor conocido con null). Si nunca hubo discovery bueno, el banner va sobre el estado vacío.

### Activity log y settings
- **D-13:** Paginación con botón ghost **"Load older"**: primeras 50 filas agrupadas bajo cabeceras de día; el botón trae y añade las 50 siguientes con el cursor opaco. Sin infinite scroll.
- **D-14:** Cada fila es una **frase** ("Admin connected srv-1") con el nombre del servidor como enlace cuando el servidor aún existe, el `errorCode` en mono solo en fallos, y tiempo relativo con tooltip ISO. **Expandir** muestra un conjunto pequeño de pares label/valor **elegidos por acción** (p. ej. "Fields changed: host, port", "Attempts: 2, 1.4s"). La UI renderiza **solo claves que conoce**: un campo futuro del backend nunca aparece por accidente. Nada de JSON crudo.
- **D-15:** Settings **no gestiona sesiones** en esta fase. Se queda en SET-01. Sign out está disponible desde cualquier pantalla (AUTH-03).
- **D-16:** Settings muestra un grupo **Instance** (versión, URL pública) y debajo un grupo **Advanced colapsado** con master key fingerprint, timeouts SSH y worker concurrency en mono, cada uno con una nota de que se fija por variable de entorno. Todo read-only.

### Restricción de seguridad (de la auditoría de fase 4, no discutida)
- **D-17:** `04-SECURITY.md` tiene 4 amenazas abiertas y un bypass de TOFU confirmado: `editServer` no limpia `pendingFingerprint` cuando el servidor está en `ERROR`, así que "Trust new fingerprint" puede promover un fingerprint capturado contra el host anterior. La pantalla de D-03 se apoya directamente en ese camino. **Estos arreglos deben estar hechos antes de ejecutar esta fase**; si no lo están al planificar, el plan los incluye como primera ola. El E2E o un test de integración debe cubrir "editar host en ERROR y luego trust" como regresión.

### Claude's Discretion
- **Forma del evento de progreso y del endpoint de lectura (D-05):** nombres, payload y ruta, dentro de estas reglas: payload por allowlist explícita, dentro del scope protegido por sesión, publicación best-effort que nunca hace fallar el run (como fase 4 D-04), el allowlist de tipos del broadcaster SSE se amplía de forma explícita, y el evento solo lleva el `detail` ya redactado, nunca salida cruda de comandos.
- **Página abierta a mitad de un run:** sin replay de eventos, la UI sabe que el estado es CONNECTING pero no qué checks terminaron. Resolver bajo la regla de D-05 (no inventar progreso).
- **E2E, nightly y canary (QA-04, QA-05):** Playwright contra api + worker + web reales con el contenedor sshd de fase 2; repetición nightly 20/20; 100 conexiones consecutivas en la suite de integración; job de canary en el mismo run (criterio 5). Reutilizar `pnpm security:scan-leaks`. Según CLAUDE.md: E2E críticos en `main`, stress en nightly, no en cada PR. **Ojo:** el repo no tiene remote configurado y solo existe `ci.yml`; el workflow nightly se escribe y se valida en local, y no corre en GitHub hasta que el usuario haga push.
- **Pantallas de setup, login y lockout:** seguir la semántica de la API de fase 1 (404 en `/api/setup` cuando ya hay admin, lockout progresivo) sin revelar si una cuenta existe.
- **Shell:** la sidebar lista solo Servers, Activity y Settings — sin placeholders de entidades de v0.2+ (CLAUDE.md §8). Ubicación del toggle de tema y de sign out, y breakpoints, según la skill.
- **Stream caído:** indicador sutil y resincronización al reconectar; nunca presentar datos viejos como en vivo.
- **Refresco del activity log:** sin nuevo tipo de evento SSE en esta fase; refetch al enfocar la página o cuando llega un evento de servidor.
- **Tras confiar un fingerprint nuevo** (`ERROR → PENDING`): el estado PENDING ya ofrece "Connect" como única acción; no auto-conectar.
- **Botón Connect mientras hay un connect en curso:** deshabilitado; un 409 `ALREADY_CONNECTING` se trata como estado, no como error.
- **Capa de datos del cliente** (librería de fetching/cache, frontera server/client components), estructura de `packages/ui`, y si hay catálogo de componentes.
- **Validación en el sheet:** errores inline por campo desde `issues[].path`; `NAME_TAKEN` y `HOST_TAKEN` en su campo.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y requisitos
- `docs/roadmap-v0.1-v0.5.md` §3 (principios de diseño) y §6 (v0.1: Server Detail, E2E crítico §6.6, criterios de aceptación §6.7)
- `.planning/ROADMAP.md` — sección "Phase 5: UI web": goal y los 5 success criteria
- `.planning/REQUIREMENTS.md` — SERV-04, DETL-01, DETL-02, ACT-02, SET-01, UI-01, UI-02, DISC-02, QA-04, QA-05, y la tabla Out of Scope (sin búsqueda ni filtros en activity)
- `.planning/PROJECT.md` — Core Value, Constraints y Key Decisions (Next.js 16 como cliente delgado)

### Design system
- `.claude/skills/noodara-ux-apple/SKILL.md` — tokens, tipografía, layout de tres paneles, componentes, estados vacío/carga/error, copy, accesibilidad. **Leer antes de cualquier trabajo visual.**
- `.claude/skills/noodara-ux-review/SKILL.md` — auditoría obligatoria después de implementar UI
- `~/.claude/design-references/design-md/apple/DESIGN.md` — referencia base; `linear.app`, `vercel`, `raycast` en el mismo directorio para dashboards oscuros

### Contrato de la API que la UI consume
- `.planning/phases/04-http-routes-worker-bullmq-y-sse/04-CONTEXT.md` — D-01..D-07 (SSE), D-08..D-10 (connect/discover 202), D-16..D-22 (shapes, códigos, errores), D-29 (same-origin y guard de Origin)
- `apps/control-plane/src/routes/servers.ts` y `apps/control-plane/src/routes/server-schemas.ts` — las ocho rutas `/api/servers` y sus schemas Zod
- `apps/control-plane/src/services/server-view.ts` — `ServerView` y `SERVER_VIEW_KEYS` (allowlist de 27 campos)
- `apps/control-plane/src/routes/events.ts`, `apps/control-plane/src/events/sse-broadcaster.ts`, `apps/control-plane/src/events/server-event-publisher.ts` — stream SSE, allowlist de tipos, puerto de publicación (se amplían en D-05)
- `apps/control-plane/src/routes/activity.ts`, `apps/control-plane/src/routes/config.ts`, `apps/control-plane/src/routes/setup.ts`, `apps/control-plane/src/routes/sessions.ts`, `apps/control-plane/src/routes/http-errors.ts`

### Discovery y dominio
- `packages/domain/src/discovery/types.ts` — `DISCOVERY_CHECK_IDS` (once ids), `DiscoveryCheck { id, status, detail, durationMs }`, `DiscoveryCheckStatus`
- `packages/ssh/src/run-discovery.ts` — `DISCOVERY_SEQUENCE`; aquí entra el callback por check de D-05
- `apps/control-plane/src/services/connect-and-discover.ts` — dónde se publica hoy (tras TX1 y TX2)
- `.planning/phases/02-adaptador-ssh-aislado-y-probado-con-testcontainers/02-CONTEXT.md` — D-04..D-07 (fingerprint/TOFU), D-11..D-13 (advertencias y checks)
- `.planning/phases/03-servicios-de-aplicaci-n-activity-log-y-redacci-n/03-CONTEXT.md` — D-16 (seis acciones `server.*` y su metadata), D-12 (confirmación por nombre), D-19 (`ServerView`)
- `docs/domain/server-state-transitions.md` — estados y transiciones del Server
- `packages/domain/src/activity` — union de acciones (8 `auth.*` + 6 `server.*`) que D-14 convierte en frases

### Seguridad, calidad y runtime
- `.planning/phases/04-http-routes-worker-bullmq-y-sse/04-SECURITY.md` y `04-REVIEW.md` — amenazas abiertas y bypass de TOFU (D-17)
- `.claude/skills/noodara-security/SKILL.md` — checklist de fuga de secrets; aplica al nuevo evento, al nuevo endpoint y a toda salida de la UI
- `.claude/skills/noodara-tdd/SKILL.md` — RED → GREEN → REFACTOR, elección de tipo de test, Playwright
- `tests/integration/activity/canary-http.test.ts` y `tests/integration/routes/api-e2e.test.ts` — canary y E2E de API existentes que esta fase extiende
- `.github/workflows/ci.yml` — siete puertas actuales; aquí se añaden E2E y nightly
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` — contrato dev/build/start que `apps/web` debe respetar
- `docs/adr/0000-package-legitimacy-approvals.md` y `scripts/check-package-provenance.mjs` — toda dependencia nueva (next, react, tailwind, radix, playwright) pasa por esta puerta
- `.planning/research/STACK.md` — versiones fijadas (Next.js 16.3.4, React 19.3.0, Playwright 1.63.0) y la discusión Next vs. TanStack Start
- `.planning/research/FEATURES.md` y `.planning/research/PITFALLS.md` — narrativa de discovery y TOFU visible como diferenciadores

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **API completa de fase 4:** CRUD de servidores, trust-fingerprint, connect, discover, activity con cursor, config, sessions, setup/recovery, health y stream SSE. La UI no necesita lógica de negocio propia.
- **`ServerViewSchema` y los schemas Zod de rutas:** fuente de tipos para el cliente; evitar redeclarar shapes a mano.
- **`DISCOVERY_CHECK_IDS` y `DiscoveryCheck` en `packages/domain`:** puro y sin I/O, importable desde `apps/web` para el mapeo de seis pasos de D-06.
- **Fixtures de Testcontainers:** `tests/integration/helpers/` (Postgres, Redis, sshd 22.04/24.04, `worker-fixture.ts`, `boot-process.ts`) — base del E2E de Playwright.
- **`pnpm security:scan-leaks` y `canary-http.test.ts`:** base del job de QA-05.

### Established Patterns
- Monorepo pnpm + Turborepo con `boundaries`: `packages/domain` no importa nada con I/O. `turbo.json` exige declarar cada variable en `passThroughEnv`.
- Dependencias nuevas solo tras el gate de procedencia (ADR 0000).
- Las dependencias que los tests de raíz importan se promueven a devDependencies de la raíz (patrón repetido con `drizzle-orm`, `ioredis`, `zod`, `bullmq`).
- Resultados `{ ok, code, message }` y errores HTTP `{ error, message }`; un solo mapa código → status.
- macOS no tiene `timeout`; los scripts no deben depender de él.

### Integration Points
- `apps/web` (nuevo) proxya `/api/*` al API en `NOODARA_PUBLIC_URL`; `pnpm dev` debe arrancar api + worker + web.
- `packages/ui` (nuevo): `tokens.css` + preset de Tailwind + componentes sobre Radix.
- `runDiscovery` → callback por check → servicio → `ServerEventPublisher` → Redis pub/sub → `sse-broadcaster` (ampliar allowlist de tipos) → `EventSource` en el navegador.
- Nuevo endpoint de lectura de checks del último run, registrado dentro de `routes/api-scope.ts`.
- `package.json` raíz: `test:e2e` es hoy un placeholder que sale con 0; esta fase lo reemplaza.
- `.github/workflows/`: añadir E2E en `main` y un workflow nightly.

</code_context>

<specifics>
## Specific Ideas

- "Save and connect" como un solo gesto: igualar la facilidad de Coolify y Dokploy sin perder que Connect es una decisión explícita del admin.
- El aviso de primer trust y el banner de host key cambiada deben incluir el comando `ssh-keygen -lf` para que el admin verifique en su terminal sin traducir formatos.
- El checklist debe parecerse al de validación por servidor de Dokploy (pass/fail con detalle), pero honesto: ámbar para lo que no rompe, rojo solo para lo roto, y nunca progreso inventado.
- Los valores del detalle son "as of" el último discovery. Nadie debe leerlos como métricas en vivo (eso es v0.5).
- El activity log habla en frases y solo muestra claves que la UI conoce.
- Un servidor sano se ve CONNECTED aunque no haya sesión abierta; los errores de la infraestructura del usuario no se presentan como fallos de Noodara.

</specifics>

<deferred>
## Deferred Ideas

- **Historial de runs de discovery** (lista de snapshots anteriores con resultado, expandibles) — necesita un endpoint de listado; ningún requisito de v0.1 lo pide. Los snapshots ya se guardan.
- **Pantalla de sesiones activas en Settings** (listar, revocar una, "Sign out everywhere") — el backend existe; fuera de los diez requisitos de la fase.
- **Confirmación obligatoria del fingerprint en el primer connect** (estado "pending first trust") — considerada y no elegida; cambiaría la semántica TOFU de fase 3 y rompería "Save and connect".
- **Uso del inspector (tercer panel)** — cuando existan más entidades y el contexto lateral aporte (v0.2+).
- **Tipo de evento SSE para activity** — fase 4 D-01 ya lo anticipa; no en esta fase.
- **Configuración global editable** — ya diferida en fase 4; `GET /api/config` sigue read-only.
- **Cards o layout alterno para pocos servidores** — considerado y no elegido.

</deferred>

---

*Phase: 5-UI web*
*Context gathered: 2026-09-19*
