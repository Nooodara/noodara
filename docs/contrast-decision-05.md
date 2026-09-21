# Decisión de contraste — Plan 05-33

Cierra la mitad de contraste del gap 4 (item 3) de `05-VERIFICATION.md`, junto con `docs/ui-review-05.md`
Accessibility FLAG 1 (contraste de status pills, escalado a gap closure por el usuario el 2026-09-20) y
WR-C-08 (`--ink-tertiary` usado como texto de contenido).

Todas las cifras de este documento se calcularon con `packages/ui/src/contrast.ts`
(`relativeLuminance`/`contrastRatio`/`compositeOver`, implementación WCAG 2.x pinneada por
`packages/ui/src/contrast.test.ts`), nunca estimadas a mano. El umbral aplicado es 4.5:1 (WCAG 1.4.3,
texto normal — ninguno de los pares auditados es texto "large" en el sentido de la norma, así que no
aplica el umbral 3:1). Las cifras se reportan truncadas a 2 decimales (4.496 se reporta 4.49, nunca 4.5).

## 1. Medición actual (2026-09-20, antes de cualquier cambio)

### 1.1 Auditoría automática (el alcance exacto que Task 3 convierte en gate)

`--on-accent` sobre `--accent`; cada `--status-*` sobre su propio `-soft` compuesto sobre `--surface-1`;
`--ink`, `--ink-secondary`, `--ink-tertiary` sobre `--canvas`, `--surface-1`, `--surface-2`, `--surface-3`.
17 pares por tema, 34 en total. Lista derivada en tiempo de ejecución de los nombres de tokens
parseados de `tokens.css` (`auditTheme` en `contrast.ts`), no de una lista escrita a mano — un futuro
`--status-nuevo` + `--status-nuevo-soft` se audita automáticamente.

**LIGHT**

| Par | fg | bg efectivo | Ratio | Veredicto |
|---|---|---|---|---|
| `--on-accent` / `--accent` | `#ffffff` | `#0071e3` | 4.69 | PASS |
| `--status-ok` / `--status-ok-soft` sobre `--surface-1` | `#34c759` | `#e3f7e8` | 1.98 | **FAIL** |
| `--status-warn` / `--status-warn-soft` sobre `--surface-1` | `#ff9500` | `#fff0db` | 1.96 | **FAIL** |
| `--status-error` / `--status-error-soft` sobre `--surface-1` | `#ff3b30` | `#ffe4e2` | 2.94 | **FAIL** |
| `--status-idle` / `--status-idle-soft` sobre `--surface-1` | `#8e8e93` | `#efeff0` | 2.83 | **FAIL** |
| `--ink` / `--canvas` | `#1d1d1f` | `#f5f5f7` | 15.45 | PASS |
| `--ink` / `--surface-1` | `#1d1d1f` | `#ffffff` | 16.82 | PASS |
| `--ink` / `--surface-2` | `#1d1d1f` | `#fafafc` | 16.14 | PASS |
| `--ink` / `--surface-3` | `#1d1d1f` | `#f0f0f2` | 14.78 | PASS |
| `--ink-secondary` / `--canvas` | `#6e6e73` | `#f5f5f7` | 4.65 | PASS |
| `--ink-secondary` / `--surface-1` | `#6e6e73` | `#ffffff` | 5.07 | PASS |
| `--ink-secondary` / `--surface-2` | `#6e6e73` | `#fafafc` | 4.86 | PASS |
| `--ink-secondary` / `--surface-3` | `#6e6e73` | `#f0f0f2` | 4.45 | **FAIL** (por poco) |
| `--ink-tertiary` / `--canvas` | `#aeaeb2` | `#f5f5f7` | 2.03 | **FAIL** |
| `--ink-tertiary` / `--surface-1` | `#aeaeb2` | `#ffffff` | 2.21 | **FAIL** |
| `--ink-tertiary` / `--surface-2` | `#aeaeb2` | `#fafafc` | 2.12 | **FAIL** |
| `--ink-tertiary` / `--surface-3` | `#aeaeb2` | `#f0f0f2` | 1.94 | **FAIL** |

**DARK** (el tema por defecto de una instalación nueva)

