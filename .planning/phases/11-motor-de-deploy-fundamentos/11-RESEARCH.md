# Phase 11: Motor de deploy — fundamentos - Research

**Researched:** 2026-09-29
**Domain:** Empirical SSH/Docker/Git contracts, Drizzle schema with DB-enforced ownership, closed-allowlist remote execution, Testcontainers sshd+dockerd fixture
**Confidence:** MEDIUM-HIGH. HIGH donde se cita código real del repo o documentación oficial (Drizzle, install.sh, Docker apt-repo). MEDIUM en los cuatro spikes (G1-G4): esta fase existe precisamente para medirlos contra el fixture real — lo que sigue son candidatos y método de medición, no el resultado medido, que se registra en el ADR 0008 que la fase produce.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01**: Un solo ADR combinado `docs/adr/0008-deploy-engine-empirical-contracts.md`, formato de ADR-0004, una sección por spike (G1-G4), con decisión, medición 22.04/24.04, tabla de alternativas rechazadas, fecha. Debe existir y estar Accepted antes de cualquier plan de la Fase 12.
- **D-02**: El código de cada spike queda como contract test permanente en `tests/integration/` (patrón `tests/integration/ssh/contracts.test.ts`). Nada de spikes desechables.
- **D-03**: BuildKit ausente = check de discovery en `fail` que bloquea servicios Dockerfile (aplicación del rechazo en Fase 12; esta fase entrega el check y el hecho en el snapshot). Servicios de imagen no se bloquean. No se fuerza `DOCKER_BUILDKIT=1` desde la plantilla.
- **D-04**: Fallback de G2 — combinar candidatos: `setsid` + pidfile + `kill -- -pgid` **y además** `docker kill` del contenedor de build si sigue vivo; éxito solo cuando el proceso está ausente en `ps`.
- **D-05**: URL de repositorio — tres formas: `https://host/path(.git)`, scp-like `git@host:path.git`, `ssh://user@host[:port]/path`. Rechaza `http://`, `git://`, `file://`, otros esquemas, credenciales embebidas, query string, fragmento, caracteres de shell, `..`, saltos de línea, espacios.
- **D-06**: Hosts de Git — cualquier hostname público válido (GitHub primero documentado, pero GitLab/Gitea/Bitbucket/self-hosted aceptados). Rechaza `localhost`, IPs privadas/loopback/link-local literales, nombres inválidos. Comprobación sintáctica, sin DNS.
- **D-07**: Referencia de imagen — cualquier registry, tag o digest explícito obligatorio. `:latest` implícito prohibido; `:latest` escrito se acepta.
- **D-08**: Rama — subconjunto estricto `[A-Za-z0-9._/-]`, longitud acotada, sin `..`, sin empezar por `-`/`/`, sin terminar en `/`/`.lock`, sin `//`, sin `@{`.
- **D-09**: Sin campos de build args ni env vars en el modelo; LFS/`.gitmodules` → `UNSUPPORTED_REPOSITORY_FEATURE` (detalle `lfs`/`submodules`, un solo código).
- **D-10**: Registry local `registry:2` + htpasswd en red de Testcontainers, precargado al inicio; ejerce `docker pull` real y `docker login --password-stdin`. Sin GHCR en tests.
- **D-11**: Matriz Ubuntu: 24.04 en cada PR; 22.04 y 24.04 en push a `main` y nightly.
- **D-12**: Imagen sshd+dockerd extiende `installer-dind-*` + `sshd-common`. Repo Git bare por SSH, deploy keys por corrida.
- **D-13**: Fixtures oficiales: `node-api` sobre `node:22-alpine`, `static-app` sobre `nginx:alpine` (bases fijadas por digest, precargadas en registry local); `failing-build` falla en `RUN` determinista (exit code fijo, mensaje reconocible). Todos con `.dockerignore` y contexto < 1 MiB asertado.
- **D-14**: Ningún recurso `noodara.test=true` sobrevive a una corrida (ya comprobado por CI existente).
- **D-15**: Tipos de credencial de servicio entran en la migración **0005** de esta fase (no en la 12).
- **D-16**: Misma tabla `credentials`, enum `credential_type` ampliado con `git_deploy_key`, `git_https_token`, `registry_password`. Mismo envelope AES-256-GCM.
- **D-17**: Dos FKs nullable en `services`: `repository_credential_id`, `registry_credential_id`, `ON DELETE RESTRICT`; borrado del servicio elimina las filas de `credentials` en la misma transacción.
- **D-18**: `public_key` de la deploy key en claro en `credentials` (nullable, solo `git_deploy_key`); solo la privada cifrada.
- **Decisiones de research aplicadas sin reabrir**: D4 (siete estados), D5 (`deriveServiceStatus`), D6/D7 (deploy key primaria, askpass, registry `--password-stdin`), D13, D14, D15-D18 (timeouts, jobId, índice parcial único, cancel, crash), D22 (superficie SSE, solo tipos), D23 (`kind` texto libre), D26 (`ssh-adapter` tag).

### Claude's Discretion
- Forma interna del exec en streaming (tamaño de chunk, tope de bytes, señal de abort, stdin) y números por defecto de "Numbers That Are Reasoned Defaults" — se miden en verificación.
- Nombres deterministas de contenedor (`noodara-<serviceId>`), red (`noodara-net-<serviceId>`), imagen (`noodara/<serviceId>:<deploymentId>`) y workspace (`/opt/noodara-deploy/<uuid>`): fijados por research (ver nota de drift con la skill más abajo); formato exacto de tipos branded lo decide el planner.
- Cómo el fixture expone el host del repo bare cumpliendo D-06 (alias de red con hostname válido no-IP, no `localhost`; el validador no resuelve DNS).
- Nombre/id del check de discovery de BuildKit y su lugar en el snapshot.
- Estructura interna de `packages/git`/`packages/docker` (thin wrappers sobre plantillas de `packages/ssh`).

