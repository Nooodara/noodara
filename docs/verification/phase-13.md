# Fase 13 — evidencia de verificación

Salidas copiadas de los logs de la corrida (2026-10-06/07).

## Integración (`pnpm test:integration`)

Primera corrida (`it-full.log`): 3 archivos del harness fallaron por una red Docker sobrante de una corrida matada.

```text
 Test Files  3 failed | 84 passed | 2 skipped (89)
      Tests  937 passed | 5 skipped (942)
   Duration  4313.79s (tests 99%, import 1%)
```

Los 3 archivos fallidos: `contracts-https-token`, `engine-primitives`, `harness` (22.04 y 24.04). Reejecución (`it-rerun.log`), verde:

```text
 Test Files  3 passed (3)
      Tests  32 passed (32)
   Duration  169.09s (tests 99%)
```

## E2E repeat (`pnpm test:e2e:repeat`)

Corrida 1 (`e2e-repeat.log`): la iteración 11 falló en `@sheet-drag` (re-grab a mitad de cierre); corregido en 13-22 (commit c76fc4d).

```text
  1 failed
    [chromium] › tests/e2e/server-sheet.spec.ts:587:3 › @sheet-drag ... re-grabbing mid-close resumes 1:1 tracking ...
  230 passed (5.2m)
e2e-repeat: iteration 11/20 FAILED (exit 1) after 3053s total -- stopping, not running the remaining iterations.
```

Corrida 2 (`e2e-repeat2.log`), tras el fix:

```text
  231 passed (5.2m)
e2e-repeat: all 20/20 iterations passed in 5848s total.
```

## Security scan (`pnpm security:scan-leaks`, `scan.log`)

```text
  ✓  1 [chromium] › tests/e2e/canary-ui.spec.ts:53:1 › @canary ... (3.6s)
  1 passed (10.8s)
```

## Lint, typecheck, boundaries

```text
pnpm lint        Tasks: 14 successful, 14 total
pnpm typecheck   exit 0 (13 tasks, sin errores TS)
pnpm boundaries  Checked 1213 files in 9 packages, no issues found
```

## Conteo de corridas (sin reintentos)

- `@sheet-drag` (`server-sheet.spec.ts --grep @sheet-drag`): 30/30 pass.
- `servers-list.spec.ts` + `a11y-fallbacks.spec.ts`: 10/10 pass.

## Rutas documentadas

`apps/control-plane/src/routes/route-docs.test.ts` falla si una ruta `/api/projects`, `/api/services` o `/api/deployments` registrada no está en `docs/deploy-engine.md`. Se completó la doc con `{stop|restart|remove}`.

## Gate de la tarea

`gate-1319.log` (corrida previa): test, typecheck, lint, boundaries, build, it-full ok.

Segunda corrida tras el review: `it-full` falló en `tests/integration/ssh/contracts.test.ts` (`.invalid` TLD, 4991 ms < 5000 ms) por medir con `Date.now()`; arreglado en 13-23 (`performance.now()`, commit 17842ca).

Corrida final (`gate-1319b.log`):

```
ok test: passed (pnpm test)
ok typecheck: passed (pnpm typecheck)
ok lint: passed (pnpm lint)
ok boundaries: passed (pnpm boundaries)
ok build: passed (NOODARA_API_ORIGIN=http://localhost:3100 pnpm build)
ok it-full: passed (pnpm test:integration)
ok all gates green
```
