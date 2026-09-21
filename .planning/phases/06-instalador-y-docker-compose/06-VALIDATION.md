---
phase: 6
slug: instalador-y-docker-compose
status: draft
nyquist_compliant: false
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
| **Quick run command** | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/installer/shell-functions.test.ts` |
| **Full suite command** | `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration` (completa, ~32 min + harness DinD) |
| **Wave suite command** | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/installer/` |
| **Estimated runtime** | quick ~10–30 s · installer DinD suite: a medir en Wave 0 (estimado 10–20 min) |

Notas operativas (lecciones de fases anteriores):

- Mirar siempre el **conteo de tests**, no solo el exit code: en zsh un glob mal pasado da "No test files found" con exit 0.
- `pnpm test:integration` en frío exige `NOODARA_API_ORIGIN` para el `next build`.
- Los contenedores de test llevan la etiqueta `noodara.test=true`; un cuelgue de Docker deja huérfanos que hacen fallar en cascada.
- Los tests nunca dependen del resolver DNS de la máquina ni de red externa: resolución de "última release" e IP pública se prueban con stubs locales.

---

## Sampling Rate

- **After every task commit:** quick run command (capa 1, shell puro contra `/bin/sh`).
- **After every plan wave:** wave suite command (harness DinD completo de `tests/integration/installer/`) + `pnpm lint && pnpm typecheck && pnpm test`.
- **Before `/gsd:verify-work`:** full suite verde + `pnpm test:boot` + `pnpm security:scan-leaks`, y la validación manual en VPS real (D-18 capa 3) registrada en el UAT de la fase.
- **Max feedback latency:** 30 s por commit de tarea (capa 1); la capa DinD se muestrea por wave, no por tarea.

---

## Per-Task Verification Map

> Lo rellena el planner con los IDs reales de tarea. Mapa de requisitos de partida:

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | INST-01 | T-06-secrets-fallback | `.env` generado con secrets aleatorios, modo 600, sin valores por defecto; `postgres`/`redis` sin puertos en el host | integration (DinD) | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/installer/fresh-install.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | INST-02 | T-06-env-clobber | segunda corrida: mismos secrets byte a byte, volúmenes intactos, `.env.bak-*` modo 600 | integration (DinD, dos corridas) | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/installer/idempotent-rerun.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | INST-03 | — | preflight falla antes de escribir nada, con exit code propio por causa | unit (shell real) + integration (DinD) | `…/installer/shell-functions.test.ts` · `…/installer/preflight-scenarios.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | INST-04 | T-06-secrets-in-output | imprime URL + setup token leído de los logs de `api`; ningún otro secret en stdout ni en `install.log` | integration (DinD) | `…/installer/fresh-install.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | INST-05 | T-06-secrets-in-output | con pre-seed no se emite token y la password no aparece en salida ni logs | integration (DinD) | `…/installer/preseed-admin.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integration/installer/shell-functions.test.ts` — capa 1: lanza `/bin/sh` real (dash) contra las funciones de `install.sh` (predicados de preflight, resolución de versión/URL, merge aditivo de `.env`).
- [ ] `tests/integration/helpers/installer-dind.ts` — helper Testcontainers: Ubuntu 22.04/24.04 privilegiado con `dockerd`, etiqueta `noodara.test=true`, carga de imágenes construidas localmente sin registry (override D-19).
- [ ] `tests/integration/installer/fresh-install.test.ts`, `idempotent-rerun.test.ts`, `preflight-scenarios.test.ts`, `preseed-admin.test.ts` — capa 2, escenarios de D-18.
- [ ] Framework install: ninguno (Vitest y Testcontainers ya están fijados en la raíz).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `curl … \| sh` real en un VPS Ubuntu limpio (22.04 y/o 24.04) hasta ver el panel y completar `/setup` con el token impreso | INST-01, INST-04 | Requiere VPS real, repo público en GitHub y release publicada en GHCR (D-02: los crea el usuario) | Crear repo + push + tag de release; en el VPS ejecutar el comando publicado; abrir la URL impresa; canjear el token; re-ejecutar el instalador y comprobar que no cambia nada |
| Pull de imágenes multi-arch (amd64 y arm64) desde GHCR y arranque con dependencias nativas (argon2, ssh2) | INST-01 | El workflow de release solo corre en GitHub Actions; no hay remoto todavía | Tras la primera release, `docker manifest inspect` de cada imagen y un arranque en una máquina arm64 |
| Exactitud del aviso de `ufw` frente a puertos publicados por Docker | INST-03 (D-08) | Depende del firewall real del host y del proveedor cloud | Con `ufw` activo en el VPS, comprobar que el aviso aparece y que el comando sugerido es correcto |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s (capa 1)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