| Par | fg | bg efectivo | Ratio | Veredicto |
|---|---|---|---|---|
| `--on-accent` / `--accent` | `#ffffff` | `#2997ff` | 3.01 | **FAIL** |
| `--status-ok` / `--status-ok-soft` sobre `--surface-1` | `#30d158` | `#203627` | 6.41 | PASS |
| `--status-warn` / `--status-warn-soft` sobre `--surface-1` | `#ff9f0a` | `#3d2f1c` | 6.29 | PASS |
| `--status-error` / `--status-error-soft` sobre `--surface-1` | `#ff453a` | `#3d2323` | 4.21 | **FAIL** (por poco) |
| `--status-idle` / `--status-idle-soft` sobre `--surface-1` | `#8e8e93` | `#2d2d2f` | 4.21 | **FAIL** (por poco) |
| `--ink` / `--canvas` | `#f5f5f7` | `#161618` | 16.59 | PASS |
| `--ink` / `--surface-1` | `#f5f5f7` | `#1d1d1f` | 15.45 | PASS |
| `--ink` / `--surface-2` | `#f5f5f7` | `#252527` | 14.05 | PASS |
| `--ink` / `--surface-3` | `#f5f5f7` | `#2a2a2c` | 13.15 | PASS |
| `--ink-secondary` / `--canvas` | `#a1a1a6` | `#161618` | 7.02 | PASS |
| `--ink-secondary` / `--surface-1` | `#a1a1a6` | `#1d1d1f` | 6.54 | PASS |
| `--ink-secondary` / `--surface-2` | `#a1a1a6` | `#252527` | 5.94 | PASS |
| `--ink-secondary` / `--surface-3` | `#a1a1a6` | `#2a2a2c` | 5.56 | PASS |
| `--ink-tertiary` / `--canvas` | `#6e6e73` | `#161618` | 3.56 | **FAIL** |
| `--ink-tertiary` / `--surface-1` | `#6e6e73` | `#1d1d1f` | 3.31 | **FAIL** |
| `--ink-tertiary` / `--surface-2` | `#6e6e73` | `#252527` | 3.01 | **FAIL** |
| `--ink-tertiary` / `--surface-3` | `#6e6e73` | `#2a2a2c` | 2.82 | **FAIL** |

Resumen: 17 de 34 pares fallan. Light: 4 status + 4 ink-tertiary + 1 ink-secondary (por poco) = 9 fallos
de 17. Dark: 1 accent + 2 status (por poco) + 4 ink-tertiary = 7 fallos de 17. La única superficie
que pasa en ambos temas sin excepción es `--ink` (texto principal) e `--ink-secondary` en dark.

### 1.2 Pares adicionales citados por WR-C-08 (`05-REVIEW.md`, no forman parte del gate automático
### derivado arriba — son usos de componente específicos, medidos aquí porque informan la decisión)

| Par | Sitio | fg | bg efectivo | Ratio | Veredicto |
|---|---|---|---|---|---|
| `--ink-tertiary` / `--status-error-soft` sobre `--surface-1` | `Banner.tsx:45` (`errorCode`) — light | `#aeaeb2` | `#ffe4e2` | 1.83 | **FAIL** |
| `--ink-tertiary` / `--status-error-soft` sobre `--surface-1` | `Banner.tsx:45` (`errorCode`) — dark | `#6e6e73` | `#3d2323` | 2.83 | **FAIL** |
| `--status-error` / `--surface-1` | `Field.tsx` (mensaje de error inline) — light | `#ff3b30` | `#ffffff` | 3.54 | **FAIL** |
| `--status-error` / `--surface-1` | `Field.tsx` (mensaje de error inline) — dark | `#ff453a` | `#1d1d1f` | 4.94 | PASS |
| `--status-error` / `--surface-3` | `RowMenu.tsx` (ítem "Delete") — light | `#ff3b30` | `#f0f0f2` | 3.11 | **FAIL** |
| `--status-error` / `--surface-3` | `RowMenu.tsx` (ítem "Delete") — dark | `#ff453a` | `#2a2a2c` | 4.20 | **FAIL** |

Este plan solo puede cambiar VALORES de tokens (`files_modified`: `tokens.css`, `contrast.ts`,
`contrast.test.ts`, `StatusPill.tsx`, este documento) — no puede tocar `Banner.tsx`, `Field.tsx` ni
`RowMenu.tsx` para migrar esos call sites de `--ink-tertiary`/`--status-error` a un token más oscuro.
Por eso la única palanca disponible en este plan para estos tres pares es oscurecer el propio token
`--ink-tertiary` (o `--status-error`) lo suficiente como para que **todo** call site existente pase,
incluido el caso Banner. Ver sección 2 para los números concretos y el costo de hacerlo así.

### 1.3 Discrepancias con `docs/ui-review-05.md`

Todas las discrepancias encontradas son de ±0.01 y se explican por convención de redondeo: este módulo
trunca (`roundDown`, la regla explícita de este plan: "4.496 se reporta 4.49, nunca 4.5"), mientras que
`docs/ui-review-05.md` redondea de forma estándar. Los inputs (hex, fondos compuestos) coinciden
exactamente en todos los casos verificados — confirmado por coincidencias exactas donde el truncado y el
redondeo dan el mismo resultado (`status-ok`/`status-warn` light: 1.98/1.96 exactos; `ink-tertiary` en
`surface-1`/`surface-2` light: 2.21/2.12 exactos; el propio caso Banner: 1.83 exacto; `status-error` en
ambas superficies dark: 4.94/4.20 exactos).

| Par | Este documento | `ui-review-05.md` | Diferencia |
|---|---|---|---|
| `--on-accent`/`--accent` dark | 3.01 | 3.02 | redondeo |
| `--status-error` light (pill) | 2.94 | 2.95 | redondeo |
| `--status-idle` light (pill) | 2.83 | 2.84 | redondeo |
| `--status-idle` dark (pill) | 4.21 | 4.22 | redondeo |
| `--status-ok` dark (pill) | 6.41 | 6.42 | redondeo |
| `--status-warn` dark (pill) | 6.29 | 6.30 | redondeo |
| `--ink-tertiary`/Banner bg dark | 2.83 | 2.84 | redondeo |
| `--status-error`/`--surface-1` light | 3.54 | 3.55 | redondeo |
| `--status-error`/`--surface-3` light | 3.11 | 3.12 | redondeo |
| `--ink-secondary`/`--surface-3` light | 4.45 | 4.46 (~"4.46") | redondeo |

