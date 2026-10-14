# Fase 14 — verificación

Cierre: 2026-10-14; correcciones de la revisión tier-1 en 14-35. `v0.2.0` publicado sobre `d828db4` (= `v0.2.0-rc.2`) en `Nooodara/noodara`.

## Evidencia de release (capturada con `gh` y `docker buildx`)

| Hecho | Evidencia |
|---|---|
| Tag anotado `v0.2.0` → commit `d828db46bf7f…` | `docs/releases/v0.2-gate-logs/release-v0.2.0-tag.txt` |
| release.yml run 38606580357 success (10/10 jobs) | mismo archivo |
| GitHub release `v0.2.0`: no draft, no prerelease, Latest | mismo archivo |
| `noodara-control-plane:0.2.0` `sha256:c69ef237…`, `noodara-web:0.2.0` `sha256:70363bdb…`, amd64 + arm64 | `release-v0.2.0-images.txt` |
| CI run 38577823569 10/10; Nightly run 38577823485 7/7 (installer verde en el intento 2) | `ci-nightly-d828db4.txt` |

El monorepo local no tiene remote ni tags: sus SHAs difieren de los publicados (subtree split + rebase).

## Requisitos y evidencia

| Req | Evidencia |
|---|---|
| OPS-01 | Rotación `logging` en Compose y poda de `.env.bak-*` (quedan 5): tests de Compose y suite del instalador. |
| OPS-02 | Imagen de control-plane bajo 600 MB; el test de imagen arranca los cuatro entrypoints desde `dist`. |
| OPS-03 | `check-posix-sh` con regresiones por caso; workarounds de `install.sh` retirados (14-04). |
| OPS-04 | `docs/releases/v0.2-HUMAN-UAT.md` y `v0.2-uat-logs/`: install, upgrade 0.1.0 → rc.2 → 0.2.0 y rollback reales. Las verificaciones de host real pendientes pasan a OPS-05. |
| OPS-05 | Diferido (owner: usuario): VPS público, Ubuntu 22.04, arm64, `ufw` activo, 1–2 GB. |
| Gate v0.2 | `docs/releases/v0.2-gate.md`: NOT READY por la regla estricta (cinco filas UNVERIFIED → OPS-05); `v0.2.0` publicado con esa deuda aceptada. `scripts/check-gate-doc.mjs` (en `pnpm test`) exige log o run id en cada fila READY/PASS. |

## Rondas rojas 14-21..14-34

- 14-21..14-23: CI en verde sobre main (migraciones idempotentes, next/sharp, e2e del menú compacto).
- 14-24..14-26: flakes e2e nocturnos, kill en 22.04, animación de salida del Sheet.
- 14-27/14-28: contenedores de test filtrados y arranques seguros ante colisión de puertos.
- 14-29..14-31: bugs de la UAT rc.1 (pin `v`, BuildKit desconocido, workspace en `~`, LFS, "rolled back").
- 14-32..14-34: CI en 80f4f93, overscroll progresivo del Sheet, foco diferido.

## Correcciones de la revisión (14-35)

- Gate reescrito sobre `d828db4` con veredicto honesto y evidencia de tag/release.
- 14-15 H1: `scripts/check-gate-doc.mjs` + `tests/unit/scripts/check-gate-doc.test.ts`.
- 14-31 sin RED previo: prueba retroactiva en `docs/releases/v0.2-gate-logs/tdd-14-31-red-proof.log` (tests de 7e9d18c contra 7e9d18c^, 11 fallos por la razón correcta).
- OPEN_QUESTIONS #13: `installer-dind.ts` repite un build fallido con la salida capturada y dice si es transitorio o real (`installer-dind.test.ts`).

## Deuda conocida

OPS-05 (host real). OPEN_QUESTIONS #8 (rotar la master key local, usuario). #4, #5, #6, #9 y #10 confirmadas por el usuario (DECISIONS 2026-10-14).
