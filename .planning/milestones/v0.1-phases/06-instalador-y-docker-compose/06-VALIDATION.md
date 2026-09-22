---
phase: 6
slug: instalador-y-docker-compose
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-09-21
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Fuente: `06-RESEARCH.md` §"Validation Architecture" y `06-CONTEXT.md` D-18/D-19.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (root-pinned) lanzando `/bin/sh` real para la capa de shell + Testcontainers (root-pinned) con Docker-in-Docker para la capa de integración |
| **Config file** | `vitest.integration.config.ts` (existente) — archivos nuevos bajo `tests/integration/installer/` |
| **Quick run command** | `pnpm exec vitest run tests/unit/installer/` (capa 1, proyecto `root` de `vitest.config.ts`, sin build ni Docker) |
| **Full suite command** | `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration` (completa, ~32 min) **más** `pnpm test:installer` (suite DinD, config propia) |
| **Wave suite command** | `pnpm test:installer` (equivale a `pnpm exec vitest run --config vitest.installer.config.ts`) |
| **Estimated runtime** | quick ~10–30 s · installer DinD suite: medida en Plan 06-12 y registrada en su SUMMARY (estimación previa 10–20 min) |

Notas operativas (lecciones de fases anteriores):

- Mirar siempre el **conteo de tests**, no solo el exit code: en zsh un glob mal pasado da "No test files found" con exit 0.
- `pnpm test:integration` en frío exige `NOODARA_API_ORIGIN` para el `next build`.
- Los contenedores de test llevan la etiqueta `noodara.test=true`; un cuelgue de Docker deja huérfanos que hacen fallar en cascada.
- Los tests nunca dependen del resolver DNS de la máquina ni de red externa: resolución de "última release" e IP pública se prueban con stubs locales. **Única excepción declarada:** el caso `withDocker: false` de `preflight-scenarios.test.ts` (Plan 06-12 T2), que instala Docker de verdad desde el repo apt oficial y está marcado como tal en el propio archivo.

---

## Sampling Rate

- **After every task commit:** quick run command (capa 1, shell puro contra `/bin/sh` y `dash` cuando está disponible) + `pnpm check:posix-sh`.
- **After every plan wave:** `pnpm test:installer` + `pnpm lint && pnpm typecheck && pnpm test`.
- **Before `/gsd:verify-work`:** full suite verde + `pnpm test:boot` + `pnpm test:e2e` + `pnpm security:scan-leaks`, y la validación manual en VPS real (D-18 capa 3) registrada en `06-HUMAN-UAT.md` (Plan 06-15).
- **Max feedback latency:** 30 s por commit de tarea (capa 1); la capa DinD se muestrea por wave, no por tarea.

---

## Per-Task Verification Map

