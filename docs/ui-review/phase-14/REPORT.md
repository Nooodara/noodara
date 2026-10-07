# UX Review — Fase 14 / 14-13: deuda de 375 px

Fecha: 2026-10-07 · Commit: eb1de27 + working tree 14-13 (pasada 2) · Modo: screenshots + código
Veredicto global: **FLAG** (sin BLOCK)
Aprobación humana (A4): **pendiente**

Alcance: lista de proyectos, proyecto y servicio, en light y dark, a 375 y 1280 px. Screenshots en este directorio, capturados con `NOODARA_UI_REVIEW_CAPTURE=1 pnpm exec playwright test tests/e2e/projects-dod.spec.ts -g "14-13"` (8/8 verde). `stress-*` usa un nombre de servicio y una URL de repo de 300 caracteres sin cortes.

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| Tokens | PASS | Sin hex, rgb ni gradientes en los archivos tocados; un solo acento (Deploy, New project, New environment). Rojo solo en Failed. |
| Superficie y elevación | PASS | Cards por superficie y hairline; la única sombra es la del menú (`packages/ui/src/RowMenu.tsx:72`, `--shadow-floating`). |
| Tipografía y jerarquía | PASS | Display a 1280, title a 375 (`ServiceToolbar.tsx`); mono en imagen, repo, puertos. Pesos 400/600. |
| Layout y espaciado | FLAG | Servicio: toolbar en una fila a 375 y 1280, título con ≥12 caracteres, URL truncada al medio (`stress-service-375-*.png`, `stress-service-1280-*.png`). Proyecto a 375: el título desaparece y "← Projects" / "New environment" parten en dos líneas (`project-375-light.png`; `apps/web/src/components/Toolbar.tsx:117` es `flex-1 truncate` sin mínimo). |
| Componentes | PASS | `MiddleTruncate`, `LabelValue truncate="middle"`, `RowMenu`, `Button hitArea` de `packages/ui`; sin reimplementaciones. |
| Estados | PASS | "Never deployed" y "Failed" con frase; error de deploy con `IMAGE_PULL_FAILED` y qué hacer (`service-375-*.png`). |
| Progressive disclosure | PASS | A 375 Edit y Logs pasan al menú "⋯"; el primario (Deploy o Cancel) queda visible. URL completa en `title`, texto sr-only y botón de copia. |
| Copy | PASS | Inglés, sentence case; "Back to {project}" y "Actions for {service}" como nombres accesibles. |
| Accesibilidad y temas | PASS | Light y dark. axe a 375 en las tres pantallas, menú con `aria-expanded`, focus trap, Escape devuelve el foco, áreas táctiles de 44 px (e2e 14-13 H1). Sin scroll horizontal a 375/1280 (H2). La URL hostil se pinta como texto inerte. |

## Bloqueantes

Ninguno.

## Corregido en esta pasada (visto en las capturas, test RED primero)

1. Lista de proyectos a 375: el nombre perdía un subpíxel y mostraba elipsis con la descripción aún visible. Ahora el nombre no encoge (`max-w-full shrink-0`) y la descripción absorbe todo (`packages/ui/src/ListRow.tsx`). El e2e A3 compara la caja del texto, no `scrollWidth`.
2. Fila Status a 375: "Fail/ed" y "Never deploy/ed" partían a mitad de palabra. El caption toma solo el ancho sobrante (`min-w-0 flex-1`, `packages/ui/src/LabelValue.tsx`); e2e nuevo verifica una línea.
3. Servicio a 1280 con nombre largo: el pill se montaba sobre Logs y Edit. El wrapper del pill es `shrink-0` en layout full (`apps/web/src/components/ServiceToolbar.tsx`); H2 verifica que el pill queda dentro del bloque del título.
4. Servicio a 1280 con nombre corto: el h1 se estiraba a 12ch y el pill quedaba lejos del título. El mínimo de 12ch solo aplica a nombres de más de 12 caracteres.

## Correcciones sugeridas

1. Toolbar de proyecto a 375 (FLAG, fuera de A1): aplicar el patrón compacto de `ServiceToolbar` (flecha de 44 px, título con `min-w-[12ch]`, Edit/Archive/Delete en un `RowMenu`). Va en su propia tarea (14-19).

## Lo que está bien

- Una fila de toolbar con el primario siempre visible y el resto bajo demanda.
- Truncado al medio solo con CSS: conserva el final de la URL (`…g-componentx.git`), que es lo que distingue repos.
