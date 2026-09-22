# Phase 1: Dominio, persistencia y autenticación - Context

**Gathered:** 2026-09-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Esta fase entrega la base sobre la que se construye todo v0.1: el scaffold del monorepo (pnpm + Turborepo, TypeScript 6.0 estricto, Node 22 LTS), el paquete `packages/domain` puro (entidad Server, state machine de conexión de 6 estados, validadores, cifrado de credenciales), el esquema PostgreSQL con migraciones Drizzle, la autenticación del único admin con Better Auth (bootstrap por setup token, login/logout, sesiones, rate limit), el arranque fail-fast sin secrets por defecto, y el pipeline de CI con umbrales de coverage.

Requisitos cubiertos: INST-06, AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, SERV-05, SEC-01, QA-01, QA-02, QA-06.

Fuera de esta fase: el adaptador SSH y el discovery (fase 2), los servicios de aplicación y el activity log como servicio (fase 3), rutas HTTP de servidores, worker y SSE (fase 4), toda la UI (fase 5), el instalador (fase 6). En esta fase el activity log existe solo como tabla y tipo de dominio porque AUTH-04 exige registrar logins fallidos; el servicio completo llega en fase 3.

</domain>

<decisions>
## Implementation Decisions

### Setup token y recuperación del admin
- **D-01:** En el primer arranque sin admin, el api genera un setup token aleatorio, persiste solo su hash en la base de datos y lo imprime en stdout. Mientras no exista admin, cada arranque vuelve a imprimirlo (regenerando si el anterior expiró). `docker compose logs api` es el canal; el instalador (fase 6) lo leerá de ahí.
- **D-02:** El token es de un solo uso y expira a las 24 h. Al crearse el admin, la ruta de setup deja de existir (responde 404, no 403).
- **D-03:** Recuperación de password sin email: comando CLI `noodara admin reset` (ejecutado con `docker compose exec api`) que emite un token de recuperación de un solo uso con la misma mecánica del setup token; con él se fija un password nuevo. Mismo modelo de datos para ambos tokens, con un campo `purpose` (`setup` | `recovery`).
- **D-04:** Pre-seed del admin por variables de entorno entra en esta fase: si `NOODARA_ADMIN_EMAIL` y `NOODARA_ADMIN_PASSWORD` están definidas y no existe admin, el control plane crea el admin al arrancar y omite el setup token. Si ya existe admin, las variables se ignoran y se loggea un aviso. Facilita E2E y el instalador.

### Sesión y bloqueo
- **D-05:** Sesión de 7 días deslizante con tope absoluto de 30 días desde el login. "Deslizante" significa que la actividad renueva la expiración, con una cadencia máxima de una renovación por día (`updateAge` = 1 día) para evitar escribir en DB en cada request; una sesión usada a diario nunca caduca antes del tope de 30 días. Configurable por env var pero con estos defaults. (Aclarado tras la revisión de planes, 2026-09-10.)
- **D-06:** Varias sesiones activas por admin. Esta fase entrega el modelo (tabla de sesiones con user agent, IP, created_at, last_seen_at) y los endpoints para listar sesiones y revocar una o todas las demás. La UI en Settings es fase 5.
- **D-07:** Login limitado a 5 fallos por ventana de 15 min, contados por IP y por cuenta de forma independiente. Cada bloqueo sucesivo duplica la espera (15 min → 30 → 60 → … hasta 24 h). Nunca hay bloqueo permanente: el admin siempre puede recuperar acceso esperando o con `noodara admin reset`. Los fallos se registran en el activity log sin el password.
- **D-08:** Cookies `HttpOnly`, `Secure`, `SameSite=Lax`, id rotado en cada login (ya fijado en REQUIREMENTS AUTH-05). `Secure` es obligatorio; en desarrollo local se usa un flag explícito de entorno para relajarlo, nunca por defecto.

