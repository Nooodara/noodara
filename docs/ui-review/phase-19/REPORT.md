# UX Review — Fase 19: motor confiable (healthcheck, webhooks, rollback)

Fecha: 2026-10-18 · Commit: 4be032e · Modo: screenshots + código
Veredicto global: **FLAG** (sin BLOCK)
Aprobación humana (A3): **aprobada** por el usuario (2026-10-18)

Alcance: servicio con historial y rollback, diálogo de rollback, ajustes de healthcheck y rollback
automático en el sheet de servicio, panel de webhook. Capturas en este directorio (375 y 1280 px, dark y
light), generadas con datos reales del deploy host e2e (dos pushes buenos y uno con healthcheck fallido
que termina en "Rolled back"):

`NOODARA_UI_REVIEW_CAPTURE=1 pnpm exec playwright test -c docs/ui-review/phase-19/playwright.capture.config.ts`

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| Tokens | PASS | Un solo acento (Deploy, Roll back, Save, links); rojo/verde solo en estados de deploy. Sin gradientes ni hex inline. |
| Superficie y elevación | PASS | Cards por escalón y hairlines; el diálogo y el sheet son los únicos con material elevado (`rollback-dialog-*`, `service-sheet-healthcheck-*`). |
| Tipografía y jerarquía | FLAG | SHAs en mono en el historial y en las entregas, pero no dentro de la frase del diálogo ("Roll back to 815fd63?", `rollback-dialog-375-dark.png`). El título "Deployments" usa un nivel distinto al de los labels de sección (LATEST DEPLOYMENT) y queda con otra sangría (`service-history-1280-dark.png`). |
| Layout y espaciado | FLAG | A 375 px el historial parte cada fila en dos o tres líneas y el botón "Roll back" cae a la derecha de la tercera (`service-history-375-light.png`). Rotate secret / Disable no alinean con el texto de arriba en el panel (`webhook-panel-1280-dark.png`). Sin desborde horizontal en ninguna captura. |
| Componentes | PASS | Sheet, Dialog, StatusPill (dot + texto), InsetGroup de `packages/ui`. Un solo botón primario por vista; Roll back del historial es secundario. |
| Estados | FLAG | El diálogo de rollback no avisa de la breve interrupción mientras el contenedor se reemplaza (hasta v0.4, ver docs de rollback). Las entregas del webhook muestran "Deployed" también para el push cuyo deploy terminó en "Rolled back". |
| Progressive disclosure | PASS | El servicio muestra estado, último deploy e historial; webhook y ajustes de healthcheck están a un clic (link / Edit). El secret se muestra una sola vez y no aparece en ninguna captura. |
| Copy | FLAG | "Health check" (timeline) vs "Healthcheck" (sheet). El error dice qué pasó y qué hacer, con `HEALTHCHECK_FAILED`. Resto en inglés, sentence case. |
| Accesibilidad y temas | PASS | Ambos temas con la misma jerarquía; estado por texto + icono (Failed, Restored, Rolled back); el sheet es dialog con foco; Edit pasa al menú de acciones a 375 px. Contraste AA cubierto por la suite e2e de contraste de fases previas. |

## Bloqueantes

Ninguno.

## Correcciones sugeridas (fuera del alcance de 19-06, para el backlog de UI)

1. Diálogo de rollback: SHA en mono y una línea sobre la interrupción breve hasta v0.4.
2. Historial a 375 px: columna de acción fija para que "Roll back" no baile entre filas.
3. Alinear "Deployments" con el patrón de label de sección y su sangría.
4. Panel de webhook: alinear las acciones secundarias al borde izquierdo del contenido.
5. Unificar "Health check" / "Healthcheck" (propuesta: "Health check" en toda la UI).
6. Entregas del webhook: mostrar el resultado final del deploy ligado, no solo "Deployed".

## Lo que está bien

- El fallo del healthcheck muestra el paso fallido, el rollback "Restored" y qué hacer.
- Los ajustes de healthcheck usan progressive disclosure: path, puerto y estados solo con HTTP.
- La URL del webhook y los SHAs se leen en mono y no desbordan a 375 px.
