# Observabilidad y diagnóstico (v0.5, 26-02)

Código: `packages/domain/src/observability/`. Contratos de origen: ADR 0012.

## Parsers (A1)

| Función | Entrada | Errores |
|---|---|---|
| `parseHostSample` | salida de `HOST_SAMPLE` (CPU×2, MEM, DF, UP) | `OUTPUT_TOO_LARGE`, `OUTPUT_TRUNCATED`, `HOST_SAMPLE_MALFORMED`, `HOST_SAMPLE_INCOMPLETE` |
| `parseContainerSample` | salida de `CONTAINER_SAMPLE` (`I <json>`, `S <stats>`) | `OUTPUT_TOO_LARGE`, `OUTPUT_TRUNCATED`, `CONTAINER_SAMPLE_MALFORMED` |

- Salida de exactamente el cap (`head -c`, 64 KiB) o sin `\n` final = truncada; por encima = demasiado grande.
- Las líneas sin prefijo conocido son stderr (`2>&1`) y se ignoran. El inspect es estricto: una clave de más se rechaza.
- `cpuPercent(prev, next)` devuelve `null` en la primera muestra, wrap o delta 0. Esto reemplaza el "0 cuando Δtotal ≤ 0" del ADR.
- `HostConfig.Memory = 0` da `memoryLimitBytes = null`, nunca el total del host.

## Umbrales (A2, H1)

| Constante | Valor | Política |
|---|---|---|
| `HIGH_DISK_PERCENT` | 90 | `highDisk`, `nearFullDisk`: used / (used + avail), como `Use%` de df; 0 bloques = sin flag |
| `HIGH_MEMORY_PERCENT` | 90 | `highMemory`: las últimas N lecturas ≥ 90 % del límite; sin límite se usa MemTotal del host; sin total = sin flag |
| `HIGH_MEMORY_SUSTAINED_SAMPLES` | 3 | N |

## Observación de contenedor (A3)

`observeContainer(history)` → `ContainerRuntimeObservation` (se llama así porque `ContainerObservation` ya existe en `deployment`).

- `crashLoop`: el `RestartCount` crece ≥ 3 (`CRASH_LOOP_MIN_RESTARTS`) dentro de `CRASH_LOOP_WINDOW_MS` (10 min). Cuando el conteo baja, el contenedor se recreó y solo cuenta el crecimiento posterior.
- `outOfMemory`: `OOMKilled`, o exit 137 parado con la última lectura de memoria ≥ 90 % del límite.
- `healthcheck`: `none | starting | healthy | failing | timeout`. Si está unhealthy, la última sonda decide: exit -1 es `timeout`, cualquier otro es `failing`.

## Diagnóstico (A4)

`classifyEvidence(evidence)` es pura: cada candidato lleva `rank` (1 = más probable) y las `ref` de la evidencia que lo sostiene. Si ninguna regla aplica, devuelve solo `unknown`. El orden es `DIAGNOSIS_RANK`:

`server_unreachable > out_of_memory > crash_loop > healthcheck_timeout > port_not_responding > failed_deployment > container_stopped > high_memory > high_disk`

`failed_deployment` = estado `FAILED` o `ROLLED_BACK`. El gate `coverage-state-machine` exige 100 % en `thresholds.ts` y `diagnosis.ts`.
