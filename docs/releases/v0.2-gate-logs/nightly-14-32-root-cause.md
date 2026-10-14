# 14-32 — causa raíz del fallo `@sheet-drag` (nightly 38530970865, iteración 3)

Log: `nightly-38530970865-sheet-drag.log`. `server-sheet.spec.ts` "after a fast release the panel
keeps moving…": `Expected >= 2.54519, Received 1.6506` (el panel "retrocede" un frame después del release).

## Causa

Carrera de muestreo en el test, no el exit con keyframes de 14-26.

- `readDragSurfaceX` lee el `transform` inline de la superficie interna (`m.div`). El exit CSS de
  14-26 anima el `Content` externo, así que no puede mover ese valor.
- `LazyMotion` adjunta el gesto de drag solo cuando carga el chunk lazy de `domMax`. Bajo carga, el
  test hizo `mouse.down()` antes de eso: Motion ignoró el press y lo que se midió fue el spring de
  entrada (8px → 0) decayendo. De ahí 2.545 → 1.651.

## Prueba

- RED determinista: `page.route` retrasando 8 s el chunk del gesto (`34-uhvxdrn0x-.js`) reprodujo el
  mismo mensaje byte a byte. Timeline instrumentado: `pointerdown` a 9315 ms, listener de drag a 9371 ms.
- GREEN con el mismo retardo de 8 s tras el fix: 6/6 `@sheet-drag` en verde.

## Fix

- `packages/ui/src/Sheet.tsx`: el Sheet carga las features él mismo y se las pasa a `LazyMotion` de
  forma síncrona. Renderiza `data-drag-ready` en la superficie solo con features cargadas y sin reduced
  motion, en el mismo commit cuyo layout effect adjunta el gesto.
  Tests de componente: `Sheet.test.tsx` "Sheet drag readiness" (RED visto; el mutante `drag={false}` se detecta).
- `tests/e2e/server-sheet.spec.ts`: `dragSurfaceCenter` (y el re-grab) esperan `data-drag-ready` antes
  de presionar. El test de resistencia muestrea tras 2 frames en vez de un sleep de 30 ms.
  Sin retries, sin subir timeouts, sin relajar asserts.

## Verificación

`@sheet-drag` son 6 tests; `--repeat-each 20` = 120 ejecuciones. Carga: 28 contenedores busy-loop
(`noodara.stress=14-32`) en 14 vCPUs, load average 40-90.

| Prueba | Resultado |
|---|---|
| Chunk del gesto retrasado 8 s | 6/6 passed |
| Carga, x20 | 120/120 passed |
| Carga + CDP `setCPUThrottlingRate` 4, x20 | 120/120 passed |
| Carga + throttle 10, x20 (fast-release, el test del nightly: 20/20) | 99/120: resistencia 0/20, flick 19/20 |
| Idle: `server-sheet`, `keyboard-motion`, `a11y-fallbacks` | 35/35 passed |

## Hallazgo aparte (no corregido aquí)

El test "resists progressively" pasa por una carrera. `DRAG_ELASTIC_AT_REST` es lineal (0.15), así que
cada paso de 40 px suma 6 px. La aserción `increments[0] > increments.at(-1)` solo se cumple porque el
grab toma como origen lo que queda del spring de entrada (~1.6 px): muestras `[7.58, 13.58, …, 31.58]`.
Con throttle 10 el spring ya terminó al presionar y las muestras son `[6, 12, 18, 24, 30]`. Pasa lo
mismo en cualquier runner que tarde más que el spring entre `data-drag-ready` y el press. Arreglarlo
exige decidir el producto: una curva de resistencia realmente progresiva (brief §7.4 paso 5), o
asumir el elástico lineal y cambiar la aserción.