### Deferred Ideas (OUT OF SCOPE)
- Aplicación del bloqueo "sin BuildKit → no servicios Dockerfile" en creación de servicios: Fase 12.
- GHCR real en nightly: descartado por ahora.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DEP-01 | Deployment pasa por 7 estados con tabla de transiciones validada, forward-compatible con v0.3 | §"State Machine y Domain" — copiar `server-state.ts` verbatim; tabla de transiciones en §Architecture Patterns |
| DEP-08 | Sin build args/env vars en v0.2; LFS/submodules → `UNSUPPORTED_REPOSITORY_FEATURE` | §"Validadores de dominio" (D-05..D-09); §"Don't Hand-Roll" |
| SVC-08 | URL/rama/ruta/referencia de imagen validadas en `packages/domain`, pasadas solo por plantillas allowlist + `escapeShellArg` | §"Allowlist y plantillas parametrizadas"; §Code Examples |
| PROJ-04 | Propiedad jerárquica garantizada por la BD (FK compuesta) | §"Esquema y migración 0005" |
| QA-07 | Fixtures oficiales + fixture sshd+dockerd con pull real y auth de registry | §"Fixture Testcontainers sshd+dockerd" |
| QA-10 | Los cuatro spikes resueltos con evidencia antes de implementar el motor; números medidos y registrados | §"Spikes G1-G4" completo |
</phase_requirements>

## Summary

Esta fase no diseña nada nuevo: aplica patrones ya existentes en el repo (`server-state.ts`, `docker-version.ts`, `error-classifier.ts`, `allowlist.ts`) a cuatro dominios nuevos (Git, Docker build/run, kill remoto, registry auth) y resuelve, con evidencia medida contra infraestructura real, las cuatro preguntas que ninguna cantidad de razonamiento a priori puede cerrar: cómo llega un secreto al remoto sin argv (G1), cómo se mata un build remoto de forma confirmada (G2), si BuildKit está activo en el Docker que `install.sh` instala (G3 — la evidencia indirecta ya es fuerte: `install.sh` instala explícitamente `docker-buildx-plugin`, línea 519, así que el spike casi con certeza confirma BuildKit activo, pero el check de discovery debe **detectarlo**, no inferirlo de la presencia del paquete) y si el JSON de `docker ps` es estable entre 22.04 y 24.04 (G4).

**Primary recommendation:** ejecutar los cuatro spikes contra la imagen combinada sshd+dockerd (extendiendo `installer-dind-*` + `sshd-common`, D-12) usando el mismo estilo de `tests/integration/ssh/contracts.test.ts` (raw `ssh2.Client`/`@noodara/ssh/testing`, nunca un mock), escribir el ADR 0008 con el mismo rigor tabular que ADR 0004, y solo entonces escribir los plans que dependen de los resultados (allowlist, `exec-streaming.ts`, kill remoto). El resto de la fase — dominio, esquema, allowlist, fixtures — es aplicación disciplinada de patrones ya probados, no investigación.

**Nota de drift con la skill:** `.claude/skills/noodara-domain-model/SKILL.md` §3-4 (redactado antes de esta fase, para todo el arco v0.1-v0.5) documenta container `noodara-<project>-<environment>-<service>-<short_deployment_id>`, red `noodara-<project>-<environment>` y 10 estados de Deployment con `idempotency_key`/`rollback`. **Estas cifras están obsoletas para v0.2**: CONTEXT.md/ROADMAP (más recientes, más específicos, ya aceptados) fijan container `noodara-<serviceId>`, red `noodara-net-<serviceId>`, imagen `noodara/<serviceId>:<deploymentId>`, y exactamente 7 estados sin `idempotency_key` (D4, D11/D12, D-01..D-18 de este CONTEXT). El planner debe seguir CONTEXT.md/ROADMAP, no la skill, y debería incluir una tarea para actualizar la skill (`§3` naming, `§4` estados) al final de la fase — deuda de documentación, no ambigüedad de producto.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Deployment state machine, `deriveServiceStatus`, validadores de vocabulario | Domain (puro) | — | `packages/domain` sin I/O; única fuente de verdad de transiciones y vocabulario cerrado (CLAUDE.md §4) |
| Detección BuildKit / estabilidad `docker ps` | Domain (parsers puros) + SSH (ejecución) | — | patrón "detectar, no inferir" de `docker-version.ts`; el parser vive en domain, la ejecución en `packages/ssh` |
| Transferencia de secretos, kill remoto, plantillas git/docker | Remote execution (`packages/ssh`, `packages/git`, `packages/docker`) | — | única capa que habla con el shell remoto; allowlist cerrada |
| Esquema y FK compuesta / índice parcial | Persistencia (`apps/control-plane/src/db/schema`) | — | la propiedad jerárquica y la concurrencia se garantizan en Postgres, no en código de servicio |
| Fixtures y contract tests | Test infra (`tests/integration`) | — | precede al primer test de operaciones Docker (Pitfall 12) |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ssh2` | `1.17.0` (ya instalado) | ejecución remota, `channel.signal()` para G2 | ya auditado en `packages/ssh`; no se añade nada nuevo |
| `drizzle-orm` + `drizzle-kit` | ya instalados (verificar versión con `npm view` antes de escribir plans) | migración 0005, composite FK, índice parcial, enum ampliado | ya el ORM del proyecto; sin alternativa |
| `registry:2` (imagen Docker, no paquete npm) | `2` (tag oficial Distribution) | registry local con htpasswd en Testcontainers | D-10; oficial, sin dependencia externa |

**Version verification:**
```bash
npm view drizzle-orm version
npm view drizzle-kit version
npm view ssh2 version
```
Ejecutar antes de fijar versiones exactas en los plans — no asumir las versiones citadas en `.planning/research/SUMMARY.md` (fecha 2026-09-22) sin reconfirmar, dado que este research es 7 días posterior.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| ninguna nueva | — | — | Esta fase no instala paquetes npm nuevos: todo es CLI remoto (`git`, `docker`) tras SSH, o infraestructura de test (`registry:2`, imágenes Testcontainers propias) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `channel.signal()` + `setsid`/`kill -pgid` + `docker kill` combinados (D-04) | Solo `channel.signal('INT')` | Más simple pero D-04 ya decidió combinar por falta de garantía en un único candidato — no reabrir |
| Registry local `registry:2`+htpasswd (D-10) | GHCR real en CI | Depende de red/token, rate limits; descartado explícitamente (deferred) |
| `pgEnum` ampliado para `credential_type` (D-16) | Tabla `service_credentials` nueva | Duplica cifrado/cascada; descartado en discuss-phase |

## Package Legitimacy Audit

No se instala ningún paquete npm nuevo en esta fase (todo el trabajo es CLI remoto sobre `ssh2` ya auditado, o imágenes Docker de test). `registry:2` es una imagen Docker oficial de Distribution/Docker Inc., no un paquete de npm/PyPI/crates — no aplica slopcheck. Si drizzle-kit/drizzle-orm requieren un bump de versión menor durante la implementación, verificar con `npm view <pkg> version` y `npm view <pkg> scripts.postinstall` antes de aceptar el bump; ninguno de los dos ha mostrado nunca un postinstall sospechoso en versiones anteriores de este repo.

**Packages removed due to slopcheck [SLOP] verdict:** ninguno (nada nuevo instalado).
**Packages flagged as suspicious [SUS]:** ninguno.

## Architecture Patterns

### System Architecture Diagram

```text
Domain validators (packages/domain)              Remote execution (packages/ssh, git, docker)
──────────────────────────────────               ────────────────────────────────────────────
RepositoryUrl/GitRef/ImageRef/                    escapeShellArg (existe)
DeployWorkspacePath (branded)     ──validate──►   commandFor(name) closed allowlist
        │                                                │
        ▼                                                ▼
