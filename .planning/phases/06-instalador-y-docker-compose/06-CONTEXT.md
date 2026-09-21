# Phase 6: Instalador y Docker Compose - Context

**Gathered:** 2026-09-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Esta fase entrega la instalación de un comando de Noodara v0.1 (INST-01..05): un `install.sh` servido por `curl | sh` que, en un VPS Ubuntu 22.04/24.04 limpio, hace preflight antes de tocar el sistema, instala Docker Engine y el plugin Compose si faltan, genera un `.env` con secrets aleatorios, levanta `api`/`worker`/`web`/`postgres`/`redis` con Docker Compose v2, aplica migraciones e imprime la URL del panel y el setup token de un solo uso (o crea el admin directamente si se pasan `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD`). Re-ejecutarlo sobre una instalación existente la detecta y la actualiza sin destruir datos ni secrets. Incluye los artefactos que el instalador necesita y que hoy no existen: Dockerfiles de producción (control-plane y web), `docker-compose.yml` de producción y el workflow de release que publica imágenes multi-arch en GHCR.

Fuera de la fase: Traefik, TLS/HTTPS automático y dominios (v0.4); rollback automático y backups gestionados (v0.3+); desinstalador; cualquier cambio de contrato en `packages/domain`, `packages/ssh` o la API HTTP. El backend de setup token, pre-seed de admin y fail-fast de secrets ya existe (fase 1) y solo se consume.

</domain>

<decisions>
## Implementation Decisions

### Carried forward (locked en fases anteriores — no re-discutir)
- Docker Compose v2, nunca Swarm (research ARCHITECTURE §1, §9).
- Una sola imagen para `api` y `worker` con `command` distinto: `node dist/server.js` / `node dist/worker.js` (fase 4 D-23, ADR 0003). Healthchecks de contenedor sobre `/health`; `stop_grace_period` acorde al presupuesto de apagado de fase 4 D-25/D-14.
- Same-origin: solo `web` publica puerto en el host; proxya `/api/*` a `NOODARA_API_ORIGIN` (dirección interna del servicio `api` en la red de Compose). `NOODARA_PUBLIC_URL` es el único origen público y el guard de Origin lo compara con igualdad estricta (ADR 0006, fase 4 D-29). `postgres` y `redis` no publican puertos en el host.
- Secrets generados por instalación, sin ningún valor por defecto ni embebido; el control plane se niega a arrancar si faltan o son débiles (INST-06, PITFALLS: Dokploy CVE-2026-45631 y CVE-2026-24840).
- Migraciones como paso one-shot antes de que `api` sirva tráfico; disciplina expand/contract para que la versión anterior siga funcionando tras migrar (research ARCHITECTURE §1).
- El API ya imprime `NOODARA_SETUP_TOKEN=<valor>` por stdout (sin pasar por pino) al arrancar y lo re-imprime mientras no exista admin; con pre-seed no emite token (fase 1 D-04). El instalador lo lee de los logs del contenedor `api`; no genera tokens por su cuenta.

### Imágenes y hosting del script
- **D-01:** Las imágenes son **prebuilt y se publican en GHCR** (`ghcr.io/<owner>/noodara-*`); el instalador solo hace `pull`. No hay build en el VPS ni fallback a build desde fuente.
- **D-02:** El repo público de GitHub **lo crea el usuario manualmente** (hoy no existe remoto). La fase entrega Dockerfiles, workflow de release e instalador asumiendo ese remoto; crear el repo y hacer el primer push es un prerequisito humano documentado de la verificación final (también destraba QA-04/QA-05). Ningún plan ejecuta `gh repo create` ni `git push`.
- **D-03:** `install.sh` se sirve desde **raw.githubusercontent.com** (`curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh`). Sin dominio propio en v0.1; el script no debe asumir su propia URL para que pueda moverse después.
- **D-04:** Versión por defecto = **última release estable**, resuelta por el script; `NOODARA_VERSION` la fija explícitamente. El **tag exacto** (p. ej. `0.1.0`) se escribe en el `.env` de la instalación y el compose lo referencia; **nunca `:latest`**, de modo que un reinicio no cambia de versión y `api`/`worker`/`web` siempre van a la misma.

