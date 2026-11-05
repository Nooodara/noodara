# UX Review — Fase 30: métricas, logs, graph y AI

Fecha: 2026-11-05 · Commit base: a864e66a · Modo: screenshots + código
Veredicto global: **FLAG** (sin BLOCK)

Alcance: 30-01 (métricas y estado de servidor y servicio), 30-02 (vista de logs), 30-03 (Infrastructure
Graph), 30-04 (settings de AI BYOK y chat en el inspector). Capturas en este directorio
(`<pantalla>-<ancho>-<tema>.png`, 375 y 1280 px, dark y light), tomadas al final de los e2e de fase 30
(API stubbeada con `page.route`) más `capture.spec.ts` para el graph a 1280 px:

`caffeinate -is pnpm exec playwright test -c docs/ui-review/phase-30/playwright.capture.config.ts`

Los "Couldn't load ..." de dominios, variables y secrets en `service-logs-*` y `service-status-*` son
artefactos del stub (esos endpoints no se stubbean en los specs de logs y métricas), no del producto.

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| Tokens | PASS | Sin hex, `rgb()`, gradientes ni sombras en los componentes de fase 30 (grep sobre `components/{metrics,logs,graph,ai}` y `settings/page.tsx`). Azul solo en acciones y links; ámbar/rojo solo en pills de umbral ("High memory", "High disk"), nivel `warn` y "Out of memory" (`server-metrics-1280-dark.png`, `ai-chat-hostile-1280-dark.png`). |
| Superficie y elevación | PASS | Cards por escalón con hairlines entre filas; el chat vive en el inspector sin sombra (`ai-chat-1280-light.png`); graph como cards por environment (`graph-1280-light.png`). |
| Tipografía y jerarquía | PASS | Timestamps, fuentes, niveles, relaciones (`RUNS_ON`, `DEPENDS_ON`), hostnames, modelo y pista de la key en mono; valores de métricas con su unidad. Labels de sección en versalitas como el resto del detalle. |
| Layout y espaciado | FLAG | A 375 px la fila de log (timestamp + fuente + nivel, `ServiceLogsPanel.tsx:103-116`) se come el ancho y el mensaje (`flex-1 truncate`) queda en cero: solo se ven timestamp y fuente (`service-logs-375-light.png`); por eso 3 e2e de logs fallan en la variante 375 del capture. Sin desborde horizontal de página en ninguna captura; graph sin scroll horizontal a 375 (`graph-375-dark.png`). |
| Componentes | FLAG | El switch de Follow no tiene label visible junto al control, solo nombre accesible (`ServiceLogsPanel.tsx:338`, `service-logs-1280-dark.png`). Pills de umbral y de diagnóstico con dot + texto, del `TonePill` de `packages/ui`. |
| Estados | PASS | Métricas sin muestras, con lectura fallida y con servidor inalcanzable con copy propio; logs truncados y no disponibles explicados; AI `Unknown` lista la evidencia que faltó (`ai-chat-375-light.png`); errores de provider accionables. |
| Progressive disclosure | PASS | Respuesta primero, luego diagnóstico y confianza, chips de entidad; evidencia y "Tools consulted" colapsados. Graph: environment → servicio → relaciones, cada nodo navega a su detalle. Métricas: pills de umbral sobre la serie; el detalle por hover. |
| Copy | FLAG | Ejes y tooltip de los charts muestran ISO crudo ("2026-11-05T20:08:03.787Z") que se parte en dos líneas (`MetricChart.tsx:123-128`, `server-metrics-1280-dark.png`). Resto en inglés, sentence case, y los fallos dicen qué hacer ("Follow stopped ... Turn Follow on again."). |
| Accesibilidad y temas | PASS | Ambos temas con la misma jerarquía; estado por texto + dot; chart con `role="img"` y `aria-label` con el último valor; nodos del graph alcanzables por teclado (e2e 30-03). La API key nunca aparece: solo `••••••••6071` (`ai-settings-1280-light.png`); markup hostil en respuestas y nombres se muestra como texto inerte (`ai-chat-hostile-1280-dark.png`). |

## Bloqueantes

Ninguno.

## Correcciones sugeridas (para el backlog de UI)

1. Fila de log < 640 px: mensaje en su propia línea bajo timestamp/fuente/nivel, o fuente y nivel ocultos
   (siguen en el filtro); el e2e de follow debería pasar a 375.
2. Label visible "Follow" junto al switch.
3. Ejes y tooltip de métricas con hora local corta (`14:08`, y fecha solo si el rango cruza días), ISO
   completo en `title`.
4. Varios primarios azules en el detalle del servicio (Deploy, Add domain, Add variable, Add secret):
   heredado de fase 24, sigue abierto.

## Lo que está bien

- El chat declara "Read-only. The assistant can look at your infrastructure but never changes it." donde
  se pregunta, y Settings explica qué se envía al provider antes de guardar una key.
- `Unknown` no inventa: dice qué evidencia faltaba y con qué confianza.
- Las pills de umbral aparecen solo cuando se cruza el umbral, sin decorar el resto de los charts.
- El graph a 375 cae a un árbol legible con relaciones en mono, sin scroll horizontal.