### Master key
- **D-09:** La clave maestra vive en la variable de entorno `NOODARA_MASTER_KEY` (32 bytes, base64), generada por el instalador y escrita en `.env`. Un backup completo es volumen de datos + `.env`. No existe fallback a archivo ni valor por defecto; sin la variable el proceso no arranca (INST-06).
- **D-10:** Cada fila cifrada guarda `key_version`. El formato almacenado es `v<version>:<nonce_b64>:<ciphertext_b64>:<tag_b64>`.
- **D-11:** El comando `noodara secrets rotate` entra en esta fase: con `NOODARA_MASTER_KEY` (nueva) y `NOODARA_MASTER_KEY_PREVIOUS` (anterior) recifra todas las filas en una transacción e incrementa `key_version`. Al terminar, indica al usuario que puede retirar la variable previa.
- **D-12:** Al arrancar, el api loggea un aviso fijo: "Back up NOODARA_MASTER_KEY; credentials are unrecoverable without it", junto con el fingerprint (SHA-256 truncado) de la clave, nunca la clave. El mismo aviso y fingerprint se muestran en Settings (fase 5).

### Semántica de estados del servidor
- **D-13:** No existe acción "Disconnect" del admin en v0.1. Cada connect y discovery abre y cierra su propia sesión SSH; no hay conexiones persistentes. `DISCONNECTED` lo asigna solo el sistema y significa "estuvo CONNECTED y se cerró limpiamente".
- **D-14:** Editar un servidor CONNECTED: si cambian host o puerto, el servidor vuelve a `PENDING` y se borra el host fingerprint (la identidad del servidor cambió). Si cambian solo usuario SSH o credencial, pasa a `DISCONNECTED` y conserva el fingerprint. Los datos de discovery previos se conservan como historial en ambos casos.
- **D-15:** Un fallo por `HOST_KEY_CHANGED` deja el servidor en `ERROR` y guarda el fingerprint observado en `pending_fingerprint`. La re-confirmación es una acción explícita "Trust new fingerprint" que copia `pending_fingerprint` a `host_fingerprint` y vuelve a `PENDING`. Esta fase aporta la transición y el campo; el endpoint es fase 4 y la UI fase 5.
- **D-16:** La tabla de transiciones de la skill `noodara-domain-model` §2.1 es la fuente de verdad; las transiciones nuevas derivadas de D-14 y D-15 (`CONNECTED → PENDING` por edición de identidad, `ERROR → PENDING` por trust explícito) se añaden a esa tabla y a los tests de válidas e inválidas.

### Claude's Discretion
- Nombres del scaffold: seguir CLAUDE.md §3.1 (`apps/control-plane`, `apps/web`, `packages/domain`, `packages/ssh`, `packages/ui`, `packages/config`). Research usa `apps/api`; prevalece CLAUDE.md. `apps/control-plane` es una sola app con dos entrypoints (`api` y `worker`) que se empaquetan en la misma imagen y corren como contenedores separados (ARCHITECTURE.md).
- Política de password: mínimo 12 caracteres, sin reglas de composición, rechazo de passwords en lista de comunes. Sin expiración.
- Esquema del activity log en esta fase: tabla `activity_events` y tipo de dominio `ActivityEvent` según skill `noodara-domain-model` §7; solo se emiten eventos de auth (setup, login, login fallido, logout, sesión revocada, recovery). El servicio general es fase 3.
- Enforcement de "un solo admin": constraint a nivel de aplicación (Better Auth) más check en dominio; no se modela `role`.
- CI: GitHub Actions con workflow en `.github/workflows/ci.yml`. Se commitea aunque el repo todavía no se pushee. Integration ligera en PR usa Testcontainers con Postgres y Redis (los runners hospedados traen Docker).
- Tests de migración (QA-06): aplicar desde cero contra Postgres efímero y, a partir de la segunda migración, desde el snapshot anterior. En esta fase el "snapshot anterior" es la migración inicial.
- Convenciones de esquema: snake_case, UUIDv7 como PK, `created_at`/`updated_at` en todas las tablas, enums de estado como enum de Postgres.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y criterios de aceptación
- `docs/roadmap-v0.1-v0.5.md` §2 — TDD obligatorio, Definition of Done, pirámide de tests.
- `docs/roadmap-v0.1-v0.5.md` §6 — alcance v0.1, estados de servidor, seguridad (6.3), tests unitarios (6.4), criterios de aceptación (6.7).
- `.planning/REQUIREMENTS.md` — INST-06, AUTH-01..05, SERV-05, SEC-01, QA-01/02/06.
- `.planning/ROADMAP.md` — Phase 1 goal y success criteria.

