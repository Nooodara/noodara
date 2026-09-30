# Phase 11: Motor de deploy — fundamentos - Context

**Gathered:** 2026-09-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Todo lo que el motor de deploy necesita para construirse RED-first, probado contra infraestructura real antes del primer job (Fase 12): los cuatro spikes de QA-10 resueltos con evidencia y registrados como ADR; el dominio puro de Project/Environment/Service/Deployment (state machine de siete estados, `deriveServiceStatus`, validadores con tipos branded); la migración con la propiedad garantizada por la base de datos; las plantillas parametrizadas de la allowlist de `packages/ssh` y el exec en streaming; los paquetes `packages/git` y `packages/docker`; el fixture Testcontainers sshd+dockerd (22.04 y 24.04) con repo Git bare y registry con auth; y los tres fixtures oficiales `node-api`, `static-app`, `failing-build`.

Backend-only. Sin cola, worker, rutas HTTP, SSE ni UI (Fases 12 y 13). Requisitos: DEP-01, DEP-08, SVC-08, PROJ-04, QA-07, QA-10.

**Corrección al roadmap (hecho verificado en el repo):** la migración `0004` ya existe (`0004_phase9_user_preferences.sql`, Fase 9). La migración de esta fase es la **0005** y la prueba "aplica limpio desde el snapshot anterior" parte del snapshot **0004**, no del 0003. Donde el roadmap y REQUIREMENTS dicen "migración 0004" léase 0005.

</domain>

<decisions>
## Implementation Decisions

### Spikes y ADRs (G1–G4, G7)
- **D-01: Un solo ADR combinado, `docs/adr/0008-deploy-engine-empirical-contracts.md`**, con el formato de ADR-0004: una sección por spike (G1 transferencia de secretos, G2 kill remoto confirmado, G3 BuildKit activo, G4 estabilidad de `docker ps --format '{{json .}}'`), cada una con decisión, medición contra el fixture real en 22.04 y 24.04, tabla de alternativas rechazadas y fecha. Debe existir y estar en estado Accepted antes de que se escriba ningún plan de la Fase 12.
- **D-02: El código de cada spike se queda como contract test permanente** en `tests/integration/` (patrón de `tests/integration/ssh/contracts.test.ts`): falla si el comportamiento medido cambia con una nueva versión de OpenSSH o Docker. Nada de spikes desechables.
- **D-03: BuildKit ausente = check de discovery en `fail` que bloquea servicios de tipo Dockerfile.** Discovery gana un check "BuildKit" (junto a `docker_version`, mismo patrón de `packages/domain/src/discovery/docker-version.ts`: se detecta, no se infiere de la versión). Si falla, mensaje accionable y el backend rechaza crear servicios de tipo Dockerfile en ese servidor (la aplicación del rechazo es de la Fase 12; la fase 11 entrega el check y el hecho en el snapshot). Los servicios de tipo imagen no se bloquean. No se fuerza `DOCKER_BUILDKIT=1` desde la plantilla.
- **D-04: Fallback de G2: combinar candidatos.** Si ningún candidato por sí solo (`channel.signal()`, `setsid` + pidfile + `kill -- -pgid`, `docker kill` del contenedor de build) confirma el kill en ambas versiones, el primitivo de kill remoto ejecuta `setsid` + pidfile + `kill -- -pgid` **y además** `docker kill` del contenedor de build si sigue vivo, y solo devuelve éxito cuando el proceso está ausente en `ps`. Se acepta la complejidad extra a cambio de la garantía. El ADR registra qué candidatos funcionaron aislados.

### Vocabulario de validadores (SVC-08, DEP-08)
- **D-05: URL de repositorio: tres formas y nada más.** `https://host/path(.git)`, scp-like `git@host:path.git` (usuario `git` u otro nombre válido) y `ssh://user@host[:port]/path`. Se rechazan con error nombrado: `http://`, `git://`, `file://`, cualquier otro esquema, credenciales embebidas (`user:token@`), query string, fragmento, caracteres de shell, `..`, saltos de línea y espacios.
- **D-06: Hosts de Git: cualquier hostname público válido.** GitHub es la integración documentada primero (D6 de research), pero GitLab, Gitea, Bitbucket o self-hosted se aceptan igual. Se rechazan `localhost`, IPs literales privadas/loopback/link-local y nombres inválidos según las reglas de hostname. La comprobación es sintáctica sobre el literal (no se resuelve DNS en el validador).
- **D-07: Referencia de imagen: cualquier registry, tag o digest explícito obligatorio.** Se acepta `[registry[:port]/]repo[:tag]` o `@sha256:<64 hex>` en cualquier registry (Docker Hub, GHCR, propios). Lo prohibido es **omitir** el tag (`:latest` implícito); un `:latest` escrito por el usuario se acepta. Reglas de la referencia según la gramática de distribution/reference.
- **D-08: Rama: subconjunto estricto.** `[A-Za-z0-9._/-]`, longitud acotada, sin `..`, sin empezar por `-` o `/`, sin terminar en `/` o `.lock`, sin `//`, sin `@{`. Más estrecho que `git check-ref-format`; se documenta el subconjunto en el error.
- **D-09 (de research, se confirma):** el modelo no expone campos de build args ni env vars; punteros LFS y `.gitmodules` detectados tras el clone producen `UNSUPPORTED_REPOSITORY_FEATURE` (con detalle `lfs` / `submodules` en el mensaje, un solo código).