Ninguna discrepancia cambia un veredicto PASS/FAIL. La cifra "3.02:1" citada en `05-33-PLAN.md` y en
`05-VERIFICATION.md` para el par accent dark es la única con visibilidad amplia en el proyecto; este
documento la trata como no autoritativa a partir de ahora — el 3.01:1 truncado es la cifra
reproducible por `contrast.test.ts`.

`git diff packages/ui/tokens.css` está vacío en este punto — ningún valor de token fue tocado en esta
tarea.

## 2. Candidatos (Task 2 — DECISIÓN PENDIENTE)

Las tres opciones cierran los 17 fallos del gate automático (sección 1.1). Todas respetan: un solo
azul de acción; `--status-*` reservado a estado de infraestructura; sin gradiente ni sombra nueva;
dark first-class y light obligatorio. Todos los valores fueron recalculados con `contrast.ts`
(`auditTheme`), no estimados.

Las tres candidatas comparten dos arreglos idénticos y de bajo costo visual que no dependen del eje que
se elija:

- **`--ink-secondary` (light)**: `#6e6e73` → `#6c6c71` (fallo por poco en `--surface-3`: 4.45 → 4.58;
  las otras tres superficies, ya en PASS, suben levemente). Cambio casi imperceptible.
- **`--ink-tertiary` (ambos temas)**: light `#aeaeb2` → `#68686b` (4.87 en el peor caso genérico
  `--surface-3`, 4.61 contra el fondo compuesto de `Banner.tsx`); dark `#6e6e73` → `#919195` (4.56 en
  `--surface-3`, 4.57 contra `Banner.tsx`). **Costo real, no cosmético**: en light, `#68686b` queda más
  oscuro que el propio `--ink-secondary` actual (`#6e6e73`) — el oscurecimiento necesario para que
  `--ink-tertiary` pase incluso contra el fondo rojizo de `Banner.tsx` casi borra la jerarquía de tres
  pasos ink/ink-secondary/ink-tertiary que el skill define (terciario debería leerse más débil que
  secundario, no igual o más fuerte). Una alternativa que preserva mejor la jerarquía es aceptar que
  `--ink-tertiary` solo pase contra las 4 superficies planas (`#737375` light / `#828287` dark, sección
  1.1) y dejar el caso `Banner.tsx` (1.83→2.9 aprox, seguiría en FAIL) como un ítem explícitamente
  diferido a un plan que sí pueda tocar `Banner.tsx` y mover ese call site a `--ink-secondary` —
  ver la pregunta al final de esta sección.

### Candidato A — Oscurecer para AA, mantener la familia de color (recomendado)

Eje: oscurecer/aclarar cada token que falla, sin tocar ningún componente más allá de `StatusPill.tsx`
si hiciera falta (no hace falta en A — cero cambios de clase).

| Token | Tema | Actual | Propuesto | Ratio antes → después |
|---|---|---|---|---|
| `--accent` | dark | `#2997ff` | `#1f73c2` | 3.01 → 4.89 |
| `--status-ok` | light | `#34c759` | `#207b37` | 1.98 → 4.74 |
| `--status-warn` | light | `#ff9500` | `#9e5c00` | 1.96 → 4.70 |
| `--status-error` | light | `#ff3b30` | `#c22d24` | 2.94 → 4.72 |
| `--status-idle` | light | `#8e8e93` | `#69696d` | 2.83 → 4.75 |
| `--status-error` | dark | `#ff453a` | `#ff584e` | 4.21 → 4.61 |
| `--status-idle` | dark | `#8e8e93` | `#959599` | 4.21 → 4.60 |
| `--ink-secondary` | light | `#6e6e73` | `#6c6c71` | 4.45 → 4.58 |
| `--ink-tertiary` | light | `#aeaeb2` | `#68686b` | 1.94 → 4.87 |
| `--ink-tertiary` | dark | `#6e6e73` | `#919195` | 2.82 → 4.56 |

Verificado con `auditTheme`: **0 de 17 pares falla en light, 0 de 17 en dark** (antes: 9 y 7). El par
`Banner.tsx` composited también pasa (4.61 light / 4.57 dark) porque `--ink-tertiary` se oscureció
pensando en ese caso, no solo en el genérico.