### Reglas de ingeniería del repo (skills de proyecto)
- `CLAUDE.md` §2, §3 — principios, stack, estructura del monorepo, comandos objetivo.
- `.claude/skills/noodara-domain-model/SKILL.md` §1, §2, §7, §9, §10 — entidad Server, tabla de transiciones, ActivityEvent, migraciones.
- `.claude/skills/noodara-security/SKILL.md` §1, §2, §3, §5, §8 — branded types, cifrado, Redactor, sesiones y passwords, logging.
- `.claude/skills/noodara-tdd/SKILL.md` — ciclo RED/GREEN/REFACTOR, estructura de tests, Testcontainers, coverage.

### Research
- `.planning/research/STACK.md` — versiones exactas y rationale de Fastify 5, Drizzle, Better Auth, pino, argon2, TypeScript 6.0, Vitest 5, Testcontainers.
- `.planning/research/ARCHITECTURE.md` — boundaries de packages, api/worker split, decisiones a fijar en v0.1.
- `.planning/research/PITFALLS.md` — pitfalls 1 (secrets con fallback), 3 (pérdida de master key / key versioning), 10 (migraciones que rompen upgrades).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Ninguno: el repo solo contiene `LICENSE`, `.gitignore`, `CLAUDE.md` y `docs/`. Esta fase crea el scaffold.

### Established Patterns
- `CLAUDE.md` fija la estructura del monorepo, la pureza de `packages/domain` (sin I/O) y los comandos objetivo (`pnpm dev`, `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck`, `pnpm db:migrate`). El scaffold debe hacerlos reales.
- `.gitignore` excluye `CLAUDE.md` y `.claude/` por decisión del usuario; el scaffold no debe versionarlos ni depender de ellos en runtime.
- Commits en inglés, Conventional Commits, sin atribución a IA.

### Integration Points
- `packages/domain` será consumido por `packages/ssh` (fase 2), los servicios de aplicación (fase 3) y las rutas/worker (fase 4). Exportar tipos, validadores, state machine y utilidades de cifrado desde un índice estable.
- El esquema Drizzle de `Server` debe incluir desde ahora los campos que fases posteriores rellenan (`host_fingerprint`, `pending_fingerprint`, campos de discovery denormalizados, `last_seen_at`, `last_error_code`) para evitar migraciones de forma en fase 2 y 3.

</code_context>

<specifics>
## Specific Ideas

- Coolify y Dokploy imprimen la URL del panel al final del instalador; Noodara imprime además el setup token, siguiendo el mismo canal (stdout del contenedor).
- El flujo de reset por CLI reusa exactamente el mecanismo del setup token para no tener dos sistemas de tokens.
- El aviso de backup de la master key nace del pitfall del `APP_KEY` de Coolify ("MAC invalid" al restaurar sin la clave).

</specifics>

<deferred>
## Deferred Ideas

- Listado y revocación de sesiones en la pantalla Settings — fase 5 (UI); el modelo y los endpoints se entregan aquí.
- Endpoint `POST /servers/:id/trust-fingerprint` — fase 4; UI con fingerprint viejo y nuevo — fase 5.
- Aviso de backup de master key con fingerprint en Settings — fase 5.
- Lectura del setup token desde los logs por el instalador — fase 6.
- Acción manual "Disconnect" — descartada para v0.1; reconsiderar cuando existan conexiones persistentes o un agent.

</deferred>

---

*Phase: 01-dominio-persistencia-y-autenticacion*
*Context gathered: 2026-09-10*