### Fixtures, registry y CI (QA-07, G7)
- **D-10: Registry local con autenticación.** Un contenedor `registry:2` con `htpasswd` en la red de Testcontainers, precargado al inicio de la corrida con las imágenes base de los fixtures. Ejerce un `docker pull` real y `docker login --password-stdin` sin red externa ni rate limits de Docker Hub. Sin GHCR en tests.
- **D-11: Matriz de Ubuntu: 24.04 en cada PR; 22.04 y 24.04 en push a `main` y en nightly.** Coherente con CLAUDE.md §7 (PR ligero, `main` completo).
- **D-12: La imagen sshd+dockerd extiende lo existente**: `tests/integration/images/installer-dind-*` (dockerd desde el repo apt de Docker, como lo provisiona `install.sh`) + `sshd-common` (sshd, usuarios, `setup-users.sh`). Así G3 mide el Docker real que instala Noodara. Contiene además un repositorio Git bare servido por SSH con deploy keys generadas por corrida (`packages/ssh/src/testing/generate-keys.ts`).
- **D-13: Fixtures oficiales**: `fixtures/node-api` sobre `node:22-alpine` y `fixtures/static-app` sobre `nginx:alpine`, ambas bases fijadas por digest y precargadas en el registry local; `fixtures/failing-build` falla en un `RUN` determinista (exit code fijo, mensaje reconocible para `classifyDockerError`). Todos con `.dockerignore` y un test que asierta contexto de build < 1 MiB.
- **D-14 (de CI existente, se mantiene):** ningún recurso con label `noodara.test=true` sobrevive a una corrida; el job `integration` de `ci.yml` ya lo comprueba.

### Esquema de credenciales (SVC-03/04 preparado; PROJ-04)
- **D-15: Los tipos de credencial de servicio entran en la migración 0005 de esta fase**, no en la 12: el fixture ya ejerce deploy keys y login de registry, y la cascada al borrar servicio necesita la relación desde el primer esquema.
- **D-16: Misma tabla `credentials`, enum `credential_type` ampliado** con `git_deploy_key`, `git_https_token` y `registry_password`. Mismo envelope AES-256-GCM, misma redacción, mismas rutas de borrado que `ssh_private_key`.
- **D-17: Enlace por dos FKs nullable en `services`**: `repository_credential_id` y `registry_credential_id`, ambas `ON DELETE RESTRICT`; el borrado del servicio elimina sus filas de `credentials` en la misma transacción, como hoy hace `servers.credential_id`.
- **D-18: La clave pública de la deploy key se guarda en claro** en una columna `public_key` de `credentials` (nullable, solo para `git_deploy_key`), para mostrarla al usuario sin descifrar nada. Solo la privada va cifrada.

### Decisiones de research que esta fase aplica sin reabrir
D4 (siete estados, columnas de v0.3 nullable), D5 (`deriveServiceStatus` pura + columna cacheada, `UNKNOWN` ≠ `STOPPED`), D6/D7 (deploy key primaria, token HTTPS vía askpass con archivo mode-600, registry por `--password-stdin`), D13, D14, D15–D18 (timeouts, `jobId`, índice parcial único, cancel, crash), D22 (superficie SSE, solo se definen los tipos aquí), D23 (`kind` texto libre), D26 (`packages/git`/`packages/docker` bajo el tag `ssh-adapter`). Ver `.planning/ROADMAP.md` "Decisions carried from research".