### Acceso al panel sin HTTPS
- **D-05:** Instalación por defecto en **HTTP**. Si `NOODARA_PUBLIC_URL` resultante es `http://`, el instalador escribe `NOODARA_COOKIE_INSECURE=true` en `.env` e imprime un **aviso claro** de que el tráfico va sin cifrar hasta v0.4 o hasta poner un proxy TLS delante. Si el usuario pasa una URL `https://`, **no** se escribe el opt-out y las cookies quedan `Secure`. El opt-out nunca se activa por otra vía.
- **D-06:** Puerto del panel en el host: **3000**, con override `NOODARA_PORT`. 80/443 quedan libres para Traefik en v0.4. Si el puerto está ocupado, el preflight falla y sugiere `NOODARA_PORT=<otro>`.
- **D-07:** Resolución de `NOODARA_PUBLIC_URL`: **override explícito > servicio externo de IP pública con timeout corto > IP local de la ruta por defecto**. El instalador imprime la URL elegida y cómo cambiarla (editar `.env` y re-ejecutar). Motivo: en VPS con NAT la IP local es privada y todas las mutaciones fallarían con `FORBIDDEN_ORIGIN`.
- **D-08:** Firewall: si `ufw` está activo, el instalador **detecta y avisa, nunca modifica reglas**. Al final imprime el comando exacto (`ufw allow <puerto>/tcp`) y recuerda el firewall del proveedor cloud. El aviso debe ser preciso respecto a que los puertos publicados por Docker suelen saltarse `ufw`.

### Re-ejecución y upgrade
- **D-09:** Re-ejecutar = **upgrade a la última release** (o a `NOODARA_VERSION`): conserva `.env` y volúmenes, `pull`, migraciones, `docker compose up -d`. Si ya está en esa versión, no cambia nada y solo verifica salud. Es el único camino de upgrade en v0.1.
- **D-10:** Ubicación: **`/opt/noodara`** con `docker-compose.yml` y `.env` (modo 600, root). Datos en **volúmenes Docker nombrados** (`noodara_postgres_data`, `noodara_redis_data`), no bind mounts. La existencia de `/opt/noodara/.env` es la señal de "instalación existente".
- **D-11:** `.env` existente: los secrets **nunca se regeneran ni se reescriben**. Si una release añade una variable requerida, se **añade** sin tocar las demás (merge aditivo). Antes de cualquier cambio se deja `.env.bak-<timestamp>` con modo 600. En un upgrade normal solo cambia `NOODARA_VERSION`.
- **D-12:** Upgrade que no pasa healthcheck: **falla con diagnóstico, sin rollback automático**. Exit code ≠ 0, indica qué servicio no está sano, muestra la cola de sus logs e indica cómo volver (`NOODARA_VERSION=<anterior>`, que el instalador deja anotada). Datos y secrets intactos.
- **D-13:** En una re-ejecución con admin ya existente el mensaje final muestra solo la URL (no hay token); sin admin, re-muestra el token vigente leído de los logs.

