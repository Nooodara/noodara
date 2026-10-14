# Fase 14 — verificación

Cierre: 2026-10-14. `v0.2.0` publicado sobre `d828db4`. CI 10/10 y Nightly 7/7 (e2e-repeat 20/20; installer en verde en el reintento, ver OPEN_QUESTIONS #13).

## Requisitos y evidencia

| Req | Evidencia |
|---|---|
| OPS-01 | Rotación `logging` en los servicios de Compose y poda de `.env.bak-*` (quedan 5): tests de Compose y suite del instalador. |
| OPS-02 | Imagen de control-plane reducida bajo 600 MB; el test de imagen arranca los cuatro entrypoints desde `dist`. |
| OPS-03 | `check-posix-sh` con regresiones por caso; workarounds de `install.sh` retirados (14-04). |
| OPS-04 | `docs/releases/v0.2-HUMAN-UAT.md` y `v0.2-uat-logs/`: install, upgrade 0.1.0 → rc.2 → 0.2.0 y rollback reales; deuda aceptada abajo. |
| Gate v0.2 | `docs/releases/v0.2-gate.md` READY en lo automatizable; QA-10 y poda de build cache (D12) registrados. |

## Rondas rojas 14-21..14-34

- 14-21..14-23: CI en verde sobre main (migraciones idempotentes, next/sharp, e2e del menú compacto).
- 14-24: flakes e2e nocturnos (resync, puertos, teardown).
- 14-25: kill confirmado en 22.04 espera la salida del build.
- 14-26: carreras e2e bajo carga y animación de salida del Sheet.
- 14-27/14-28: contenedores de test filtrados y arranques seguros ante colisión de puertos.
- 14-29: pin con `v` en el instalador (Compose interpola la versión normalizada).
- 14-30/14-31: workspace de deploy en `~`, `WORKSPACE_UNAVAILABLE`, LFS solo con evidencia real, aviso de BuildKit y "rolled back".
- 14-32: fallos de CI en 80f4f93; el Sheet señala que está listo para arrastrar.
- 14-33: overscroll progresivo del Sheet (decisión del usuario).
- 14-34: foco diferido nunca roba el foco ya movido por el usuario.

## Hallazgos del UAT (rc.1)

Los cinco corregidos: (1) pin con `v` rompía el pull, (2) BuildKit `NULL` tras el upgrade de v0.1, (3) workspace exigía root, (4) falso positivo de Git LFS, (5) rollback anunciado como "Upgraded".

## Deuda conocida (aceptada, DECISIONS 2026-10-14)

VPS público real, Ubuntu 22.04, arm64, ufw activo y VPS de 1–2 GB sin verificar en hardware real. Abiertas: OPEN_QUESTIONS #4, #5, #6, #9, #10 (confirmar), #8 (rotar la master key local), #13.