### Claude's Discretion
- Forma interna del exec en streaming (tamaño de chunk, tope de bytes, señal de abort, stdin) y los números por defecto de la tabla "Numbers That Are Reasoned Defaults" del research: se miden y se registran en la verificación de la fase, como en v0.1.
- Nombres deterministas de contenedor, red (`noodara-net-<serviceId>`), imagen (`noodara/<serviceId>:<deploymentId>`) y workspace (`/opt/noodara-deploy/<uuid>`): fijados por research; el formato exacto de los tipos branded lo decide el planner.
- Cómo el fixture expone el host del repo bare de forma que pase D-06 (p. ej. alias de red con hostname válido no-IP, no `localhost`); el validador no resuelve DNS, así que un alias de Testcontainers es aceptable.
- Nombre e id exactos del check de discovery de BuildKit y su lugar en el snapshot de discovery.
- Estructura de `packages/git` y `packages/docker` (thin wrappers tipados sobre las plantillas de `packages/ssh`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y decisiones de milestone
- `.planning/ROADMAP.md` — Fase 11 (goal, criterios de éxito 1–5) y tabla "Decisions carried from research" (D3–D27).
- `.planning/REQUIREMENTS.md` — DEP-01, DEP-08, SVC-08, PROJ-04, QA-07, QA-10 (esta fase); SVC-01..SVC-07, DEP-02..DEP-09, PROJ-01..PROJ-05 (contexto de lo que la Fase 12 construirá sobre este esquema).
- `.planning/research/SUMMARY.md` — §"Security Invariants", §"Numbers That Are Reasoned Defaults", §"Decisions Needed" (D1–D27), §"Gaps to Address" (G1–G9).
- `.planning/research/PITFALLS.md` y `.planning/research/ARCHITECTURE.md` — pitfalls de shell injection, cancel, cleanup y el diseño del motor.
- `docs/roadmap-v0.1-v0.5.md` — alcance v0.2 (fuente de verdad por encima de CLAUDE.md).

### Contratos empíricos y patrones a imitar
- `docs/adr/0004-ssh-adapter-empirical-contracts.md` — formato y rigor del ADR de spikes; el ADR 0008 lo replica.
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` — contrato de runtime; nuevos env knobs van a `env.ts` y `turbo.json` `passThroughEnv`.
- `docs/adr/0007-production-topology-and-installer.md` — cómo `install.sh` provisiona Docker (base de G3 y de la imagen del fixture).
- `tests/integration/ssh/contracts.test.ts` — patrón de contract test permanente para los spikes.

### Guías operativas del repo
- `CLAUDE.md` §2 (TDD, DoD, seguridad), §3.1 (estructura: `packages/git`, `packages/docker`, `fixtures/`), §4 (dominio).
- Skills `.claude/skills/noodara-tdd`, `noodara-security`, `noodara-domain-model` — obligatorias para cada plan de esta fase.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/ssh/src/commands/allowlist.ts` — `COMMAND_TEMPLATES` congelado + `escapeShellArg`; `allowlist.test.ts` es el guard de exactitud (hoy 11 entradas) que debe actualizarse con cada plantilla nueva.
- `packages/ssh/src/exec-with-timeout.ts`, `error-classifier.ts` — base para el exec en streaming y para `classifyGitError`/`classifyDockerError` (tablas congeladas, ordenadas, que nunca lanzan).
- `packages/domain/src/security/redactor.ts` — todo chunk de log pasa por aquí antes de persistencia, Redis, SSE o errores.
- `packages/domain/src/server/server-state.ts` (+ test) — patrón de state machine con tabla de transiciones exhaustiva que `deployment-state.ts` replica.
- `packages/domain/src/discovery/docker-version.ts` — patrón "detectar, no inferir" para el check de BuildKit.
- `packages/domain/src/validators/` (`identity.ts`, `network.ts`) — patrón de validadores con tipos branded y errores nombrados.
- `apps/control-plane/src/db/schema/credentials.ts`, `servers.ts` — envelope cifrado y patrón `credential_id` con borrado en la misma transacción.
- `tests/integration/images/installer-dind-*`, `sshd-*`, `helpers/installer-dind.ts`, `helpers/ssh.ts` — base de la imagen sshd+dockerd y de sus helpers.
- `packages/ssh/src/testing/generate-keys.ts` — deploy keys por corrida.

### Established Patterns
- Ningún template recibe un `string` crudo: validador de dominio → tipo branded → `escapeShellArg` → plantilla cerrada; `--` antes de posicionales.
- Migraciones Drizzle versionadas en `apps/control-plane/src/db/migrations/` con `meta/`; la siguiente es `0005`.
- `packages/domain` puro (boundary test `purity.test.ts`; `pnpm boundaries`); `packages/git`/`packages/docker` bajo el tag `ssh-adapter`.
- Testcontainers con label `noodara.test=true` y comprobación de huérfanos en CI.

### Integration Points
- `packages/ssh/src/commands/docker.ts` crece con las plantillas `docker.*`; nuevos módulos `git.ts` y `fs.ts` en el mismo directorio.
- Snapshot de discovery (`packages/domain/src/discovery/types.ts`, `merge-facts.ts`) gana el hecho de BuildKit.
- `apps/control-plane/src/db/schema/` gana `projects.ts`, `environments.ts`, `services.ts`, `deployments.ts`, `deployment-log-chunks.ts` y amplía `credentials.ts`.
- `.github/workflows/ci.yml` (job `integration`) y `nightly.yml` — matriz 22.04/24.04 por D-11.

</code_context>

<specifics>
## Specific Ideas

- El ADR 0008 debe leerse como el 0004: números medidos, tablas de alternativas rechazadas, sorpresas marcadas explícitamente.
- El error de BuildKit ausente debe decir qué hacer (instalar `docker-buildx-plugin` / activar BuildKit), no solo que falta.
- `failing-build` debe fallar de forma reconocible y estable para que el test de `classifyDockerError` sea determinista.

</specifics>

<deferred>
## Deferred Ideas

- Aplicación del bloqueo "sin BuildKit → no servicios Dockerfile" en la ruta de creación de servicios: Fase 12 (esta fase entrega el check y el hecho de discovery).
- GHCR real como registry de pruebas en nightly: descartado por ahora; reconsiderar si el registry local deja de representar al real.

</deferred>

---

*Phase: 11-motor-de-deploy-fundamentos*
*Context gathered: 2026-09-29*
