# Phase 7: Identidad y brand kit - Context

**Gathered:** 2026-09-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Noodara tiene un logotipo propio con significado — monograma + wordmark — construido en SVG, en variantes para tema claro y oscuro, documentado en un brand kit (`docs/brand/`), que el usuario ha visto renderizado en la app real y en el README, en ambos temas, y ha aprobado explícitamente antes de aplicarse en el sidebar/rail, `/login`, `/setup`, favicon, `apple-touch-icon` y README, con los assets exportados desde `packages/ui` para que la Fase 10 (sitio público) los consuma sin copiar archivos. Requisitos: BRAND-01, BRAND-02, BRAND-03.

Fuera de esta fase: el rediseño de la app (Fase 8), cualquier animación del monograma (Fase 8, UI-08), el sitio público que aplicará la marca (Fase 10), y cualquier cambio de tokens de color o tipografía del sistema (lockeados; ver brief §5.1).
</domain>

<decisions>
## Implementation Decisions

### Símbolo y significado
- **D-01:** "Noodara" es un nombre inventado por sonoridad: no hay etimología que representar. El símbolo nace de lo que el producto hace.
- **D-02:** La idea central que codifica el símbolo es **entender / ver con claridad** (lente, apertura, señal que se vuelve nítida): es el diferencial frente a Coolify y Dokploy ("ellos administran; Noodara entiende") y enlaza con el momento de firma del discovery (brief §8.4). No se codifica "conectar" ni "orden sobre lo complejo".
- **D-03:** El monograma es una **letra N con la idea integrada en su construcción** (p. ej. un trazo que se abre como apertura, o dos trazos que se encuentran y enfocan). Debe leerse como N y como Noodara en 16 px y reproducirse con geometría. No es una marca abstracta sin letra ni un símbolo figurativo.
- **D-04:** Se entregan **tres lockups**: monograma solo (rail de 64 px, favicon, `apple-touch-icon`), lockup horizontal monograma + wordmark (sidebar expandido ≥1280 px, `/login`, `/setup`, README, sitio) y wordmark solo (textos y título del sitio).

### Wordmark y tipografía
- **D-05:** El wordmark **se dibuja en SVG con la geometría del monograma** (mismo grosor de trazo, radios y ángulos): sin dependencia de fuente ni licencia, escala sin pérdida y la N del wordmark ES el monograma. La UI sigue usando la fuente del sistema (SF Pro → Inter), exenta del anti-slop por modo Operate (brief §4.3, §5.3).
- **D-06:** Caja: **"noodara" en minúsculas** (registro de herramienta de desarrollador: vercel, linear, raycast; equilibrio óptico con las dos "oo"). El monograma sigue siendo una N mayúscula.
- **D-07:** Peso **medio** y tracking **ligeramente negativo** (−0.01 a −0.02 em, como el rol `display` del sistema). Debe leerse de 14–16 px (sidebar) a 96 px (landing).
- **D-08:** Las dos **"oo" comparten la construcción de la apertura del monograma** (mismo radio y trazo) **con sutileza**: es el detalle de firma tipográfico que pide el brief §4.3, sin convertirse en ojos literales. Debe sobrevivir al test de intercambio de marca sin caer en lo infantil.

