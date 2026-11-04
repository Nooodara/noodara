# Infrastructure Graph y modelo de logs (v0.5, 26-03)

Código: `packages/domain/src/graph/` y `packages/domain/src/logs/`. Contratos de origen: ADR 0012
("Data placement" y "`docker logs`"), DECISIONS 2026-11-03.

## buildGraph (GRF-01)

`buildGraph(snapshot)` es pura. Entrada: servers, projects, environments, services, domains y el
env efectivo de cada servicio (`serviceEnv`, salida de `resolveEnv`).

| Relación | Desde → Hacia |
|---|---|
| `RUNS_ON` | Service → Server |
| `BELONGS_TO` | Service → Environment, Environment → Project |
| `EXPOSED_BY` | Service → Domain |
| `DEPENDS_ON` | Service → Service (`envKeys`: solo las keys) |

- Ids: nodo `<kind>:<entityId>` (kind en minúsculas), relación `<TYPE>:<from>-><to>`. Todo se
  ordena por id con comparación de code units, así que el JSON es idéntico byte a byte para la
  misma entrada en cualquier orden.
- Un id duplicado omite todas sus copias (`duplicate_id`). Un padre ausente omite la entidad
  (`missing_parent`), en cascada: environment sin project, service sin environment o server,
  domain sin service. Las omisiones van en `omitted`, ordenadas por kind e id.
- Invariantes (fixtures + property test con PRNG semillado): cada Service tiene un `RUNS_ON` y un
  `BELONGS_TO`, cada Environment un `BELONGS_TO`, ninguna relación apunta a un nodo inexistente,
  ningún Domain huérfano.

## Inferencia de DEPENDS_ON (ADR 0012)

A → B cuando un valor de env **plano** de A nombra a B:

- por su container name `noodara-<serviceId>` (solo ids UUID) o por uno de sus dominios;
- como valor completo o como host de una URL (`scheme://host…`), en minúsculas.

Se ignoran: `<secret:name>` (se saltan por `kind`, el nombre nunca se lee), autorreferencias,
servicios de otro proyecto, nombres desconocidos, un nombre compartido por dos servicios,
`host:port` sin scheme y menciones dentro de un texto. Entre environments del mismo proyecto sí
hay arista. Varias keys hacia el mismo B dan una sola arista.

## scopeGraph

`scopeGraph(graph, { projectIds?, environmentIds? })` falla cerrado (scope vacío = graph vacío).
Quedan los Projects autorizados, los Environments, Services y Domains dentro de esos proyectos o
environments, y los Servers donde corren esos services. Un scope de environment no incluye el
Project. Una relación sobrevive solo con ambos extremos dentro; `omitted` sale vacío.

## Logs (LOG-05/06)

| Constante | Valor |
|---|---|
| `LOG_SOURCES` | `build deploy runtime activity` |
| `LOG_LEVELS` | `info warn error` (nivel mínimo) |
| `LOG_WINDOW_DEFAULT_MS` | 15 min |
| `LOG_WINDOW_MAX_MS` | 24 h, inclusive |
| `LOG_SEARCH_MAX_LENGTH` | 200 |

- `parseLogFilter(input, nowMs)`: `sources` lista o CSV, sin duplicados, en orden canónico;
  `since`/`until` RFC 3339 con zona (fechas imposibles rechazadas); `until` default y tope now,
  `since` default `until − 15 min`; búsqueda en una línea, substring literal case-insensitive,
  nunca regex. Claves desconocidas se ignoran. Errores: `LOG_FILTER_ERRORS`; nunca repiten el
  término buscado.
- `logEntryMatches(entry, filter)` aplica el filtro a una entrada.
- `mergeLogEntries({ [source]: entries })`: orden por timestamp (con nanosegundos), luego orden
  de `LOG_SOURCES`, luego posición en su fuente; timestamps inválidos al final.
