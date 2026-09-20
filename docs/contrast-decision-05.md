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

**DECISIÓN PENDIENTE.** Responder con `candidate-a`, `candidate-b`, `candidate-c`, o valores propios
(indicando, para cada token que se aparte de un candidato, el valor exacto y confirmando que pasa
`contrast.ts` a ≥4.5:1 en el tema correspondiente).