### Color y temas
- **D-09:** Dentro de la app y en el README el monograma y el wordmark son **monocromos en tinta**, pintados con `currentColor` (hereda `ink` claro/oscuro). El azul de acción (`accent`) queda reservado a acciones y estados (brief §9.1); la marca nunca compite con el único color de acción y nunca se pinta en `accent` dentro de la UI.
- **D-10:** **Un solo SVG con `currentColor`** en la app. Para README y sitio (sin CSS de tema) se **exportan dos SVG estáticos** (claro y oscuro) generados desde la misma fuente, nunca dibujados aparte. Un ajuste óptico de grosor por tema solo se introduce si al medir hace falta (Claude's discretion, ver abajo).
- **D-11:** Favicon y app icon (`favicon.svg` + `.ico`, `apple-touch-icon` 180 px, iconos PWA 192/512 px): **tile redondeado con fondo `accent-fill` (#0071e3) y esquinas al radio del sistema, monograma en `on-accent` (blanco)**. Es la única superficie donde la marca lleva azul. Debe leerse a 16 px sobre pestañas claras y oscuras.
- **D-12:** Imagen Open Graph / social (1200×630): **lockup horizontal en tinta clara sobre `canvas` oscuro (#161618) + lema "Your infrastructure, understood."** en la tipografía del sistema. Sin gradientes, sin glow, sin sombra (brief §9).

### Direcciones y aprobación
- **D-13:** Se presentan **tres conceptos distintos** de monograma, cada uno resolviendo "ver con claridad" de forma diferente (p. ej. apertura en el trazo diagonal; dos trazos que enfocan; N como marco/ventana). Tres es el número: ni dos ni uno.
- **D-14:** Formato de revisión: **cada concepto montado en la app real** (rail de 64 px, sidebar expandido, `/login`, favicon en la pestaña) **en ambos temas, con screenshots**, **más un tablero de marca por concepto** (los tres lockups, hoja de construcción sobre la retícula, escalas 16/32/64/256 px). El usuario aprueba viendo el contexto real, que es lo que exige BRAND-03; el tablero solo no basta.
- **D-15:** Método: **SVG construido por código sobre una retícula de 24 unidades**, con grosores de trazo y radios definidos como constantes y curvas exclusivamente geométricas (arcos, círculos, rectas), de modo que cualquier persona reproduce el logo desde la hoja de construcción. No hay herramienta gráfica ni generación de imágenes en el flujo; no se vectoriza nada a mano alzada.
- **D-16:** Tras elegir un concepto, **hasta dos rondas de ajuste** (cambios concretos: grosor, apertura, proporción monograma/wordmark), cada una re-vista en la app; después se aprueba o se descarta el concepto. No hay pulido sin límite.
- **D-17:** La aprobación es un acto explícito del usuario y **queda registrada** (fecha, concepto elegido, rondas usadas) en el brand kit y en el SUMMARY del plan correspondiente. Ninguna aplicación en superficies (BRAND-02) empieza antes de ese registro.

### Claude's Discretion
- La construcción concreta de cada uno de los tres conceptos (geometría exacta de la apertura, ángulos, proporciones) dentro de D-03/D-15.
- Si hace falta un ajuste óptico de grosor en el tema oscuro (D-10): medir primero (screenshots a 1x y 2x); introducirlo solo si el blanco sobre `#161618` se percibe visiblemente más grueso.
- Tamaño mínimo y área de protección del lockup, derivados de la retícula (documentarlos en el brand kit).
- Composición exacta del README (posición del lockup, tamaño) y del tablero de marca.
- Idioma del brand kit: al vivir en `docs/` y ser material de producto, en inglés (CLAUDE.md §7.1), como `docs/install.md`.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Brief de diseño y prohibiciones
- `docs/ui-build-prompt.md` §4.3 (anti-slop y la exención de fuente del sistema), §5.1 (tokens lockeados: `ink`, `accent`, `accent-fill`, `on-accent`, `canvas`, radios 6/10/16), §5.3 (conflictos resueltos), §8.4 (firma del producto, test de intercambio de marca), §9 (20 prohibiciones duras: un solo color de acción, sin gradientes, sin glow, sin sombras fuera de las tres superficies flotantes, sin emoji/glifos como iconos), §10 (DoD de UI: screenshots humanos en ambos temas).
- `.claude/skills/noodara-ux-apple/SKILL.md` — design system Apple-inspired (tokens, superficies, tipografía); gitignored, leer desde el árbol de trabajo.
- `.claude/skills/noodara-ux-review/SKILL.md` — auditoría PASS/FLAG/BLOCK a aplicar a cada superficie donde se monte la marca.

### Requisitos y roadmap
- `.planning/REQUIREMENTS.md` — BRAND-01, BRAND-02, BRAND-03 (texto exacto de lo que debe ser verdad).
- `.planning/ROADMAP.md` §Phase 7 — objetivo, criterios de éxito 1–4 (incluida la exportación de assets desde `packages/ui` para la Fase 10) y "Decisions carried from research".

### Referencias de diseño externas (inspiración, no mandato)
- `~/.claude/design-references/design-md/apple/DESIGN.md` y `linear.app`, `vercel`, `raycast` en el mismo directorio — dashboards oscuros y marcas monocromas con un solo acento.
- Skill `brandkit` de github.com/Leonxlnx/taste-skill (clonada en el scratchpad de sesión `design-skills/taste-skill/skills/brandkit/SKILL.md`; volver a clonar si falta) — "brand strategy first" y los métodos de concepto de logo (monograma + significado, acción del producto). Su pipeline de generación de imágenes NO aplica: aquí todo es SVG por código.

### Investigación del milestone
- `.planning/research/SUMMARY.md` — la Fase 7 no tiene decisiones de research específicas más allá del orden de fases; PITFALLS §UI-redesign aplica a las superficies que toque la marca (no romper los 93 E2E, `data-testid` estables).
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/ui/tokens.css` y `packages/ui/theme.css`: la única fuente de color, radio y tipografía. Todo lo que dibuje la marca usa `currentColor`, `var(--accent-fill)`, `var(--on-accent)`, `var(--canvas)` y los radios del sistema; cero literales fuera de tokens (gate `scripts/check-ui-safety.mjs`).
- `packages/ui/src/` (Button, Sheet, Dialog, Tooltip, ThemeToggle, …): patrón de componente con tests de componente colocados (`*.test.tsx`, jsdom). Los componentes de marca (`Logo`, `Wordmark`, `Lockup`) siguen ese patrón y viven en `packages/ui` para que `apps/web` y, en la Fase 10, `apps/site` los consuman.
- `apps/web/src/components/Sidebar.tsx` (`data-testid="shell-sidebar"`, `shell-theme-toggle`; breakpoints ≥1280 labels / 900–1279 rail de 64 px / <900 bottom sheet) y `apps/web/src/components/AuthCard.tsx` (`/login`, `/setup`): hoy **no existe ningún slot de marca** — solo texto "Noodara" en `metadata.title` (`apps/web/src/app/layout.tsx`) y en copy. Son los puntos donde se monta el lockup (sidebar expandido) y el monograma (rail, AuthCard).
- `README.md`: cabecera `# Noodara` + lema; el lockup exportado (SVG claro/oscuro con `<picture>` + `prefers-color-scheme`) sustituye o acompaña al título.

### Established Patterns
- Un solo color de acción; jerarquía por escalón de superficie + hairline; sin sombras salvo `--shadow-floating` (Fase 8). La marca respeta esto: monocroma en tinta dentro de la UI, azul solo en el tile del favicon.
- Tests de exactitud que leen la fuente de verdad (`tests/unit/docs/install-docs-accuracy.test.ts`): aplicar el mismo patrón para que el brand kit y los SVG exportados se generen/verifiquen desde una única definición geométrica (p. ej. un test que regenera los SVG estáticos y falla si divergen del componente).
- Gate de tokens (`check:ui-safety`) y 93 E2E Playwright con `data-testid` estables: la marca no cambia test-ids existentes; añade los suyos (`brand-monogram`, `brand-lockup`).
- DoD de UI (brief §10): nada visual se cierra sin screenshots en ambos temas vistos por un humano — aquí es además el requisito BRAND-03.

### Integration Points
- `apps/web/src/app/layout.tsx` (`metadata.icons`, `apple-touch-icon`, `manifest`) y `apps/web/public/` (favicon.svg/.ico, apple-touch-icon.png, icon-192/512.png, og.png): hoy vacío — no hay favicon.
- `apps/web/src/components/Sidebar.tsx` y `AuthCard.tsx`: montaje del lockup/monograma según breakpoint.
- `README.md`: lockup exportado.
- `packages/ui` `package.json` exports: exponer los componentes de marca y los assets estáticos (`packages/ui/brand/*.svg`, `*.png`) para la Fase 10 (`apps/site`) sin copias.
- `docs/brand/`: hoja de brand kit (Markdown + SVG de construcción) — nueva.
</code_context>

<specifics>
## Specific Ideas
- "Que la gente se enamore al verlo, porque todo entra por los ojos": la marca es parte del diferencial, no un adorno; pero debe sostener la sobriedad del sistema (Apple, Linear, Vercel, Raycast como referencias de marca monocroma con un solo acento).
- La N con una **apertura** o dos trazos que **enfocan** es la dirección conceptual preferida; el brief §8.4 pide que la narración del discovery y el momento TOFU sean los momentos autorados de la app — la marca debería sentirse de la misma familia visual que esos momentos (Fase 8 los retoma).
- Las "oo" como detalle de firma sutil (mismo radio que la apertura), nunca ojos.
- Revisión SIEMPRE en contexto real: screenshots del rail, sidebar expandido, `/login` y la pestaña del navegador con el favicon, en claro y en oscuro.
</specifics>

<deferred>
## Deferred Ideas
- Animación del monograma en la app (p. ej. la apertura "enfocando" durante un discovery o al conectar el stream SSE): pertenece a la Fase 8 (UI-07/UI-08, movimiento con propósito); esta fase entrega la geometría estática y deja el SVG estructurado (grupos/ids) para poder animarlo después.
- Aplicación de la marca en el sitio público y la imagen OG servida desde él: Fase 10 (SITE-01) consume los assets exportados aquí.
- Merchandising, variantes a color, versión sobre fotografía: fuera del milestone.

None more — discussion stayed within phase scope.
</deferred>

---
*Phase: 07-identidad-y-brand-kit*
*Context gathered: 2026-09-22*
