# UX Review — Fase 13: Projects, Services e inspector

Fecha: 2026-10-06 · Commit: 1fa091a · Modo: screenshots + código
Veredicto global: **FLAG** (sin BLOCK)
Aprobación humana (A4): **pendiente**

Alcance: lista de proyectos, proyecto, servicio, sheets de crear proyecto / entorno / servicio,
inspector (build log y runtime logs). Screenshots en este directorio, light y dark, capturados con
`NOODARA_UI_REVIEW_CAPTURE=1 pnpm exec playwright test tests/e2e/projects-dod.spec.ts` (43/43 verde).
Las capturas son a 1280 y 375 px; 900 y 1920 se cubren con las aserciones de layout de A2, no con imágenes.

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| Tokens | PASS | Un solo acento (botones primarios, segmento activo); rojo solo en estado Failed. Sin hex inline (lint + escaneo de contraste A1 verde). |
| Superficie y elevación | PASS | Cards por escalón de superficie y hairlines; sombra solo en sheets (`packages/ui/src/Sheet.tsx:92`). Ver gap 1. |
| Tipografía y jerarquía | PASS | Título de página, label de sección, cuerpo. Mono en imagen, repo, puertos, duración y logs (`service-1280-*.png`). |
| Layout y espaciado | FLAG | A 375 px el título del servicio se reduce a un glifo y la toolbar parte en dos filas (`stress-service-375-light.png`, `service-375-dark.png`). La URL de repo de 300 caracteres se corta contra el borde derecho de la card ("pla…tform-" se pierde) (`stress-service-375-*.png`). |
| Componentes | PASS | InsetGroup, Sheet, StatusPill, SegmentedControl de `packages/ui`. Las credenciales no están en el sheet de crear (se añaden después, copy en `service-sheet-1280-*.png`). |
| Estados | PASS | Error de deploy accionable con `IMAGE_PULL_FAILED` y qué hacer; aviso neutro "This service has no container yet" en runtime logs; "Never deployed" con frase. |
| Progressive disclosure | FLAG | Crear un proyecto o un servicio no navega al recurso creado; el usuario tiene que buscarlo en la lista. En la lista a 375 px el nombre del proyecto se trunca antes que la descripción ("Payme…") (`stress-projects-375-dark.png`). |
| Copy | PASS | Inglés, sentence case, verbos concretos ("Create service", "New environment"). Los labels de sección en mayúsculas vienen del patrón InsetGroup (`packages/ui/src/InsetGroup.tsx:9`), no de estados. |
| Accesibilidad y temas | PASS | Light y dark. Contraste A1 y axe (cero serious/critical) verdes en todas las pantallas y ambos temas. Teclado, anillo de foco, focus trap y retorno de foco en los tres sheets verdes. Reduced motion verde. Estado por texto + icono. Sin secrets visibles. |

## Bloqueantes

Ninguno.

## Corregido en 13-20 (commit 1fa091a), verificado en esta pasada

1. Contraste: el item activo del nav medía 4.39:1 en light (`NavTree.tsx`, ahora un solo color de texto por estado).
2. Contraste: "Failed" en los pasos del deploy y el aviso de runtime logs en rojo sobre blanco (3.54:1); ahora tokens `--status-*-text`, y el aviso sin contenedor es neutro.
3. Foco: Escape en los sheets de proyecto, entorno y servicio dejaba el foco en `body`; `Sheet` ahora devuelve el foco a quien lo abrió.
4. Proyecto: una URL de repo de 300 caracteres reducía el nombre del servicio a "w"; la fuente se trunca y el nombre queda completo (`project-1280-light.png`).
5. Servicio: "Last changed" mostraba el timestamp ISO crudo junto a "just now"; ahora solo relativo, con el valor exacto en tooltip.
6. Timeline del deploy: la línea conectora cruzaba los iconos de los pasos; ahora va entre ellos.

## Correcciones sugeridas

1. Toolbar del servicio a 375 px: dar prioridad al título (`min-w` en el título, acciones secundarias a un menú) para que no quede en un glifo.
2. Valor de repositorio en ServiceFacts a 375 px: partir con `overflow-wrap:anywhere` dentro del padding de la card en lugar de recortarlo.
3. Después de crear un proyecto o servicio, navegar al recurso nuevo (o al menos resaltarlo en la lista).
4. Lista de proyectos a 375 px: dar prioridad de ancho al nombre sobre la descripción.
5. Verificar que la línea de acento vertical en la unión main/inspector (`inspector-*-1280-*.png`) sea solo foco visible y no un borde fijo.

## Notas

- Nombre de proyecto: el dominio acepta como máximo 64 caracteres. El caso de 200 caracteres de H2 se
  inyecta en la respuesta de la API (`tests/e2e/projects-dod.spec.ts`); no se puede crear desde la UI.
- Gap 1 para `noodara-ux-apple`: los sheets usan material translúcido (decisión de 08-UI-SPEC §5.1/5.2,
  `Sheet.tsx:91`), pero el design system dice translucidez solo en sidebar y toolbars. El botón de acento
  de atrás se ve difuminado en la esquina superior del sheet (`project-sheet-1280-light.png`). Hay que
  agregar los sheets a la regla o quitar la translucidez.

## Lo que está bien

- La vista de servicio muestra primero estado, fuente y último deploy; los logs están a un clic en el inspector.
- El error de deploy dice qué pasó, qué hacer y el código, sin culpar a Noodara.
- Un build log de 10.000 líneas queda dentro de su contenedor y muestra las últimas 2.000.
- Los dos temas tienen la misma jerarquía y ningún color decorativo.