**Costo visual**: el azul de acción en dark pierde saturación/vivacidad perceptible (de un azul "iOS
system blue" a un azul más apagado/naval); `--status-warn` en light pasa de naranja vivo a un
marrón-anaranjado notablemente más oscuro — el cambio de mayor impacto perceptual de los tres
candidatos; y el costo de jerarquía de `--ink-tertiary` descrito arriba.

### Candidato B — Cambiar qué va encima del color, no el color

Eje: `--accent` y los cuatro `--status-*` NO cambian de valor. En su lugar cambia qué texto se dibuja
encima: `--on-accent` deja de ser blanco fijo en dark, y los status pills pasan de "tinte suave +
texto a saturación completa" a "relleno sólido a saturación completa + texto tinta oscura" — un
cambio de tratamiento visual, no solo de número.

| Token | Tema | Actual | Propuesto | Ratio antes → después |
|---|---|---|---|---|
| `--on-accent` | dark | `#ffffff` | `#1d1d1f` (reutiliza el valor ya existente de `--surface-1`/`--ink` dark) | 3.01 → 5.58 |
| `--ink-secondary` | light | `#6e6e73` | `#6c6c71` | 4.45 → 4.58 |
| `--ink-tertiary` | light/dark | igual que Candidato A | igual que Candidato A | igual que Candidato A |

Status pills (StatusPill.tsx cambia de `bg-status-*-soft text-status-*` a `bg-status-* text-<ink
oscura>` — un cambio real de clase, no solo de token; el dot ya no puede usar `bg-current` porque el
texto y el dot dejarían de compartir color, así que el dot pasa a una clase `bg-status-*` explícita):

| Estado | Tema | Fondo (sin cambio de valor) | Texto | Ratio |
|---|---|---|---|---|
| ok | light | `#34c759` | `#1d1d1f` | 7.58 |
| warn | light | `#ff9500` | `#1d1d1f` | 7.65 |
| error | light | `#ff3b30` | `#1d1d1f` | 4.74 |
| idle | light | `#8e8e93` | `#1d1d1f` | 5.16 |
| ok | dark | `#30d158` | `#1d1d1f` | 8.32 |
| warn | dark | `#ff9f0a` | `#1d1d1f` | 8.18 |
| error | dark | `#ff453a` | `#1d1d1f` | 4.94 |
| idle | dark | `#8e8e93` | `#1d1d1f` | 5.16 |

Nota de implementación para Task 3: si se elige B, el gate automático de `contrast.test.ts` debe
verificar el par realmente renderizado (`--status-*` opaco vs. la tinta oscura), no el patrón
`--status-X` sobre `--status-X-soft` que audita hoy — ese patrón deja de existir en el pill bajo este
candidato. `auditTheme` seguiría reportando esos 6 pares como FAIL con los valores sin cambiar porque
mide la relación vieja; ese resultado sería un falso negativo, no un fallo real, bajo B.

**Costo visual**: los pills pasan de "chip suave y discreto" (el lenguaje que describe el skill,
`--status-*-soft` al 14%) a una insignia sólida y muy saturada — un salto de peso visual considerable,
en tensión con el tono general "calm interface" del sistema. El botón primario en dark muestra texto
casi negro sobre azul vivo en vez del blanco-sobre-azul estándar de iOS — un cambio de identidad de
marca perceptible, aunque el azul en sí no cambia.

### Candidato C — Token de texto separado, sin tocar los tonos base

Eje: `--status-ok/warn/error/idle` NO cambian (dots, bordes, gráficos de barra siguen usando el color
vivo actual). Se introduce un token nuevo por estado, `--status-*-text`, usado únicamente por la
palabra del pill; el fondo `-soft` no cambia.

| Token nuevo | Tema | Valor | Ratio contra `-soft` propio sobre `--surface-1` |
|---|---|---|---|
| `--status-ok-text` | light | `#207b37` | 4.74 |
| `--status-warn-text` | light | `#9e5c00` | 4.70 |
| `--status-error-text` | light | `#c22d24` | 4.72 |
| `--status-idle-text` | light | `#69696d` | 4.75 |
| `--status-ok-text` | dark | `#30d158` (= `--status-ok`, ya pasa, token espejo por simetría) | 6.41 |
| `--status-warn-text` | dark | `#ff9f0a` (= `--status-warn`, ídem) | 6.29 |
| `--status-error-text` | dark | `#ff584e` | 4.61 |
| `--status-idle-text` | dark | `#959599` | 4.60 |

Más `--on-accent` (dark) → `#1d1d1f` igual que Candidato B (5.58), y los mismos fixes de
`--ink-secondary`/`--ink-tertiary` que A/B.

Requiere el mismo cambio de clase en `StatusPill.tsx` que B en espíritu, pero más acotado:
`TONE_CLASSES` pasa de `text-status-{tone}` a `text-status-{tone}-text`; el dot deja de usar
`bg-current` (que ahora heredaría el color atenuado de la palabra) y pasa a una clase `bg-status-{tone}`
explícita — el mismo "one class pair" que el plan anticipa tocar en `StatusPill.tsx`.

**Costo visual**: los dots, bordes y gráficos mantienen el color vivo actual sin cambios — el menor
costo visual fuera del pill. Dentro del pill, la palabra queda visiblemente más apagada que el dot
justo al lado (mismo estado, dos tonos distintos), y añade 4 tokens nuevos por tema (8 declaraciones)
al sistema. También se **desvía literalmente** del texto ya bloqueado del skill ("el texto sobre -soft
usa el color pleno", `noodara-ux-apple` §2.1) — si se elige C, ese texto del skill necesita una nota de
excepción, no solo el token.

### Qué hace cada candidato con WR-C-08

Los tres candidatos oscurecen `--ink-tertiary` en vez de restringirlo a uso no-textual con migración de
call sites — la migración de call sites (mover `Banner.tsx`/`Field.tsx`/etc. a `--ink-secondary`) exige
tocar archivos fuera de `files_modified` de este plan y por eso no es una opción ejecutable aquí, solo
un candidato de decisión aparte. Dentro de esa restricción, los tres dan el mismo resultado y el mismo
costo de jerarquía (ver la nota compartida al principio de esta sección). Si el usuario prefiere no
pagar ese costo de jerarquía ahora, la alternativa es: oscurecer `--ink-tertiary` solo lo suficiente
para las 4 superficies planas (`#737375` light / `#828287` dark — pasa el gate automático de la
sección 1.1 con margen, jerarquía intacta) y dejar el caso `Banner.tsx` (`errorCode`, 1.83:1 hoy,
subiría a ~2.9:1 pero seguiría en FAIL) registrado como un ítem explícitamente diferido a un plan que
sí pueda editar `Banner.tsx`.

### Recomendación

Recomiendo el **Candidato A**: cierra los 17 pares con el menor número de archivos tocados (cero
cambios de clase en componentes), es el cambio más simple de auditar y de explicar, y su costo visual
(azul menos vivo en dark, naranja de warning más oscuro en light) es real pero localizado a dos tokens,
no a un cambio de lenguaje de componente entero como B o una desviación textual del skill como C.

---

## 3. Decisión del usuario

**Decidido el 2026-09-20.** El usuario no eligió un candidato completo -- eligió un híbrido de los tres,
tras una re-medición independiente del orquestador que encontró dos defectos en la propia redacción de
candidatos de la sección 2 (ver "Erratum" más abajo). La decisión literal:

**D1 -- Status pills, "Candidato C":** se añaden tokens `--status-{ok,warn,error,idle}-text` que
gobiernan únicamente la palabra del pill. Valores -- light: ok `#207b37`, warn `#9e5c00`, error
`#c22d24`, idle `#69696d`; dark: ok `#30d158` y warn `#ff9f0a` (espejo del token base), error `#ff584e`,
idle `#959599`. Los tokens `--status-*` base y sus `-soft` NO cambian (dots, bordes y meters siguen a
saturación completa). `StatusPill.tsx`: la palabra usa el token `-text`; el dot deja de usar `bg-current`
y pasa a una clase `bg-status-{tone}` explícita. Los nuevos tokens se conectan a Tailwind en
`packages/ui/theme.css` con el mismo mecanismo `--color-status-X: var(--status-X)` ya existente.

**D2 -- Botón primario en dark, "split token":** el `--accent: #1f73c2` (dark) del Candidato A queda
RECHAZADO -- el orquestador midió que `--accent` también se usa como FOREGROUND (texto de enlace en
`ActivityRow.tsx`/`servers/[id]/page.tsx`, y contornos de foco/bordes en 5+2 sitios) y ese valor oscurecido
medía 2.92-3.69:1 ahí, algo que la auditoría original (solo on-accent/accent) nunca vio. En su lugar: un
token nuevo `--accent-fill = #0071e3` en AMBOS temas, usado en toda FILL que lleve texto `--on-accent`
(`Button.tsx` primary, `SegmentedControl.tsx` estado checked, el skip link del shell). `--accent` se
mantiene sin cambios (`#0071e3` light / `#2997ff` dark) para enlaces, contornos y bordes; `--on-accent`
se mantiene `#ffffff`.

**D3 -- Ink:** `--ink-secondary` light: `#6e6e73` → `#6c6c71` (como en la sección 2). `--ink-tertiary`:
light `#6d6d70`, dark `#909094` (NO los `#68686b`/`#919195` de la sección 2, ni la "alternativa"
`#737375`/`#828287` -- el orquestador midió esos dos últimos en `#4.15` y `3.74` sobre `--surface-3`:
FALLAN; la sección 2 estaba equivocada ahí -- ver Erratum). El caso `Banner.tsx` `errorCode` (que usaba
`--ink-tertiary` sobre el tinte compuesto de `--status-error-soft`) se arregla EN EL CALL SITE:
`Banner.tsx` pasa a `--ink-secondary` ahí. Costo aceptado y explícito: en light, `--ink-tertiary` queda
prácticamente igual de oscuro que `--ink-secondary` -- la jerarquía de tres pasos ink/ink-secondary/
ink-tertiary se reduce a ~dos bajo AA estricto; queda registrado como una limitación para el futuro
rediseño de UI, no resuelto aquí.

### Nudge post-decisión (ejecutor, 2026-09-20, mismo día)

Al aplicar D1/D3 literalmente y auditar CADA superficie realmente renderizada (no solo la superficie
genérica que la sección 2 había medido), aparecieron dos casos donde los valores exactos de la decisión
no alcanzaban 4.5:1:

1. **`Banner.tsx` `errorCode`, light**: `--ink-secondary` a `#6c6c71` sobre el tinte compuesto de
   `--status-error-soft` sobre `--surface-1` (`#ffe4e2`) medía **4.33:1** -- FALLA el propio requisito de
   D3 ("debe ser ≥4.5"). Este par nunca se había medido en la sección 2 (que solo auditó `--ink-tertiary`
   ahí, no `--ink-secondary`).
2. **`StatusPill` sobre `--canvas`**, light: los cuatro tonos `-text` de D1, calculados solo contra
   `--surface-1`, fallaban contra `--canvas` (ok 4.40, warn 4.36, error 4.35, idle 4.42) -- el fondo real
   de `ServerRow` (05-UI-SPEC.md D-09: sin card wrapper, la fila vive directamente sobre `--canvas`).
   `--status-error-text`/`--status-idle-text` en dark también fallaban contra `--surface-2` (el estado
   hover de la fila): 4.23 y 4.16.

Siguiendo la misma regla que D3 ya autorizaba para `--ink-tertiary` ("si no llega a 4.50, ajustar el
mínimo paso posible, en 8 bits, y reportar el valor final"), se aplicó el mismo criterio a estos dos casos
nuevos, en vez de detener la ejecución:

- `--ink-secondary` light se oscureció un paso mínimo adicional más allá de la decisión literal:
  `#6c6c71` → **`#69696e`** (pasa el peor caso, `Banner.tsx`, a 4.53; las cuatro superficies planas suben
  de margen, de 4.79-5.22 a 5.01-5.45).
- Los cuatro `--status-*-text` se oscurecieron (light) / aclararon (dark, solo error e idle) hasta que
  las TRES superficies reales de StatusPill (`--surface-1`, `--canvas`, `--surface-2`) pasan:
  - light: ok `#207b37`→`#1e7935`, warn `#9e5c00`→`#9b5900`, error `#c22d24`→`#be2920`,
    idle `#69696d`→`#67676b`.
  - dark: ok y warn sin cambio (ya pasaban en las tres superficies); error `#ff584e`→`#ff655b`,
    idle `#959599`→`#9d9da1`.

Todos los deltas son de 2 a 13 unidades de 8 bits por canal (la mayoría 2-4; el peor caso, error dark,
13). Cada valor final está re-medido por `packages/ui/src/contrast.test.ts` contra el `tokens.css` real,
no estimado.

### Erratum (sección 2)

La "alternativa que preserva mejor la jerarquía" de la sección 2 (`--ink-tertiary` `#737375` light /
`#828287` dark) es **incorrecta**: medida contra `--surface-3`, `#737375` da **4.15:1** y `#828287` da
**3.74:1** -- ambas por debajo de 4.5:1. La sección 2 las presentó como si pasaran "con margen"; no es
así. Esta es la razón por la que D3 usa los valores `#6d6d70`/`#909094` en su lugar (los mismos que ya
estaban en la fila "Verificado con `auditTheme`" de la sección 2 para el Candidato A/B/C, que sí pasan).

### Nueva brecha descubierta, fuera del alcance autorizado de esta decisión

La auditoría exhaustiva de `--accent` como FOREGROUND (no solo como fill) en las cuatro superficies --
el chequeo cuya ausencia dejó pasar el Candidato A rechazado -- encontró que el valor de `--accent` que
D2 mantiene sin cambios (`#0071e3` light) **ya fallaba** como texto de enlace en dos superficies reales
antes de esta decisión y sigue fallando después, porque D2 explícitamente no autoriza tocar `--accent`:
`--accent` como texto sobre `--canvas` (light) = **4.31:1** y sobre `--surface-3` (light) = **4.12:1**.
Ambos casos SÍ pasan el umbral de contorno/borde (3.0:1): 4.31 y 4.12. Se confirmó render real en
`ActivityRow.tsx` (enlace al servidor) y `servers/[id]/page.tsx` (enlace "← Servers" en el estado
not-found), ambos sin card wrapper, sobre `--canvas`. Queda registrado como deferred item (ver
`deferred-items.md`), no corregido en este plan -- arreglarlo requeriría oscurecer `--accent`, que D2
prohíbe explícitamente para preservar el color de enlaces/contornos.

## 4. Medición después (2026-09-20, tokens.css aplicado)

76 pares auditados (34 originales + 42 nuevos de D1/D2: accent-fill, accent-como-foreground con verdicto
doble texto/contorno, y status-*-text sobre surface-1/canvas/surface-2). 9 fallan, los 9 documentados y
justificados individualmente en `packages/ui/src/contrast.test.ts`'s `KNOWN_UNRENDERED_OR_DEFERRED_FAILURES`:

| Par | Tema | Ratio | Motivo del fallo |
|---|---|---|---|
| `--on-accent` / `--accent` | dark | 3.01 | patrón superado -- ningún call site real empareja ya on-accent con accent (todos migraron a accent-fill) |
| `--status-{ok,warn,error,idle}` / propio `-soft` sobre `--surface-1` | light (4) + dark (2: error, idle) | 1.96-4.21 | patrón superado -- StatusPill es el único sitio que empareja bg-status-soft con texto, y ahora usa el token `-text` |
| `--accent` como texto sobre `--canvas` | light | 4.31 | real, pre-existente, fuera del alcance autorizado (D2 no permite tocar `--accent`) -- ver sección 3 |
| `--accent` como texto sobre `--surface-3` | light | 4.12 | ídem |

Todos los demás pares (67 de 76) PASAN, incluidos los que antes fallaban: el par WR-C-08 original (17 de
34), el botón primario en dark (ahora vía `--accent-fill`, 4.69), los ocho pares de status pill (ahora
vía `-text`, 4.53-6.97 en las tres superficies reales), y los cuatro `--ink-tertiary` (ahora 4.53-5.68).

Pares nombrados fuera de la auditoría genérica (call sites específicos, medidos aparte en
`contrast.test.ts`):

| Par | Sitio | Light | Dark |
|---|---|---|---|
| `--ink-secondary` sobre `--status-error-soft` compuesto sobre `--surface-1` | `Banner.tsx` `errorCode` | 4.53 PASS | 5.57 PASS |
| `--status-error-text` sobre `--surface-1` | `Field.tsx` mensaje de error inline | 5.95 PASS | 5.82 PASS |
| `--status-error-text` sobre `--surface-3` | `RowMenu.tsx` ítem "Delete" | 5.23 PASS | 4.95 PASS |

Los tres pares WR-C-08 §1.2 que este plan SÍ corrige: Banner (`errorCode`, ambos temas), Field.tsx
(ambos temas) y RowMenu.tsx (ambos temas) -- los tres antes fallaban, los tres pasan ahora. Ningún par de
§1.2 queda silenciosamente descartado.

## 5. Fuera de alcance, no corregido en este plan (ver `deferred-items.md`)

- `--accent` como texto de enlace sobre `--canvas`/`--surface-3` en light (4.31/4.12) -- ver sección 3.
- `Button.tsx`'s `DESTRUCTIVE_FILLED_CLASSES` (`bg-status-error text-on-accent`, el botón de confirmación
  del diálogo de borrado con `filled`) nunca fue parte del alcance de 17 pares original ni de D1/D2/D3 --
  medido por curiosidad durante este plan: `#ffffff` sobre `--status-error` da **3.54:1** light / **3.40:1**
  dark, ambos FALLAN 4.5:1. Es un botón de alto riesgo (confirma un borrado) con texto blanco poco legible
  sobre el fondo rojo. No corregido aquí -- `Button.tsx` variant destructive+filled no está en
  `files_modified` de este plan ni fue mencionado por D1/D2/D3.
- `text-status-error`/`text-status-warn` en `DiscoveryStep.tsx`, `CredentialFields.tsx` y
  `ActivityRow.tsx` (mono error code) siguen usando el token base `--status-error`/`--status-warn`, no el
  nuevo `-text`. No fueron auditados por este plan (WR-C-08 solo nombraba Banner/Field/RowMenu) -- un
  plan futuro debería medirlos y, si fallan, migrarlos al mismo patrón `-text`.

## 6. Decisión de contraste — Plan 05-45 (gap closure ronda 2)

Cierra los dos fallos de contraste AA que la sección 5 de este documento dejó explícitamente fuera de
alcance de 05-33: `--accent` como texto de enlace en light (4.31:1 sobre `--canvas`, 4.12:1 sobre
`--surface-3`) y `Button.tsx`'s `DESTRUCTIVE_FILLED_CLASSES` (blanco sobre `--status-error`, 3.54:1
light / 3.40:1 dark). Ver `05-45-PLAN.md` para el objetivo completo.

### 6.1 Re-derivación (2026-09-20, antes de presentar las opciones al usuario)

Todas las cifras del plan fueron re-calculadas en esta sesión con las funciones reales de
`packages/ui/src/contrast.ts` (`contrastRatio`/`parseTokensCss`/`roundDown`) contra los valores reales
de `packages/ui/tokens.css`, vía un test Vitest desechable (`packages/ui/src/scratch-45-rederive.test.ts`,
borrado antes de cualquier commit -- `git status --short packages/ui` no muestra el archivo). El comando
ejecutado fue `pnpm vitest run packages/ui/src/scratch-45-rederive.test.ts --reporter=verbose`.

**Token de texto de enlace (light), ratio sobre canvas / surface-1 / surface-2 / surface-3, mínimo:**

| Candidato | canvas | surface-1 | surface-2 | surface-3 | MIN | Veredicto |
|---|---|---|---|---|---|---|
| `#0071e3` (actual) | 4.31 | 4.69 | 4.5 | 4.12 | 4.12 | FAIL |
| `#0068d6` | 4.88 | 5.31 | 5.09 | 4.66 | 4.66 | PASS |
| `#0066cc` | 5.11 | 5.56 | 5.33 | 4.89 | 4.89 | PASS |
| `#0062c4` | 5.44 | 5.92 | 5.68 | 5.2 | 5.2 | PASS |

Dark `--accent` (`#2997ff`) como texto: canvas 5.99, surface-1 5.58, surface-2 5.07, surface-3 4.75 --
las cuatro PASAN, confirmando que el valor dark del nuevo token de enlace puede quedarse en `#2997ff`
sin cambio.

Las cuatro cifras coinciden exactamente con la tabla del plan -- cero discrepancia.

**Token de fill destructivo, blanco (`--on-accent` `#ffffff`) sobre el fill:**

| Candidato | Ratio | Veredicto |
|---|---|---|
| `#ff3b30` (actual light) | 3.54 | FAIL |
| `#ff453a` (actual dark) | 3.4 | FAIL |
| `#d70015` | 5.38 | PASS |
| `#c9271c` | 5.54 | PASS |
| `#be2920` | 5.95 | PASS |

Cifras exactas, sin discrepancia con el plan.

**Roles extra medidos por el orquestador (informativos, no forman parte del gate de `contrast.test.ts`
-- no existe una función `compositeOver`-con-opacidad reutilizable en `contrast.ts` para el estado
`hover:opacity-90`, así que esta cifra es un cálculo manual de un solo uso, igual que el del
orquestador):**

| Par | Cifra del orquestador | Mi re-derivación | Veredicto |
|---|---|---|---|
| hover (label+fill @ 0.9) blanco-sobre-`#d70015`, light surface-1 | 5.01 | **5.00** | discrepancia ±0.01, ver nota |
| hover blanco-sobre-`#d70015`, dark surface-1 | 5.08 | 5.08 | exacto |
| hover blanco-sobre-`#d70015`, dark surface-2 | 5.08 | 5.08 | exacto |
| edge (borde, no-texto) `#d70015` vs surface, light surface-1 | 5.38 | 5.38 | exacto |
| edge `#d70015` vs surface, dark surface-1 | 3.12 | 3.12 | exacto |
| edge `#d70015` vs surface, dark surface-2 | 2.84 | 2.84 | exacto |
| edge actual `#ff453a` vs dark surface-1 | 4.94 | 4.94 | exacto |
| edge actual `#ff453a` vs dark surface-2 | 4.49 | 4.49 | exacto |

Nota sobre la única discrepancia (5.01 vs 5.00, light surface-1, estado hover): es la misma clase de
discrepancia de ±0.01 que la sección 1.3 ya documentó para 05-33 -- convención de redondeo de punto
flotante, aquí en el cálculo manual de `1 - 0.9` (que en JS no da exactamente `0.1`: `0.09999999999999998`)
frente a usar el literal `0.1` directamente. El canal verde compuesto del fill cae justo en el límite de
redondeo (`25.5` exacto con el literal `0.1`, que Math.round sube a 26; `25.499999999999993` con
`1 - 0.9`, que Math.round baja a 25) -- un paso de 1/255 en un solo canal que mueve el ratio en 0.01. No
cambia ningún veredicto PASS/FAIL y no afecta ninguna de las dos decisiones (esta cifra es puramente
informativa: el estado hover no es un requisito de contraste de texto propio, ver más abajo). Esta cifra
no proviene de `contrast.test.ts` -- no hay gate automático para el estado hover compuesto porque
`contrast.ts` no expone una función de composición con opacidad; documentado aquí solo como contexto para
el futuro rediseño de UI.

### 6.2 Decisión del usuario

**Decidido el 2026-09-20**, mediante una pregunta interactiva bloqueante (`checkpoint:decision`) que
presentó las tablas completas de las secciones 6.1 para ambas decisiones (las seis opciones link-A/B/C y
fill-A/B/C, con sus pros/cons del plan). Respuesta verbatim del usuario:

**D4 -- Token de texto de enlace (light):** **link-B, `#0066cc` (Recommended)**. Ratio mínimo 4.89:1
(sobre `--surface-3`). El valor dark del mismo token se queda en `#2997ff` (el `--accent` dark ya
existente), porque ya pasa 4.5:1 en las cuatro superficies sin cambio (sección 6.1).

**D5 -- Token de fill destructivo (mismo hex en ambos temas):** **fill-A, `#d70015` (Recommended)**.
Blanco sobre el fill mide 5.38:1. Mismo valor en ambos temas, siguiendo el precedente de `--accent-fill`
(D2, sección 3).

Ningún archivo de tokens fue modificado antes de que el usuario respondiera -- esta sección (6) es la
única escritura hecha en `docs/contrast-decision-05.md` antes de que Task 2 toque `tokens.css`; el orden
de commits del plan (`git log`) respalda esto: el commit de esta sección precede a cualquier commit que
toque `packages/ui/tokens.css`.

### 6.3 Nombres de los nuevos tokens (adelanto de Task 2, ver `05-45-PLAN.md` Task 2 `<action>`)

- `--accent-text`: light `#0066cc` (D4), dark `#2997ff` (sin cambio respecto a `--accent` dark).
- `--status-error-fill`: `#d70015` en ambos temas (D5).

La tabla de medición "as-shipped" (cada rol × cada tema × cada superficie, tomada de la salida del gate,
no recalculada a mano) se añade en la sección 7 al cerrar Task 3.