> IDs de tarea con formato `06-<plan>-T<n>`. Toda tarea de código lleva su propio `<automated>`;
> ninguna secuencia de tres tareas queda sin verificación automatizada.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-T1 | 06-01 | 1 | INST-03 | T-06-01 | un bashism o un statement con efectos secundarios en el top level de `install.sh` falla el gate | unit (Node) | `pnpm exec vitest run tests/unit/scripts/check-posix-sh.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-T2 | 06-01 | 1 | INST-01, INST-03 | T-06-01, T-06-02 | descarga truncada no puede instalar a medias; los helpers de salida no interpolan secrets | unit (sh/dash real) | `pnpm exec vitest run tests/unit/installer/skeleton.test.ts && node scripts/check-posix-sh.mjs install.sh` | ❌ W0 | ⬜ pending |
| 06-01-T3 | 06-01 | 1 | INST-01 | — | la suite DinD queda fuera del gate de PR y dentro de su propio config | config | `pnpm exec tsc -p tests/integration/installer/tsconfig.json --noEmit && pnpm test:installer` | ❌ W0 | ⬜ pending |
| 06-02-T1 | 06-02 | 2 | INST-03 | T-06-15, T-06-17 | root/base-commands/OS/arch fallan con su propio exit code sin filtrar datos del host | unit (sh/dash real) | `pnpm exec vitest run tests/unit/installer/preflight.test.ts` | ❌ W0 | ⬜ pending |
| 06-02-T2 | 06-02 | 2 | INST-03 | T-06-14 | `NOODARA_PORT` validado (dígitos, 1–65535) antes de llegar a `.env` o a un comando | unit (sh/dash real) | `pnpm exec vitest run tests/unit/installer/preflight.test.ts` | ❌ W0 | ⬜ pending |
| 06-02-T3 | 06-02 | 2 | INST-03 | T-06-15, T-06-16 | el preflight completo corre antes de escribir nada y reporta solo la primera causa | unit (sh/dash real) | `pnpm exec vitest run tests/unit/installer/preflight.test.ts` | ❌ W0 | ⬜ pending |
| 06-03-T1 | 06-03 | 2 | INST-01 | T-06-18 | ningún `.env` real puede entrar al contexto de build de una imagen publicada | static | `grep -q '^\.env$' .dockerignore` | ❌ W0 | ⬜ pending |
| 06-03-T2 | 06-03 | 2 | INST-01 | T-06-19, T-06-20, T-06-21 | imagen no-root, tooling de build fijado por lockfile, versión estampada | build | `docker build --file apps/control-plane/Dockerfile --tag noodara-control-plane:planverify .` | ❌ W0 | ⬜ pending |
| 06-03-T3 | 06-03 | 2 | INST-01 | T-06-22 | los cuatro entrypoints compilados arrancan de verdad; migraciones idempotentes desde `dist` | integration (Docker) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/control-plane-image.test.ts` | ❌ W0 | ⬜ pending |
| 06-04-T1 | 06-04 | 3 | INST-01 | T-06-03 | los secrets generados pasan la validación fail-fast real de `env.ts`; los de URL sobreviven al parseo | unit (sh) + integration (node real) | `pnpm exec vitest run tests/unit/installer/env-file.test.ts && pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/env-contract.test.ts` | ❌ W0 | ⬜ pending |
| 06-04-T2 | 06-04 | 3 | INST-01, INST-05 | T-06-04, T-06-02, T-06-24 | `.env` modo 600, sin defaults, sin valores en stdout/stderr; opt-out de cookie solo en `http://` | unit (sh/dash real) | `pnpm exec vitest run tests/unit/installer/env-file.test.ts` | ❌ W0 | ⬜ pending |
| 06-04-T3 | 06-04 | 3 | INST-02 | T-06-11, T-06-23 | merge aditivo: ninguna línea existente se reescribe; backup modo 600; escritura atómica | unit (sh/dash real) | `pnpm exec vitest run tests/unit/installer/env-file.test.ts` | ❌ W0 | ⬜ pending |
| 06-05-T1 | 06-05 | 3 | INST-01 | T-06-25 | el build falla si falta `NOODARA_API_ORIGIN`; ADR-0006 intacto | build | `NOODARA_API_ORIGIN=http://localhost:3100 pnpm --filter @noodara/web build` | ❌ W0 | ⬜ pending |
| 06-05-T2 | 06-05 | 3 | INST-01 | T-06-25, T-06-26 | imagen web no-root, sin default de origen embebido | build | `docker build --file apps/web/Dockerfile --build-arg NOODARA_API_ORIGIN=http://api:3000 --tag noodara-web:planverify .` | ❌ W0 | ⬜ pending |
| 06-05-T3 | 06-05 | 3 | INST-01 | T-06-25, T-06-27 | el proxy `/api/*` llega al api real; headers de seguridad de fase 5 sobreviven al build standalone | integration (Docker) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/web-image.test.ts` | ❌ W0 | ⬜ pending |
| 06-07-T1 | 06-07 | 4 | INST-01 | T-06-08, T-06-07, T-06-33 | solo `web` publica puerto; cero `:latest`; healthcheck de redis corregido | static | `test "$(grep -c 'ports:' docker-compose.yml)" = "1" && ! grep -q ':latest' docker-compose.yml` | ❌ W0 | ⬜ pending |
| 06-07-T2 | 06-07 | 4 | INST-01 | T-06-33, T-06-34, T-06-35 | stack real sano; redis `healthy` de verdad; límites de memoria medidos | integration (compose real) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/compose-stack.test.ts` | ❌ W0 | ⬜ pending |
| 06-06-T1 | 06-06 | 4 | INST-01 | T-06-30, T-06-31 | una sola llamada `curl` con timeout; el tag resuelto se valida antes de usarse | unit (sh/dash real, stubs) | `pnpm exec vitest run tests/unit/installer/resolution.test.ts` | ❌ W0 | ⬜ pending |
| 06-06-T2 | 06-06 | 4 | INST-01 | T-06-29 | la respuesta del servicio de IP se valida como IPv4 antes de convertirse en `NOODARA_PUBLIC_URL` | unit (sh/dash real, stubs) | `pnpm exec vitest run tests/unit/installer/resolution.test.ts` | ❌ W0 | ⬜ pending |
| 06-08-T1 | 06-08 | 5 | INST-01 | T-06-39 | con Docker presente no se ejecuta ninguna operación de paquetes | unit (sh/dash real, stubs) | `pnpm exec vitest run tests/unit/installer/docker-install.test.ts` | ❌ W0 | ⬜ pending |
| 06-08-T2 | 06-08 | 5 | INST-01 | T-06-06, T-06-37, T-06-38, T-06-40 | repo apt firmado con `signed-by`, cero `get.docker.com`, apt no interactivo, error por paso | unit (sh/dash real, stubs) | `pnpm exec vitest run tests/unit/installer/docker-install.test.ts` | ❌ W0 | ⬜ pending |
| 06-09-T1 | 06-09 | 6 | INST-02 | T-06-11 | `/opt/noodara/.env` es la única señal de instalación existente; el compose embebido no puede derivar | unit (sh/dash real, stubs) | `pnpm exec vitest run tests/unit/installer/main-flow.test.ts` | ❌ W0 | ⬜ pending |
| 06-09-T2 | 06-09 | 6 | INST-01, INST-02 | T-06-42, T-06-44 | fallo de health diagnostica y para; nunca borra datos ni secrets | unit (sh/dash real, stubs) | `pnpm exec vitest run tests/unit/installer/main-flow.test.ts` | ❌ W0 | ⬜ pending |
| 06-09-T3 | 06-09 | 6 | INST-04, INST-05 | T-06-09, T-06-41, T-06-05, T-06-43, T-06-45 | token leído (nunca inventado), `install.log` sin secrets, aviso ufw preciso y solo consultivo | unit (sh/dash real, stubs) | `pnpm exec vitest run tests/unit/installer/main-flow.test.ts` | ❌ W0 | ⬜ pending |
| 06-10-T1 | 06-10 | 7 | INST-01, INST-03 | T-06-47 | fixtures privilegiadas propias del proyecto, sin script de terceros | build | `docker build --file tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile tests/integration/images` | ❌ W0 | ⬜ pending |
| 06-10-T2 | 06-10 | 7 | INST-01 | T-06-49, T-06-50 | `install.sh` se ejecuta bajo dash real en 22.04 y 24.04; imágenes locales sin registry (D-19) | integration (DinD) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/dind-harness.test.ts` | ❌ W0 | ⬜ pending |
| 06-11-T1 | 06-11 | 8 | INST-01, INST-04 | T-06-02, T-06-45 | instalación limpia en ambas Ubuntu; el token impreso es el que emitió la api; cero secrets en salida | integration (DinD) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/fresh-install.test.ts` | ❌ W0 | ⬜ pending |
| 06-11-T2 | 06-11 | 8 | INST-05 | T-06-02, T-06-52 | pre-seed sin token, credenciales nunca en salida ni en `install.log`, login real funciona | integration (DinD) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/preseed-admin.test.ts` | ❌ W0 | ⬜ pending |
| 06-12-T1 | 06-12 | 9 | INST-02 | T-06-11, T-06-44, T-06-53 | dos corridas: secrets byte a byte idénticos, datos legibles, upgrade fallido no destructivo | integration (DinD, dos corridas) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/idempotent-rerun.test.ts` | ❌ W0 | ⬜ pending |
| 06-12-T2 | 06-12 | 9 | INST-03 | T-06-16, T-06-06 | cada causa de preflight falla en contenedor real antes de escribir; instalación apt real verificada | integration (DinD) | `pnpm exec vitest run --config vitest.installer.config.ts tests/integration/installer/preflight-scenarios.test.ts` | ❌ W0 | ⬜ pending |
| 06-13-T1 | 06-13 | 10 | INST-01 | T-06-54, T-06-55, T-06-56, T-06-57 | acciones fijadas por SHA, permisos mínimos, manifiesto multi-arch verificado | static | `grep -q 'packages: write' .github/workflows/release.yml && grep -q 'imagetools create' .github/workflows/release.yml` | ❌ W0 | ⬜ pending |
| 06-13-T2 | 06-13 | 10 | INST-01 | T-06-59 | el gate POSIX corre en cada PR; la suite DinD corre en main y nightly sin encarecer el PR | static | `grep -c 'check:posix-sh' .github/workflows/ci.yml && grep -c 'test:installer' .github/workflows/nightly.yml` | ❌ W0 | ⬜ pending |
| 06-14-T1 | 06-14 | 11 | INST-01..05 | T-06-01, T-06-05, T-06-46, T-06-32, T-06-60 | alternativa sin pipe documentada; aviso HTTP y ufw precisos; overrides de test NO documentados | static | `grep -q 'typically bypass' docs/install.md && ! grep -q 'NOODARA_INTERNAL_IMAGE_PREFIX' docs/install.md` | ❌ W0 | ⬜ pending |
| 06-14-T2 | 06-14 | 11 | INST-01..05 | T-06-61 | README y ADR 0007 registran la topología para que v0.4 no la renegocie | static | `test -f README.md && grep -q 'Accepted' docs/adr/0007-production-topology-and-installer.md` | ❌ W0 | ⬜ pending |
| 06-15-T1 | 06-15 | 12 | INST-01..05 | T-06-62 | todas las puertas corridas una vez con salida cruda y conteos reales | gate run | `pnpm lint && pnpm typecheck && pnpm boundaries && pnpm check:posix-sh && pnpm check:ui-safety && pnpm test && pnpm test:boot && pnpm test:integration && pnpm test:installer && pnpm test:e2e && pnpm security:scan-leaks` | ❌ W0 | ⬜ pending |
| 06-15-T2 | 06-15 | 12 | INST-01..05 | T-06-62, T-06-63 | criterios sin evidencia ejecutable quedan UNVERIFIED, nunca READY | static | `grep -q 'Veredicto' docs/releases/v0.1-gate.md` | ❌ W0 | ⬜ pending |
| 06-15-T3 | 06-15 | 12 | INST-01..05 | T-06-64, T-06-05 | D-02 respetado: ningún agente creó repo, remoto, tag ni push | human checkpoint | manual — `git remote -v` vacío + decisión explícita del usuario | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Desviaciones respecto al borrador de esta estrategia, decididas durante la planificación:**

