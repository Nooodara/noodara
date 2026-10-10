# 14-28: flakes de integración del gate 14-15 (run 2)

Log: `gate-14-15-it-full-run2.log`.

## events-sse.test.ts: 1 arranque lento -> 9 tests rojos

Causa raíz (dos partes):

1. testcontainers 12 espera un fijo de 10 s (no configurable) a que Docker publique los puertos
   (`inspectContainerUntilPortsExposed`). Si vence, lanza **sin parar ni borrar** el contenedor
   (a diferencia de un wait strategy fallido, que sí lo borra) y sin devolver handle:
   `startPostgres` no podía pararlo. Quedó `postgres:17-alpine` corriendo (el leak guard lo nombró).
2. El `afterEach` del archivo afirmaba "cero contenedores noodara.test en el host" sin borrar
   nada. El postgres huérfano hizo fallar el `afterEach` de **cada** test posterior (8 más).

Fix:

- `tests/integration/helpers/container-start.ts`: cada intento lleva un label único
  `noodara.test.start`; si falla, se borra lo que dejó por label. Solo el timeout de port-bind se
  reintenta, máximo 3 intentos (espera efectiva acotada 3 x 10 s), y luego falla con un error que
  nombra la imagen. Usado por `postgres.ts` y `redis.ts`.
- `events-sse.test.ts`: baseline por test (`snapshotTestResources`) y `afterEach` con
  `runTeardown` (14-27): cada paso acotado, el leak check va último y borra lo que quede. Un leak
  falla solo ese test. `startAppWithHeartbeat` para su postgres si `buildApp` lanza; la app del
  test "Redis unreachable" se cierra en `afterEach`.

Prueba (2026-10-10, este host):

- Copia temporal del archivo con un test extra que deja un postgres etiquetado corriendo y lanza
  el error de port-bind: `1 failed | 10 passed`, el leak guard del archivo no falló, 0 restos.
- `container-start.test.ts`: 7 tests, incluido uno contra Docker real que verifica el borrado.
- `events-sse.test.ts` solo: 3/3 verdes (~46 s c/u) y 3/3 verdes con 28 contenedores busybox en
  busy-loop (`noodara.stress=14-28`, técnica 14-26; ~3 min c/u). 0 contenedores noodara.test al final.

## contracts.test.ts ".invalid TLD": 4999.82 ms vs `>= 5000`

Causa: libuv programa timers con su reloj de loop en ms enteros (truncado) y cacheado por
iteración; `performance.now()` es sub-ms. Un `readyTimeout` de 5000 ms puede disparar hasta 1 ms
antes medido así (misma familia que 13-23). Tolerancia: 1 ms (resolución de ese reloj),
documentada en el test. Prueba: 20/20 ejecuciones consecutivas verdes del test (`-t "invalid TLD"`).