deployment-state.ts (7 estados)                  git.clone/checkout, docker.build/pull/
        │                                        login/create/start/stop/restart/remove/
        ▼                                        inspect/logs/ps, fs.remove_deploy_dir,
deriveServiceStatus() puro                        remote kill primitive (G2)
        │                                                │
        ▼                                                ▼
Schema (apps/control-plane/src/db/schema)          exec-streaming.ts (nuevo, junto a
projects/environments/services/deployments/        exec-with-timeout.ts): stdin, chunks
credentials(enum ampliado)                         redactados, bounded bytes, AbortSignal
        │  composite FK (environment_id,                │
        │  project_id); partial unique idx              ▼
        ▼  on deployments(service_id)              classifyGitError/classifyDockerError
migration 0005                                      (tablas congeladas, nunca lanzan)
                                                          │
                                                          ▼
                                          Test infra: sshd+dockerd Testcontainers
                                          (extiende installer-dind-* + sshd-common)
                                          + bare Git repo por SSH + registry:2/htpasswd
                                          + fixtures node-api/static-app/failing-build
                                                          │
                                                          ▼
                                          Contract tests permanentes (D-02) +
                                          docs/adr/0008 (G1-G4, Accepted)
```

Un lector traza el camino: un valor crudo entra por un validador de dominio → tipo branded → `escapeShellArg` → plantilla cerrada de la allowlist → ejecución vía `exec-streaming.ts` (redactada por chunk) → clasificación de error si algo falla → todo probado contra el fixture real, nunca contra un mock del shell remoto.

### Recommended Project Structure

```
packages/domain/src/
├── deployment/
│   ├── deployment-state.ts       # copia server-state.ts línea por línea
│   └── deployment-state.test.ts  # exhaustivo, ≥95% branch
├── service/
│   └── derive-service-status.ts  # función pura, no FSM
├── validators/
│   ├── git.ts                    # RepositoryUrl, GitRef (branch), host allowlist D-06
│   ├── docker-naming.ts          # ImageRef, ContainerName, workspace path
│   └── git.test.ts / docker-naming.test.ts
└── discovery/
    └── buildkit.ts                # parseBuildKitStatus() puro, "detectar no inferir"

packages/ssh/src/
├── commands/
│   ├── git.ts                    # git.clone, git.checkout (funciones, no strings frozen)
│   ├── docker.ts                 # crece: docker.build/pull/create/start/stop/restart/
│   │                             #   remove/inspect/logs/ps
│   ├── fs.ts                     # fs.remove_deploy_dir
│   └── kill.ts                   # remote-kill primitive (G2)
├── exec-streaming.ts             # sibling de exec-with-timeout.ts
└── testing/
    └── generate-deploy-keys.ts    # nuevo, análogo a generate-keys.ts pero por-corrida

packages/git/src/                  # nuevo paquete, tag ssh-adapter
packages/docker/src/               # nuevo paquete, tag ssh-adapter

apps/control-plane/src/db/
├── schema/{projects,environments,services,deployments,deployment-log-chunks}.ts
└── migrations/0005_*.sql

tests/integration/images/
├── sshd-dockerd-ubuntu-22.04/     # nuevo, extiende sshd-common + instalación Docker real
├── sshd-dockerd-ubuntu-24.04/
└── registry-htpasswd/             # setup registry:2 + htpasswd para Testcontainers

tests/integration/deploy-engine/
├── contracts.test.ts              # G1-G4 permanentes (D-02)
└── fixtures/                      # capturas reales de docker ps json 22.04/24.04