### Preflight e instalación de Docker
- **D-14:** Docker y Compose faltantes se instalan desde el **repo apt oficial de Docker, paso a paso** (clave GPG + `download.docker.com` + `docker-ce` y `docker-compose-plugin`), cada paso con su propio mensaje de error. **No** se usa `get.docker.com`. Solo Ubuntu, sin lógica multi-distro.
- **D-15:** Recursos: **RAM < 1 GB falla, < 2 GB avisa; disco libre < 5 GB falla**. Override consciente `NOODARA_SKIP_RESOURCE_CHECK=1`.
- **D-16:** Arquitecturas: **amd64 y arm64**. Imágenes multi-arch con buildx en el workflow de release; cualquier otra arquitectura falla en preflight. El build arm64 debe verificarse de verdad por las dependencias nativas (argon2, ssh2).
- **D-17:** El preflight completo (OS 22.04/24.04, arquitectura, RAM/disco, puerto del panel, Docker vía snap, root/sudo) corre **antes de escribir o instalar nada**; cada causa tiene mensaje accionable y exit code propio, nunca un genérico "installation failed" (PITFALLS #5).

### Testing del instalador
- **D-18:** Tres capas, con TDD:
  1. **Unit de shell**: funciones de preflight, resolución de URL/versión y merge de `.env` como shell puro con fixtures (bats o Vitest lanzando `sh`; lo decide research).
  2. **Integration con Testcontainers**: contenedor Ubuntu 22.04 y 24.04 privilegiado con Docker-in-Docker que ejecuta `install.sh` **dos veces seguidas** con imágenes construidas localmente, y cubre: idempotencia (estado final idéntico, mismos secrets), puerto ocupado, Docker vía snap, RAM insuficiente, OS no soportado, pre-seed de admin, token impreso.
  3. **Validación manual en un VPS real** por el usuario como gate de cierre, registrada en el UAT de la fase.
- **D-19:** Para que la capa 2 funcione sin registry, el instalador acepta un **override de registry/tag solo para tests** (nombre a criterio del planner); no se documenta como feature de usuario.

### Claude's Discretion
- Estructura interna de `install.sh` (POSIX `sh` vs `bash`; nótese que el comando publicado es `| sh`), nombres de funciones y tabla de exit codes.
- Root vs `sudo`: cómo se detecta y se re-ejecuta con privilegios.
- Formato y tono de la salida del script (en inglés; calmado, progresivo, sin ruido — coherente con "Calm interface"), y si se deja un log en `/opt/noodara/install.log` (sin secrets).
- Dockerfiles: multi-stage, imagen base, usuario no-root, `output: 'standalone'` de Next.js, tamaño final.
- Cómo se ejecutan las migraciones en producción (servicio one-shot en Compose vs `docker compose run`); hoy `db:migrate` usa `tsx`, la imagen de producción necesita un entrypoint compilado.
- Servicio externo concreto para la IP pública y su timeout; mecanismo para resolver "última release estable" (API de GitHub vs redirect de `releases/latest`).
- Nombres de las imágenes en GHCR, triggers del workflow de release, firma/provenance de imágenes.
- Healthcheck de `redis` y `web` en Compose; límites de memoria por contenedor.
- Documentación mínima de instalación (README/`docs/`): comando, variables soportadas, upgrade, troubleshooting.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y requisitos
- `.planning/ROADMAP.md` §"Phase 6: Instalador y Docker Compose" — goal y success criteria 1–4.
- `.planning/REQUIREMENTS.md` — INST-01..INST-05 (esta fase), INST-06 (ya cumplido, condiciona el `.env`), QA-04/QA-05 (pendientes de remoto).
- `.planning/PROJECT.md` — Core Value, Constraints (instalación de un comando), Key Decisions (topología Compose).
- `docs/roadmap-v0.1-v0.5.md` §6 — fuente de verdad de v0.1.

### Research
- `.planning/research/ARCHITECTURE.md` §1 — topología Compose, una imagen/dos entrypoints, migraciones one-shot, upgrade por re-ejecución, comparación con Coolify (Compose) y Dokploy (Swarm); §9 decisiones de una vía.
- `.planning/research/PITFALLS.md` — Pitfall 1 (secrets con fallback, CVEs de Dokploy), Pitfall 5 (instalador en VPS no limpios: snap, puertos, ufw, idempotencia, tests de doble corrida).
- `.planning/research/FEATURES.md` — instalación de un comando, bootstrap de admin con setup token, pre-seed por env vars.
- `.planning/research/SUMMARY.md` §"Phase 6" y "Installer phase" — mirar el `install.sh` real de Coolify antes de escribir el preflight de snap/puertos.

### Contratos de runtime existentes
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` — `dist/server.js`, `dist/worker.js`, `packages/domain` compilado; base de los Dockerfiles.
- `docs/adr/0006-web-app-same-origin-proxy-and-ports.md` — proxy same-origin, `NOODARA_API_ORIGIN` vs `NOODARA_PUBLIC_URL`, nota de producción de fase 6.
- `.planning/phases/04-http-routes-worker-bullmq-y-sse/04-CONTEXT.md` — D-23 (entrypoints/`command`), D-25 (apagado limpio → `stop_grace_period`), D-29 (guard de Origin), línea "Fase 6 definirá docker-compose.yml…".
- `.planning/phases/01-dominio-persistencia-y-autenticaci-n/01-CONTEXT.md` — D-04 (pre-seed), setup token, D-08 (cookies Secure y opt-out), D-09/D-12 (master key).

### Código que el instalador consume
- `.env.example` — lista completa de variables requeridas y opcionales, con formato y reglas de generación (`openssl rand -base64 32`). Nota: `NOODARA_COOKIE_INSECURE` existe en `env.ts` pero no está en `.env.example`.
- `apps/control-plane/src/env.ts` — validación fail-fast, rangos, `PORT` (default 3000), `NOODARA_COOKIE_INSECURE`.
- `apps/control-plane/src/boot/bootstrap-admin.ts` — formato exacto `NOODARA_SETUP_TOKEN=<valor>` en stdout y reglas de emisión/re-impresión.
- `apps/control-plane/src/auth/auth.ts` — `useSecureCookies: !env.NOODARA_COOKIE_INSECURE`.
- `apps/control-plane/package.json`, `apps/web/package.json`, `apps/web/next.config.ts` — scripts `build`/`start`, `db:migrate` (hoy con `tsx`), `rewrites()` a `NOODARA_API_ORIGIN`, sin `output: 'standalone'` todavía.
- `docker-compose.dev.yml` — imágenes (`postgres:17-alpine`, `redis:7-alpine`), healthchecks y nombres de volúmenes a reutilizar.
- `.github/workflows/ci.yml`, `.github/workflows/nightly.yml` — puertas de CI existentes donde encajan los tests del instalador y el workflow de release.

### Skills de proyecto
- `.claude/skills/noodara-security/` — generación y manejo de secrets, permisos de archivos, nada de secrets en salida/logs del instalador.
- `.claude/skills/noodara-tdd/` — elección de tipo de test y DoD.
- `.claude/skills/noodara-release-gate/` — esta es la última fase de v0.1; el cierre pasa por el release gate.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `docker-compose.dev.yml`: definiciones de `postgres` y `redis` con healthchecks y `requirepass`, base directa de los mismos servicios en producción (sin `ports`).
- `.env.example`: inventario de variables; el generador de `.env` del instalador debe cubrir exactamente las requeridas.
- `bootstrap-admin.ts`: emisión del setup token y pre-seed ya implementados y testeados; el instalador solo pasa las env vars y lee stdout.
- CLI `noodara` (`apps/control-plane/src/cli/`): `admin reset` y `secrets rotate` deben poder ejecutarse dentro del contenedor (`docker compose exec api ...`) — la imagen debe incluir el CLI compilado.
- `/health` distingue Postgres, Redis y worker (fase 4): sirve para el healthcheck de contenedor y para la verificación post-instalación/upgrade.
- `pnpm test:boot` (boot smoke de dos procesos) y helpers de Testcontainers en `tests/integration/helpers/` (`postgres.ts`, `redis.ts`, `ssh.ts` con imágenes Ubuntu 22.04/24.04 propias): patrón para el harness DinD del instalador.

### Established Patterns
- Sin defaults para secrets en ningún sitio; `env.ts` se importa primero en cada entrypoint.
- `turbo.json` exige declarar cada variable en `passThroughEnv`.
- Postura de cero dependencias de tooling nuevas salvo necesidad justificada; paquetes nuevos pasan por `scripts/check-package-provenance.mjs` y ADR 0000.
- Tests de integración etiquetan contenedores con `noodara.test=true` y nunca dependen del DNS de la máquina.
- Código, salida del script y docs de usuario en inglés; planificación en español. Commits convencionales sin atribución a IA.

### Integration Points
- Nuevos en la raíz del repo: `install.sh`, `docker-compose.yml` (producción), Dockerfiles para `apps/control-plane` y `apps/web`, `.dockerignore`, workflow de release en `.github/workflows/`.
- `apps/web/next.config.ts`: `rewrites()` se evalúa en build, así que `NOODARA_API_ORIGIN` queda fijado en la imagen — debe ser la dirección interna constante del servicio `api` (research debe confirmarlo).
- `apps/control-plane`: entrypoint de migraciones ejecutable con node plano desde `dist` (hoy solo existe vía `tsx`).
- El repo git raíz actual es `~/work/myself` con este proyecto anidado en `noodara/code/`; el repo público de GitHub tendrá `noodara/code/` como raíz, lo que fija las rutas de `install.sh` en la URL raw y del contexto de build de Docker.

</code_context>

<specifics>
## Specific Ideas

- Referencia de experiencia: **Coolify** — un comando, panel en `http://IP:puerto`, URL impresa al final, re-ejecutar = upgrade. Se copia el modelo y se evitan sus fallos documentados (snap, puerto 8000 que falla en silencio, "fails silently on step Docker").
- Diferencial de confianza frente a Coolify/Dokploy: setup token impreso por el instalador en vez de "el primero que llega es admin", secrets únicos por instalación, y un instalador que no toca el firewall ni ejecuta scripts de terceros como root.
- El usuario aceptó la opción recomendada en las 16 decisiones; no hubo preferencias fuera de las opciones.

</specifics>

<deferred>
## Deferred Ideas

- Rollback automático de imágenes tras un upgrade fallido — v0.3+ (el rollback es alcance del deployment engine).
- Backup `pg_dump` automático antes de cada upgrade.
- Dominio propio para el instalador (`get.noodara.*`) — cuando exista dominio; D-03 deja el script agnóstico a su URL.
- Job nightly en un runner Ubuntu limpio que ejecute el `install.sh` real — cuando exista el remoto.
- Build desde fuente en el VPS como alternativa al pull.
- Desinstalador y wrapper CLI `noodara` en el host.
- HTTPS automático, Traefik y dominios — v0.4 por roadmap.

</deferred>

---

*Phase: 6-Instalador y Docker Compose*
*Context gathered: 2026-09-21*