1. **La capa 1 vive en `tests/unit/installer/`, no en `tests/integration/installer/shell-functions.test.ts`.** `vitest.integration.config.ts` tiene un `globalSetup` que construye todo el workspace, lo que rompe el presupuesto de 30 s por commit de tarea. El proyecto `root` de `vitest.config.ts` ya incluye `tests/unit/**/*.test.ts`, así que la capa de shell corre en `pnpm test` sin build y sin Docker — y en CI (`ubuntu-latest`) `/bin/sh` **es** dash, de modo que la capa 1 se ejecuta contra dash real en cada PR sin job nuevo. En macOS el arnés añade `dash` si está instalado y un test afirma, cuando `CI` está definido, que al menos un intérprete de la lista es de la familia dash.
2. **La suite DinD tiene config propia (`vitest.installer.config.ts`) y script propio (`pnpm test:installer`)**, y se excluye de `vitest.integration.config.ts`. Motivo: construye dos imágenes de producción y levanta Docker-in-Docker privilegiado en dos versiones de Ubuntu; sumarla al job `integration` (ya 45 min de timeout) llevaría el gate de PR por encima de una hora. Corre en push a `main` y en nightly (Plan 06-13).
3. **Un fichero de capa 1 por área** (`skeleton`, `preflight`, `env-file`, `resolution`, `docker-install`, `main-flow`) en vez de un único `shell-functions.test.ts`, para que el comando de verificación de cada tarea apunte a un fichero que esa tarea realmente toca.
4. **Gate estático adicional sin dependencias nuevas:** `scripts/check-posix-sh.mjs` + `pnpm check:posix-sh`, que detecta bashisms y statements con efectos secundarios en el top level de `install.sh`. Cubre el riesgo de que la máquina de desarrollo (macOS) no ejecute dash.