fixtures/{node-api,static-app,failing-build}/
docs/adr/0008-deploy-engine-empirical-contracts.md
```

### Pattern: State machine (copiar `server-state.ts`)
**What:** `DEPLOYMENT_STATUSES` tupla congelada, `TRANSITIONS` record congelado, `transition()` única función que produce un nuevo estado, `InvalidTransitionError`.
**When to use:** `deployment-state.ts` completo.
**Example:**
```ts
// Source: packages/domain/src/server/server-state.ts (patrón exacto, adaptado)
export const DEPLOYMENT_STATUSES = [
  'QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING', 'SUCCESS', 'FAILED', 'CANCELLED',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

const TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = Object.freeze({
  QUEUED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['DEPLOYING', 'FAILED', 'CANCELLED'],
  DEPLOYING: ['SUCCESS', 'FAILED', 'CANCELLED'],
  SUCCESS: [],
  FAILED: [],
  CANCELLED: [],
});
```
No hay ciclos (a diferencia de `ServerStatus`): un Deployment es un intento append-only, un redeploy siempre crea una fila nueva. `ALTER TYPE ... ADD VALUE` de v0.3 (`HEALTHCHECK`, `ROLLING_BACK`, `ROLLED_BACK`) queda fuera de esta fase — no crear esos valores ahora (evita estados muertos, CLAUDE.md §1).

### Pattern: "detectar, no inferir" para BuildKit (copiar `docker-version.ts`)
**What:** un parser puro que devuelve una unión discriminada de 3-4 variantes, nunca un booleano.
**When to use:** nuevo check de discovery `buildkit` (nombre/id exacto a discreción del planner, p. ej. `docker_buildkit`).
**Candidatos de comando a medir en el spike G3** (elegir el que produzca la señal más estable, medir ambos):
- `docker buildx version` — exit 0 + una línea con `github.com/docker/buildx` si el plugin está presente; exit 127/"unknown command" si no. Mide la **presencia del plugin**, no si BuildKit es el builder activo.
- `docker info --format '{{json .}}'` — el campo `ClientInfo.Plugins` (array con `{Name: "buildx", ...}`) confirma el plugin; en Docker 23+ con `docker-buildx-plugin` instalado, BuildKit es el builder por defecto salvo que `DOCKER_BUILDKIT=0` esté en el entorno del daemon — verificar explícitamente que ninguna plantilla ni el propio Docker Engine que `install.sh` instala fija esa variable (grep en `install.sh` no la encontró en la lectura de esta fase; confirmarlo de nuevo en el spike).
`install.sh` línea 518-519 instala `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin` — el plugin **está presente** en el Docker que Noodara provisiona; el spike confirma que además es el builder activo por defecto (`docker build` sin flags usa BuildKit), no solo que el plugin existe.
```ts
// Patrón nuevo, packages/domain/src/discovery/buildkit.ts — mismo estilo que docker-version.ts
export type BuildKitStatus =
  | { readonly kind: 'active' }
  | { readonly kind: 'plugin_missing' }
  | { readonly kind: 'unparseable'; readonly reason: string };
```

### Pattern: allowlist con plantillas parametrizadas y validador antes de `escapeShellArg`
**What:** cada template nuevo es una función, no una constante congelada; el argumento ya llegó como tipo branded.
**Example:**
```ts
// Source: packages/ssh/src/commands/allowlist.ts (escapeShellArg ya existe, sin uso en producción hoy)
// packages/ssh/src/commands/git.ts (nuevo)
import { escapeShellArg } from './allowlist.js';
import type { RepositoryUrl, GitRef, DeployWorkspacePath } from '@noodara/domain/validators';

export function gitClone(url: RepositoryUrl, ref: GitRef, targetDir: DeployWorkspacePath): string {
  return `git clone --depth 1 --branch ${escapeShellArg(ref)} -- ${escapeShellArg(url)} ${escapeShellArg(targetDir)}`;
}
```
`CommandName`'s union (`packages/ssh/src/commands/index.ts`) crece con los nombres nuevos; `allowlist.test.ts` (hoy exactitud de 11 entradas) debe actualizarse en el mismo plan que añade cada plantilla — nunca en un plan posterior.

### Pattern: transferencia de secretos sin argv (G1)
**Candidatos a medir contra el fixture:**
1. **stdin a un comando allowlisted**: `umask 077 && cat > <DeployWorkspacePath>/.cred` con el contenido del secreto pasado por `channel.exec()` + `channel.write(secret)` + `channel.end()` — requiere que `exec-streaming.ts` soporte escritura a stdin, no solo lectura de stdout/stderr.
2. **SFTP subsystem de `ssh2`** (`client.sftp()` → `createWriteStream` con `{ mode: 0o600 }`) — evita construir un comando shell para la escritura, pero abre un segundo canal/subsistema que `packages/ssh` hoy no usa en ningún lugar (mutex y timeouts existentes están pensados para `exec`, no para SFTP).
**Medir:** ¿el contenido llega íntegro (bytes exactos, sin corrupción de líneas nuevas) por ambos caminos en 22.04 y 24.04? ¿el permiso `0600` se aplica atómicamente (sin ventana donde el archivo es legible por otros)? ¿alguno de los dos deja el secreto en `ps aux` en algún punto (no debería, en ninguno de los dos, dado que el contenido nunca es un argumento)? El ADR debe registrar cuál se elige y por qué, con evidencia — D-06/D-07 del research ya recomiendan candidato 1 (stdin a `cat`) porque no añade un segundo subsistema; el spike confirma que no tiene defectos ocultos antes de fijarlo.

### Pattern: kill remoto confirmado (G2)
**Candidatos, en el orden que D-04 ya fija como fallback combinado:**
1. `channel.signal('INT')` (o `'TERM'`) — ssh2 client-side ya soporta el método; **la pregunta real es si el sshd remoto actúa sobre la señal para un proceso `exec` sin pty** (no un `shell` interactivo). La literatura pública no confirma esto de forma concluyente para sesiones `exec` sin pty en OpenSSH — el spike debe probarlo directamente: lanzar un proceso remoto de larga duración (`sleep 300` o el propio `docker build` de `fixtures/failing-build` con un `RUN sleep`), enviar `signal('INT')`, y verificar con `ps aux` en el fixture si el PID desapareció.
2. `setsid` + pidfile + `kill -- -<pgid>`: lanzar el comando remoto envuelto en `setsid sh -c 'echo $$ > <pidfile>; exec <comando>'`, luego un comando allowlisted separado lee el pidfile y ejecuta `kill -- -<pgid>` — daemon-agnóstico, no depende de que sshd reenvíe señales.
3. `docker kill <build-container>` — solo aplica al contenedor de build de BuildKit (BuildKit v0.11+ ejecuta cada build en un contenedor efímero visible en `docker ps`), no mata un `git clone` colgado.
**D-04 ya decidió:** ejecutar 2 siempre, y además 3 si el contenedor de build sigue vivo tras 2; el spike mide si 1 solo también funciona (para simplificar en el futuro) pero el mecanismo final es el combinado, no el más simple que funcione aislado.
**Evidencia exigida:** el test de integración confirma con `ps aux` en el remoto que el PID (o su grupo) está ausente — nunca solo que la promesa local rechazó.

### Pattern: estabilidad de `docker ps --format '{{json .}}'` (G4)
**Riesgo medido en fuentes externas (MEDIUM confidence, no repo-native):** el campo `Size` es costoso de calcular y ha causado lentitud/timeouts reportados en `docker/for-linux#1179`; **evitar pedir `.Size` en el template** — el parser del reconciliador solo necesita `Names`, `Image`, `State`/`Status`, `Ports`, `CreatedAt`. `moby/moby#46906` reporta que el output de `docker ps --format json` no es JSON válido en algún caso extremo (posiblemente streams multi-línea, no un único objeto por línea) — el parser debe tratar cada línea como un JSON independiente y nunca asumir que la salida completa es un único array.
**Medir contra el fixture:** capturar la salida real de `docker ps --all --format '{{json .}}'` en ambas versiones de Ubuntu con al menos un contenedor `running`, uno `exited` con código no-cero, y uno `created` sin arrancar — guardar las capturas en `packages/domain/src/discovery/fixtures/` (mismo patrón que ADR 0004 documenta para `docker version`) y escribir el parser contra esas capturas, nunca contra texto inventado.

### Anti-Patterns to Avoid
- **Inferir BuildKit de la presencia del paquete sin ejecutar el comando**: D-03 exige detectar, no inferir — el paquete puede estar instalado y `DOCKER_BUILDKIT=0` seguir activo en el entorno.
- **Un solo candidato de kill sin fallback**: D-04 ya cerró esta discusión — no simplificar a un único mecanismo aunque el spike lo muestre suficiente en el fixture; el fixture no es el peor caso de producción.
- **Parsear `docker ps` como si toda la salida fuera un único JSON array**: es NDJSON (un objeto por línea), no un array.
- **Poner el secreto en la línea de comando de `docker login`/`git clone`**: siempre `--password-stdin` o archivo mode-600 vía G1, nunca argv.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cifrado/redacción de credenciales de servicio | un segundo mecanismo de cifrado para `git_deploy_key`/`git_https_token`/`registry_password` | el mismo envelope AES-256-GCM + `Redactor` que `ssh_private_key` ya usa (D-16) | duplicar cifrado es la vía cara que PITFALLS #9 advierte explícitamente |
| Parseo de `docker ps` con regex ad-hoc | un parser de texto libre | `JSON.parse` línea por línea sobre `--format '{{json .}}'`, nunca `--format` de texto | disciplina ya fijada en `docker.ts`: "Structured output only... never free-text parsing" |
| Quoting de argumentos de shell | una función de escaping nueva | `escapeShellArg` ya exportado en `allowlist.ts` | ya existe, ya está pensado para este día exacto |
| Clasificación de errores de Git/Docker | un `if/else` disperso en el servicio de deploy | `classifyGitError`/`classifyDockerError` como tablas congeladas, mismo patrón que `classifySshError` | tablas ordenadas, nunca lanzan, exhaustividad testeada — replicar `error-classifier.ts` línea por línea |

**Key insight:** todo lo "nuevo" de esta fase es la aplicación literal de un patrón que ya existe en v0.1 a un dominio nuevo. El riesgo no es inventar mal un patrón — es no encontrar el patrón existente y reinventarlo peor.

## Common Pitfalls

### Pitfall 1: `docker ps --format '{{json .}}'` con el campo `Size`
**What goes wrong:** el comando se vuelve lento o falla en hosts con mucho churn de archivos temporales si el template pide `.Size` (o si el CLI decide calcular el tamaño para cualquier motivo).
**Why it happens:** calcular el tamaño de un contenedor implica recorrer su filesystem de overlay.
**How to avoid:** el template `docker.ps` nunca incluye `.Size` en el formato JSON explícito de campos (o, si se usa `{{json .}}` sin especificar campos, medir explícitamente en el spike G4 si el daemon de ambas versiones de Ubuntu calcula `Size` por defecto o solo con `-s`; documentarlo en el ADR).
**Warning signs:** el exec de reconciliación excede su timeout solo en servidores con muchos contenedores/mucho I/O.
**Fuente:** `github.com/docker/for-linux/issues/1179` (MEDIUM confidence, verificar en el spike si aplica a la versión de Docker que `install.sh` instala).

### Pitfall 2: Confundir "el plugin buildx está instalado" con "BuildKit es el builder activo"
**What goes wrong:** el check de discovery pasa (plugin presente) pero un `DOCKER_BUILDKIT=0` en el entorno del daemon (o una configuración `/etc/docker/daemon.json` con `features.buildkit: false` en versiones antiguas) hace que `docker build` real siga usando el builder legacy.
**Why it happens:** dos preguntas distintas ("¿existe el plugin?" vs "¿qué builder se usa por defecto?") se colapsan en una.
**How to avoid:** D-03 ya lo previene exigiendo "se detecta, no se infiere" — el spike debe ejecutar un `docker build` real (no solo `docker buildx version`) contra un Dockerfile trivial y observar si el output tiene la forma de progreso de BuildKit (líneas `#1 [internal] load build definition`) o la forma legacy (`Step 1/N`).
**Warning signs:** el check pasa pero el primer build real de la Fase 12 usa el builder legacy sin que nadie lo note hasta que `--mount=type=secret` (futuro v0.4) falle.

### Pitfall 3: `ALTER TYPE credential_type ADD VALUE` combinado con uso del valor nuevo en la misma migración
**What goes wrong:** Postgres permite `ALTER TYPE ... ADD VALUE` dentro de una transacción desde la versión 12, pero el valor nuevo **no puede usarse** (en un `INSERT`, un `DEFAULT`, o un `CHECK`) dentro de la misma transacción en la que se añadió.
**Why it happens:** el catálogo de tipos no se recarga hasta que la transacción que lo modificó confirma (`COMMIT`).
**How to avoid:** la migración 0005 solo ejecuta los `ALTER TYPE ... ADD VALUE` y crea las columnas/tablas nuevas — ningún seed ni dato de prueba que use `git_deploy_key`/`git_https_token`/`registry_password` puede insertarse en el mismo archivo de migración. Confirmar cómo `drizzle-kit migrate` envuelve (o no) cada archivo `.sql` en una transacción antes de escribir el plan — si el runner de Drizzle usa una transacción por archivo, este orden basta; si agrupa varios archivos en una sola transacción, verificar que ningún archivo posterior en el mismo lote usa el valor nuevo.
**Warning signs:** `ERROR: unsafe use of new value "git_deploy_key" of enum type credential_type` — mensaje literal de Postgres, inequívoco.

### Pitfall 4: Reusar `generate-keys.ts` para las deploy keys del fixture
**What goes wrong:** `packages/ssh/src/testing/generate-keys.ts` genera un conjunto fijo de tipos de clave (ed25519, ecdsa, rsa3072, rsa1024, dsa, con/sin passphrase) pensado para probar el **parser** de claves — no está pensado para generarse "por corrida" con un nombre asociado a un deployment/servicio de test, ni para instalarse como `authorized_keys` del lado del repo bare.
**Why it happens:** el nombre y la carpeta `testing/` sugieren reutilización directa.
**How to avoid:** escribir una función nueva y más pequeña (p. ej. `generate-deploy-keys.ts`) que solo genera un par ed25519 por llamada y lo instala en el `authorized_keys` del contenedor del repo bare — no reabrir ni ampliar `generate-keys.ts`, que sigue siendo solo para `key-loader.test.ts`/`fingerprint.test.ts`.
**Warning signs:** un cambio en `generate-keys.ts` rompe silenciosamente un test de parsing de claves no relacionado con el fixture de deploy.

### Pitfall 5: Migrar container/network naming sin actualizar la skill
**What goes wrong:** el planner sigue correctamente CONTEXT.md (`noodara-<serviceId>`, `noodara-net-<serviceId>`) pero `.claude/skills/noodara-domain-model/SKILL.md` sigue documentando el naming antiguo (`noodara-<project>-<environment>-<service>-<short_deployment_id>`) — un futuro planner o revisor que consulte la skill (que la carga el propio harness antes de cada fase de dominio) implementará el naming equivocado en una fase posterior.
**How to avoid:** incluir en los plans de esta fase una tarea de actualización de la skill (§3 naming, §4 estados de Deployment — reducir de 10 a 7 con nota "v0.3 amplía") una vez el naming/estado final quede fijado por el código, no antes.
**Warning signs:** un grep de `noodara-<project>-<environment>` en `packages/domain`/`apps/control-plane` después de esta fase seguiría encontrando solo la skill, nunca código — señal de que la actualización de la skill quedó pendiente.

## Code Examples

### Enum ampliado y FKs nullable con `ON DELETE RESTRICT` (D-16/D-17)
```ts
// Source: patrón de apps/control-plane/src/db/schema/credentials.ts, extendido
export const credentialTypeEnum = pgEnum('credential_type', [
  'ssh_private_key', 'ssh_password',
  'git_deploy_key', 'git_https_token', 'registry_password',
]);

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  type: credentialTypeEnum('type').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  publicKey: text('public_key'), // D-18: solo para git_deploy_key, en claro
  keyVersion: integer('key_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// en services.ts
repositoryCredentialId: uuid('repository_credential_id').references(() => credentials.id, { onDelete: 'restrict' }),
registryCredentialId: uuid('registry_credential_id').references(() => credentials.id, { onDelete: 'restrict' }),
```
El borrado del servicio debe, en la misma transacción, eliminar sus filas de `credentials` **antes** de eliminar el servicio (mismo orden que `servers.credential_id`) — con `ON DELETE RESTRICT` la base de datos rechaza borrar el servicio primero, forzando ese orden a nivel de código, no solo de disciplina.

### FK compuesta para ownership jerárquico (PROJ-04)
```ts
// Source: Drizzle docs (multi-column foreignKey operator), adaptado a Postgres
import { foreignKey, unique } from 'drizzle-orm/pg-core';

export const environments = pgTable('environments', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('development'), // D-23: texto libre, no enum
  // ...
}, (table) => [
  unique('environments_id_project_id_unique').on(table.id, table.projectId), // requerido para que la FK compuesta hija pueda referenciarlo
]);

export const services = pgTable('services', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  projectId: uuid('project_id').notNull(), // denormalizado
  environmentId: uuid('environment_id').notNull(),
  // ...
}, (table) => [
  foreignKey({
    columns: [table.environmentId, table.projectId],
    foreignColumns: [environments.id, environments.projectId],
    name: 'services_environment_project_fk',
  }),
]);
```
Postgres exige que `(id, project_id)` en `environments` tenga una restricción UNIQUE (no solo el PK sobre `id`) antes de que una FK compuesta pueda referenciarla — verificar que `drizzle-kit generate` produce ambos statements (`UNIQUE` y luego `FOREIGN KEY`) en el orden correcto dentro de `0005_*.sql`.

### Índice parcial único para concurrencia (D16 del research, aplicado en esquema)
```ts
import { sql } from 'drizzle-orm';
import { uniqueIndex } from 'drizzle-orm/pg-core';

// en deployments.ts
}, (table) => [
  uniqueIndex('deployments_service_active_unique_idx')
    .on(table.serviceId)
    .where(sql`${table.status} IN ('QUEUED','PREPARING','BUILDING','DEPLOYING')`),
]);
```

### Test de migración limpio + desde snapshot (patrón ya existente en el repo)
Verificar el archivo de test de migraciones existente (probablemente en `tests/integration/db/` o similar — localizar durante el planning) que ya prueba "aplica limpio desde 0000" y "aplica desde el snapshot anterior" para 0004; extender/clonar ese mismo test para que además pruebe desde el snapshot **0004** hacia 0005 (CONTEXT.md ya corrige: el snapshot base es 0004, no 0003).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Docker builder legacy por defecto | BuildKit por defecto desde Docker Engine 23.0 (2023) cuando `docker-buildx-plugin` está instalado | 2023 | `install.sh` ya instala el plugin (línea 519); el spike G3 confirma que el default efectivamente usa BuildKit en el Docker que Noodara provisiona, no solo que el plugin existe |
| `docker-compose` standalone v1 | `docker compose` plugin v2 | ya migrado en este repo (`docker.ts` header comment) | sin impacto nuevo en esta fase, ya establecido |

**Deprecated/outdated:** ninguna dependencia de esta fase está deprecada; `ssh2@1.17.0` y Drizzle son las versiones ya en uso.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `channel.signal('INT')` de `ssh2` puede no ser honrado por sshd para una sesión `exec` sin pty en OpenSSH 8.9/9.6 — la literatura pública no lo confirma de forma concluyente | §Architecture Patterns, "kill remoto confirmado (G2)" | Si el spike muestra que sí funciona aislado, el mecanismo combinado de D-04 sigue siendo correcto (ya decidido), solo sobra complejidad — riesgo bajo. Si el spike no lo mide y el planner asume que funciona, un plan podría depender de un candidato no probado |
| A2 | El daemon Docker que `install.sh` instala usa BuildKit como builder por defecto sin ninguna variable de entorno que lo desactive | §Summary, §State of the Art | Si `install.sh` o el entorno de producción fijan `DOCKER_BUILDKIT=0` en algún lugar no revisado en esta sesión, el check de discovery daría un falso positivo — mitigado porque D-03 exige "detectar, no inferir": el spike debe ejecutar un build real, no solo comprobar el plugin |
| A3 | El campo `Size` de `docker ps --format json` no se calcula por defecto sin `-s`/`--size` explícito, para ambas versiones de Docker instaladas en 22.04/24.04 | §Common Pitfalls #1 | Si se calcula por defecto en alguna versión, el reconciliador (Fase 12) heredaría el problema de lentitud; el spike G4 debe capturarlo explícitamente comparando con/sin `-s` |
| A4 | `drizzle-kit`'s migration runner ejecuta cada archivo `.sql` en su propia transacción (no agrupa varios archivos en una transacción compartida) | §Common Pitfalls #3 | Si agrupa, un futuro archivo de migración que use `git_deploy_key` en un `INSERT` en el mismo lote fallaría con el error de Postgres citado — verificar la versión real de `drizzle-kit` instalada antes de escribir el plan de migración |
| A5 | Las versiones de `docker-ce`/`docker-buildx-plugin`/`docker-compose-plugin` en el repo apt de Docker son idénticas (o suficientemente cercanas) para 22.04 (jammy) y 24.04 (noble) al momento de ejecutar el spike, como ya lo mide ADR 0004 para `docker version` | §Architecture Patterns, "Pattern: estabilidad de docker ps" | Si difieren significativamente, el parser de `docker ps` debe tolerar campos ausentes en una versión y presentes en otra — el spike debe capturar ambas por separado, nunca asumir que una captura sirve para las dos |

**Si esta tabla estuviera vacía:** no lo está — los cuatro spikes de la fase son, por diseño, la fuente principal de `[ASSUMED]` de este research; su función es convertirse en `[VERIFIED: contract test + ADR 0008]` al cierre de la fase.

## Open Questions

1. **¿`drizzle-kit migrate` envuelve cada archivo de migración en su propia transacción?**
   - What we know: Postgres soporta `ALTER TYPE ... ADD VALUE` dentro de una transacción desde la v12, pero con la restricción de no-uso-en-la-misma-transacción.
   - What's unclear: el comportamiento exacto del runner de migraciones de Drizzle instalado en este repo (no confirmado con Context7 en esta sesión — la consulta no devolvió ese detalle).
   - Recommendation: el planner debe leer el código de `pnpm db:migrate` (probablemente `apps/control-plane/src/db/migrate.ts` o similar) antes de escribir el plan de la migración 0005, y/o probarlo directamente contra Postgres real antes de fijar el contenido exacto del archivo `.sql`.

2. **¿El check de discovery de BuildKit se ejecuta como parte de la misma corrida de discovery existente (11 checks) o como un check separado bajo un flag distinto?**
   - What we know: D-03 dice "Discovery gana un check BuildKit, mismo patrón de docker-version.ts".
   - What's unclear: si el nombre exacto (`docker_buildkit`, `buildkit`, `buildkit_active`) y el lugar en `DISCOVERY_CHECK_IDS`/`DiscoveryFacts` ya están decididos o quedan a discreción total del planner (CONTEXT.md dice "a discreción").
   - Recommendation: el planner elige el nombre siguiendo la convención `snake_case` ya usada (`docker_version`, `docker_compose_version`) y lo documenta como parte del plan, sin reabrir discusión.

3. **¿El fixture del repo Git bare necesita un alias de red DNS-resoluble o basta con el hostname interno que Testcontainers ya asigna al contenedor?**
   - What we know: D-06 exige un hostname válido no-IP, no `localhost`; Testcontainers en modo red compartida ya asigna alias de red resolubles entre contenedores de la misma red.
   - What's unclear: si el alias por defecto de Testcontainers cumple el patrón `HOSTNAME_LABEL_PATTERN` de `validators/network.ts` (letras/dígitos/guiones, sin guión bajo) sin configuración adicional.
   - Recommendation: usar `.withNetworkAliases('noodara-test-git.internal')` (o similar, un alias explícito controlado por el propio fixture) en vez de confiar en el alias autogenerado, para que el nombre sea estable y bajo control del test.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker (local, para Testcontainers) | toda la suite de integración de esta fase | ✓ (asumido, ya requerido por CI/dev existente) | — | — |
| `ssh-keygen` / `openssl` | generación de deploy keys de test | ✓ (ya usado por `generate-keys.ts`) | — | — |
| Acceso a `download.docker.com` / apt repo de Docker en build-time de la imagen sshd+dockerd | construir la imagen combinada (D-12) | ✓ (ya usado por `installer-dind-*` existentes) | — | — |
| Registro npm (`npm view`) | verificación de versión de `drizzle-orm`/`drizzle-kit`/`ssh2` | ✓ | — | — |

Ninguna dependencia externa nueva sin fallback: todo lo que esta fase necesita ya está probado por las imágenes `installer-dind-*`/`sshd-*` existentes; la única pieza genuinamente nueva es la imagen de Distribution `registry:2`, que es una imagen oficial pública sin autenticación para el `pull` inicial en el propio CI (D-10 no requiere red externa para los *tests*, solo para construir la imagen del fixture la primera vez).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (unit) + Testcontainers (integration), ya configurados en el repo |
| Config file | `vitest.config.ts` (raíz), `tests/integration` usa el mismo runner con `pnpm test:integration` |
| Quick run command | `pnpm test -- deployment-state` (o el patrón de filtro que use el repo) |
| Full suite command | `pnpm test && pnpm test:integration` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DEP-01 | 7 estados, tabla de transiciones exhaustiva | unit | `pnpm test -- deployment-state.test.ts` | ❌ Wave 0 |
| DEP-08 | LFS/submodules → `UNSUPPORTED_REPOSITORY_FEATURE`, sin build args/env vars en el tipo | unit | `pnpm test -- git.test.ts` | ❌ Wave 0 |
| SVC-08 | validadores rechazan shell metacharacters/`..`/esquemas no permitidos antes de tocar el servidor | unit | `pnpm test -- git.test.ts docker-naming.test.ts` | ❌ Wave 0 |
| PROJ-04 | insertar servicio con environment de otro proyecto falla en la BD | integration | `pnpm test:integration -- schema-ownership.test.ts` | ❌ Wave 0 |
| QA-07 | fixtures con `.dockerignore`, contexto <1MiB, pull real + auth registry | integration | `pnpm test:integration -- fixtures.test.ts` | ❌ Wave 0 |
| QA-10 | G1-G4 medidos con evidencia, contract tests permanentes | integration | `pnpm test:integration -- deploy-engine/contracts.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test` (unit rápido, dominio puro)
- **Per wave merge:** `pnpm test:integration` (fixture real, spikes)
- **Phase gate:** suite completa verde + ADR 0008 en estado Accepted antes de cerrar la fase

### Wave 0 Gaps
- [ ] `packages/domain/src/deployment/deployment-state.test.ts` — DEP-01
- [ ] `packages/domain/src/validators/git.test.ts`, `docker-naming.test.ts` — DEP-08, SVC-08
- [ ] `tests/integration/deploy-engine/contracts.test.ts` — QA-10 (patrón de `tests/integration/ssh/contracts.test.ts`)
- [ ] Imagen Testcontainers `sshd-dockerd-ubuntu-{22.04,24.04}` + helper análogo a `installer-dind.ts`/`ssh.ts` — QA-07, QA-10
- [ ] Test de migración 0005 (limpio + desde snapshot 0004) — PROJ-04
- Framework: ya instalado, ningún `pnpm add` de test framework necesario.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (sin auth nueva de usuario en esta fase) | — |
| V4 Access Control | sí | ownership jerárquica por FK compuesta (PROJ-04), nunca solo en capa de servicio |
| V5 Input Validation | sí | validadores de dominio con vocabulario cerrado (SVC-08) antes de `escapeShellArg` |
| V6 Cryptography | sí | mismo envelope AES-256-GCM ya auditado, nunca un mecanismo nuevo (D-16) |
| V10 Malicious/Untrusted Data (shell) | sí | allowlist cerrada, `escapeShellArg`, `--` antes de posicionales — nunca un template con `string` crudo |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Command injection vía URL de repo/rama/tag de imagen | Tampering | validador de dominio → tipo branded → `escapeShellArg` → plantilla cerrada (ya es la disciplina de `allowlist.ts`) |
| Secreto en argv/URL/log (deploy key, token, password de registry) | Information Disclosure | G1 (transferencia sin argv), `Redactor` por chunk en `exec-streaming.ts`, `--password-stdin` |
| Proceso remoto huérfano tras cancel/timeout | Denial of Service (contra el propio servidor del usuario) | G2 (kill confirmado por `ps`, no solo `channel.destroy()`) |
| Cross-project ownership bypass | Elevation of Privilege | FK compuesta en la base de datos, no solo verificación en el servicio (PROJ-04) |

## Sources

### Primary (HIGH confidence)
- Código de este repositorio, leído directamente: `packages/ssh/src/{exec-with-timeout,error-classifier}.ts`, `packages/ssh/src/commands/{allowlist,docker}.ts`, `packages/domain/src/server/server-state.ts`, `packages/domain/src/discovery/{docker-version,types,merge-facts}.ts`, `packages/domain/src/validators/{identity,network}.ts`, `packages/domain/src/security/redactor.ts`, `packages/ssh/src/testing/generate-keys.ts`, `apps/control-plane/src/db/schema/{credentials,servers}.ts`, `apps/control-plane/src/env.ts`, `tests/integration/ssh/contracts.test.ts`, `tests/integration/helpers/installer-dind.ts`, `tests/integration/images/{sshd-ubuntu-22.04,installer-dind-ubuntu-22.04}/Dockerfile`, `install.sh` (líneas 339-620, confirma instalación de `docker-buildx-plugin`), `docs/adr/0004-ssh-adapter-empirical-contracts.md`, `.github/workflows/ci.yml`, `.claude/skills/{noodara-domain-model,noodara-security}/SKILL.md`.
- `.planning/{CONTEXT.md de esta fase, ROADMAP.md, REQUIREMENTS.md, research/{SUMMARY,PITFALLS,ARCHITECTURE}.md}`.
- Context7 `/drizzle-team/drizzle-orm-docs`: composite `foreignKey()`, `unique()`/`uniqueIndex()` con `.where()` para índices parciales.

### Secondary (MEDIUM confidence)
- WebSearch, `docker-buildx-plugin`/BuildKit por defecto desde Docker Engine 23 (múltiples guías de instalación consistentes entre sí y con `install.sh`'s propia elección de paquetes).
- WebSearch, `ssh2` `Channel.signal()` (npm/docs oficiales del paquete): el método existe y algunos servidores "pueden ignorarlo si no soportan señales" — no confirma el caso concreto de OpenSSH 8.9/9.6 sobre una sesión `exec` sin pty, de ahí que siga como spike, no como hecho asumido.
- WebSearch, `docker/for-linux#1179` y `moby/moby#46906` (issues públicos de Moby/Docker) sobre el coste del campo `Size` y la forma NDJSON de `docker ps --format json`.
- WebSearch, `registry:2` + `htpasswd` (múltiples guías independientes, convergentes): `REGISTRY_AUTH=htpasswd`, `REGISTRY_AUTH_HTPASSWD_PATH`, generación con `httpd:2 htpasswd -Bbn`.

### Tertiary (LOW confidence)
- Ninguna reclamación de esta fase se apoya solo en una fuente terciaria sin verificación cruzada; donde la fuente es débil (G1/G2, comportamiento exacto de OpenSSH ante `signal`) se marca explícitamente como spike pendiente, no como hecho.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no se añade nada nuevo, todo ya está instalado y auditado.
- Architecture: HIGH — cada patrón cita un archivo real del repo que ya lo implementa para un dominio distinto.
- Pitfalls: MEDIUM — los pitfalls de "hand-rolling"/esquema/migraciones son HIGH (grounded en el repo o en Postgres/Drizzle documentado); los de G1-G4 son MEDIUM por diseño, ya que resolverlos con evidencia es el propósito mismo de la fase.

**Research date:** 2026-09-29
**Valid until:** 30 días (dominio estable: Docker/Git/Postgres/Drizzle no cambian semanalmente; revalidar si `ssh2` o `drizzle-orm`/`drizzle-kit` reciben un bump mayor antes de que esta fase se planifique).