---

## Wave 0 Requirements

- [ ] `tests/unit/installer/sh-harness.ts` + `tests/unit/installer/skeleton.test.ts` — capa 1: lanza `/bin/sh` real (dash en CI) contra las funciones de `install.sh`.
- [ ] `scripts/check-posix-sh.mjs` + `tests/unit/scripts/check-posix-sh.test.ts` — gate estático de POSIX sh.
- [ ] `vitest.installer.config.ts` + `tests/integration/installer/tsconfig.json` + scripts `test:installer` / `check:posix-sh` en `package.json`.
- [ ] `tests/integration/helpers/installer-dind.ts` — helper Testcontainers: Ubuntu 22.04/24.04 privilegiado con `dockerd`, etiqueta `noodara.test=true`, carga de imágenes construidas localmente sin registry (override D-19).
- [ ] `tests/integration/installer/fresh-install.test.ts`, `idempotent-rerun.test.ts`, `preflight-scenarios.test.ts`, `preseed-admin.test.ts` — capa 2, escenarios de D-18.
- [ ] Framework install: ninguno (Vitest y Testcontainers ya están fijados en la raíz).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `curl … \| sh` real en un VPS Ubuntu limpio (22.04 y/o 24.04) hasta ver el panel y completar `/setup` con el token impreso | INST-01, INST-04 | Requiere VPS real, repo público en GitHub y release publicada en GHCR (D-02: los crea el usuario) | Crear repo + push + tag de release; en el VPS ejecutar el comando publicado; abrir la URL impresa; canjear el token; re-ejecutar el instalador y comprobar que no cambia nada |
| Pull de imágenes multi-arch (amd64 y arm64) desde GHCR y arranque con dependencias nativas (argon2, ssh2) | INST-01 | El workflow de release solo corre en GitHub Actions; no hay remoto todavía | Tras la primera release, `docker manifest inspect` de cada imagen y un arranque en una máquina arm64 |
| Exactitud del aviso de `ufw` frente a puertos publicados por Docker | INST-03 (D-08) | Depende del firewall real del host y del proveedor cloud | Con `ufw` activo en el VPS, comprobar que el aviso aparece, que el comando sugerido es correcto y si el puerto publicado es de verdad alcanzable pese a `ufw`; corregir `docs/install.md` si la realidad difiere |

Los tres quedan registrados como prerequisitos humanos numerados en `06-HUMAN-UAT.md` (Plan 06-15).

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s (capa 1, ahora en `tests/unit/installer/` sin `globalSetup`)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planner, 2026-09-21 (mapa rellenado con IDs reales `06-<plan>-T<n>`)
