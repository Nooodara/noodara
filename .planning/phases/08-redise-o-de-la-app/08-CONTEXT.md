# Phase 8: Rediseño de la app - Context

**Gathered:** 2026-09-23
**Status:** Ready for planning

<domain>
## Phase Boundary

La app existente — `/setup`, `/login`, `/servers`, `/servers/[id]`, `/activity`, `/settings` y el shell que las contiene — se rediseña conforme a `docs/ui-build-prompt.md` (§8 P0 → P1 → P2, §10 DoD) para sentirse Apple-grade: elevación flotante en `Sheet`/`Dialog`/`RowMenu`, materiales, movimiento con propósito, dos momentos autorados (narración del discovery y bloque de fingerprint/TOFU), craft de superficie, fallbacks intencionales de `prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast: more`, y el shell ya preparado — sin placeholders — para el tercer panel (inspector), la navegación jerárquica Project → Environment → Service y el menú de cuenta que las Fases 9 y 13 llenan. Por primera vez un humano mira cada pantalla renderizada, en ambos temas, antes de cerrarla. Requisitos: UI-03 … UI-12.

Lo que el brief ya fija y esta fase **no reabre**: los valores de tokens nuevos (`--shadow-floating`, `--ease-out/in-out/drawer`, `SPRING`), la tabla de duraciones §6.3, la secuencia de drag del Sheet §7.4, `motion@13.4.1` acotado al `Sheet` con `LazyMotion` (D19), los 18 ítems del backlog §8, las 20 prohibiciones §9, la escala tipográfica y los tokens de color §5.1 (se verifican, no se reemplazan).

Fuera de esta fase: settings editables y persistencia de tema/preferencias en el servidor (Fase 9); contenido real del inspector y de la nav jerárquica (Fase 13); sitio público (Fase 10); cualquier funcionalidad de v0.2+ visible como placeholder (§9 #19).
</domain>

<decisions>
## Implementation Decisions

### Superficies — cómo se cura lo "plano"
- **D-01: Grupos inset.** El contenido de cada pantalla se organiza en bloques `surface-1` sobre `canvas`, radio `lg`, borde `hairline`, con las filas separadas por `hairline` dentro del bloque — el idioma de macOS System Settings / iOS grouped list. Aplica a los tres grupos label/valor del detalle (System, Docker, Connection), a `Instance` y `Advanced` de Settings, y a la lista de servidores. Es escalón de superficie, no card: **nunca sombra** en estos bloques (§9 #2), nunca bloques anidados (§9 #5).
- **D-02: La lista de servidores es un solo grupo inset** con las filas de 44 px dentro, separadas por hairline. La fila sigue siendo un link nativo; el `RowMenu` a la derecha; el empty state vive dentro del mismo bloque.
- **D-03: El chrome retrocede.** El sidebar deja de ser `surface-1` y se funde con el `canvas` — sin `border-r`; la separación la dan el espacio y el propio escalón de los grupos inset. El toolbar sigue translúcido sobre canvas y sustituye el `border-b` permanente por scroll edge effect (§5.3). Un solo `backdrop-filter` permanente en la página (el toolbar).
- **D-04: Layout intacto salvo lo que los grupos exigen.** Se conservan `max-w-[1120px]`, `p-8`, filas de 44 px, stat tiles, roles tipográficos y grid de 8 px. Cambia únicamente lo que los grupos inset obligan: padding interno del bloque, título de grupo fuera del bloque (rol `headline`/`label` según skill), separación entre grupos. No se rediseñan las pantallas como composición ni se toca la densidad.

### Shell preparado (UI-11)
- **D-05: Menú de cuenta al pie del sidebar, absorbe tema y sign out.** Un único trigger al pie: avatar + nombre del admin (solo avatar en el rail de 64 px). Abre un menú flotante (`--shadow-floating`, mismo nivel que `RowMenu`) con: cabecera nombre/email, `Settings` (link), `Appearance` con el control de tema inline, `Sign out`. Reemplaza el cluster actual `ThemeToggle` + `SignOutButton`. El control de tema que vive dentro del menú **es** `ThemeToggle` o llama a su único write path (`STORAGE_KEY = 'noodara-theme'`, `packages/ui/src/ThemeToggle.tsx`) — nunca un segundo escritor (pitfall P17). La Fase 9 añade perfil y preferencias a este mismo menú sin reestructurarlo.
- **D-06: Avatar de iniciales monocromo.** Círculo `surface-3` con hairline, iniciales del nombre en `ink`, rol `label`. Cero azul: el acento sigue reservado a acciones (§9 #1) y la marca es monocroma dentro de la app (Fase 7 D-09). No hay subida de imagen.
- **D-07: `NavTree` genérico con hojas planas hoy.** Se construye en `packages/ui` un componente de árbol de navegación: items con hijos opcionales, expand/collapse animado con `grid-template-rows` (`Disclosure`), `aria-expanded`, estado de expansión por item, y en el rail de 64 px los hijos colapsan a tooltip/flyout. Hoy recibe exactamente tres hojas sin hijos (Servers, Activity, Settings) y se ve idéntico a la lista plana actual. La Fase 13 solo pasa datos (Projects con su subárbol). Sin etiquetas de sección ni ítems deshabilitados (§9 #8, #19). La navegación del sidebar **no** se anima (§6.1).
- **D-08: Slot del inspector como parallel route `@inspector`** en `apps/web/src/app/(shell)/layout.tsx`, con `default.tsx` que devuelve `null`: cuando está vacío no reserva ancho ni dibuja borde. Contrato para cuando la Fase 13 lo llene: a ≥1280 px es una columna derecha fija (~360–400 px) que estrecha el contenido; por debajo de 1280 px se presenta como `Sheet` lateral. Panel paralelo no bloqueante, sin scrim (§7.7). Esta fase entrega el slot, el layout de tres columnas condicional y su test; no el contenido.

### Momentos autorados (UI-08)
- **D-09: Discovery = timeline con hilo + Viewfinder enfocando.** Los seis pasos cuelgan de un hilo vertical (hairline) que se "llena" en `ink` conforme los pasos completan; cada paso muestra su duración en `tabular-nums`; los checks entran con `translateY(4px) + opacity` y stagger de 40 ms sin bloquear la interacción. En la cabecera de la sección, el anillo central del monograma Viewfinder (Fase 7, `packages/ui/src/brand/geometry.ts`) va de abierto/desenfocado a nítido/cerrado a medida que avanzan los pasos — la idea diferida en 07-CONTEXT.md, "ver con claridad" hecha movimiento. Es **el** momento autorado del detalle: un único elemento de marca animado, ligado al estado real del run (nunca inventa progreso — `buildChecklist` sigue siendo la única fuente). En `prefers-reduced-motion` el anillo cambia de estado por crossfade sin trayectoria.
- **D-10: TOFU = componente `Fingerprint` + diff old/new.** Nuevo componente en `packages/ui`: el hash `SHA256:…` en mono grande, agrupado en bloques de 4 caracteres con espacio, prefijo `SHA256:` atenuado (`ink-secondary`), copiable de un tap (`CopyButton`). Es el mismo componente en las tres superficies: aviso de primera confianza (`FirstTrustNotice`), fila "Host fingerprint" del grupo Connection (`ServerFacts`) y diálogo de `HOST_KEY_CHANGED` (`TrustFingerprintDialog`), donde la huella confiada y la nueva se muestran alineadas bloque a bloque y los bloques que difieren se marcan con `ink` fuerte / peso 600 — **nunca con color** (§9 #1, #14). El diálogo sigue exigiendo el nombre exacto (§9 #18). Sin randomart ASCII.
- **D-11: Un momento discreto y propio por pantalla**, todos ya en la tabla §6.3 — aquí solo se fija cuál es "el" de cada una: `/login` y `/setup` → el monograma llega enfocando una sola vez al cargar (misma animación que D-09, sin loop); `/servers` → las filas entran con stagger en la primera carga y el `StatusPill` transiciona color/fondo al cambiar de estado; `/activity` → las filas nuevas que llegan por evento entran con `translateY + opacity` conservando scroll y contenido cargado (§7.8); `/settings` → la `Disclosure` "Advanced" con `grid-template-rows` es su único movimiento. Nunca la misma animación de entrada en todas las secciones (§8.4).

### Revisión visual humana (UI-12)
- **D-12: Baseline primero.** El primer plan de la fase captura las seis pantallas (más los overlays: Sheet, Dialog, RowMenu) en ambos temas a 375/900/1280/1920 px con datos reales (fixture sshd de Testcontainers: servidor conectado con discovery completa, uno en error, lista con nombre de 80 caracteres, lista vacía) reutilizando el pipeline Playwright de `scripts/brand/capture-brand-review.ts` (07-04). El usuario las ve **antes** de cualquier CSS: es la "primera revisión visual humana" del P0 #4 y da el antes/después. Sus notas sobre el baseline se registran y alimentan los planes de superficies.
- **D-13: Tres gates humanos bloqueantes**, cada uno detiene la wave siguiente hasta aprobación explícita (patrón 07-05): **G1** baseline (D-12); **G2** tras P0 + grupos inset + shell (elevación flotante, `RowMenu` arreglado, fallbacks de accesibilidad, menú de cuenta, `NavTree`, slot del inspector) — la dirección visual queda aprobada antes de invertir en movimiento; **G3** final con P1/P2 y los momentos autorados. Hasta dos rondas de ajuste por gate, como en Fase 7 D-16.
- **D-14: El movimiento se revisa en la app en vivo.** En G2 y G3 el usuario levanta el stack local (`pnpm dev` + fixture; receta en memoria del proyecto) y prueba él mismo el drag del Sheet, el Viewfinder enfocando y los staggers a velocidad real y en cámara lenta (DevTools Animations); las capturas estáticas cubren layout, contraste y temas. Hardware táctil real para el drag si hay iPad/teléfono en la LAN (§7.10). Los planes de gate deben dejar un checklist de qué probar en vivo.
- **D-15: Aprobación registrada en `docs/ui/APPROVAL.md` + capturas aprobadas en git.** Mismo patrón que `docs/brand/APPROVAL.md`: tabla con fecha, gate, aprobador, rondas usadas, notas; `docs/ui/approved/` con las capturas finales por pantalla × tema a 1280 px (el resto de anchos y las rondas intermedias en `docs/ui/review/`, gitignored); un test que pinea el set aprobado y prohíbe cadenas de atribución a IA bajo `docs/ui/` (como `tests/unit/brand/approval-record.test.ts`). Las capturas aprobadas son las que la landing de la Fase 10 usa como "screenshots reales" (SITE-01).

### Claude's Discretion
- **`RowMenu`:** arreglarlo sobre el Radix Dialog no-modal actual o migrar a `@radix-ui/react-dropdown-menu` — si migra, actualizar `docs/adr/0000-package-legitimacy-approvals.md` y pasar por `scripts/check-package-provenance.mjs`. Lo que se exige es el comportamiento de UI-04 y §8.1 #2 (cerrar al seleccionar, foco al trigger, trigger visible en táctil vía `(hover: hover) and (pointer: fine)`, keys estables), verificado con lector de pantalla real en G2. El menú de cuenta (D-05) y `RowMenu` deberían compartir la misma primitiva de menú flotante.
- **Detección teclado vs. puntero** para suprimir la animación de cierre en `Esc` (pitfall P14): la forma exacta de la API (prop, inferencia del evento, `:focus-visible`), siempre codificada en el componente, nunca en el call site.
- **Gate automatizado de sombras** (UI-03): extender `scripts/check-ui-safety.mjs` o test estático equivalente; la forma es libre, el resultado es "cualquier `shadow`/`box-shadow` fuera de Sheet/Dialog/RowMenu/menú de cuenta falla".
- **Cómo se anima el anillo del Viewfinder** (D-09): SVG con `stroke-dasharray`/`r`/`opacity` vía CSS o WAAPI; los grupos/ids del SVG ya existen desde Fase 7. No `motion` (D19 lo acota al Sheet).
- **Recuento de `backdrop-filter`** en el peor caso (toolbar + Sheet + RowMenu dentro del Sheet + Tooltip): si excede tres, qué superficie pasa a material sólido — candidatos: Tooltip y RowMenu sólidos (`surface-3`), Sheet translúcido.
- **Escalón de superficie más claro en oscuro** para las tres superficies flotantes (UI-03): qué token exacto (`surface-2` vs `surface-3`) según la medición de contraste de cada par texto/fondo (pitfall P13; generalizar el loop de `contrast.ts`).
- Anchura exacta de la columna del inspector dentro de 360–400 px; anchura del menú de cuenta; tamaño del avatar (rail vs expandido).
- Orden interno de los planes dentro de las restricciones de los gates (G1 antes de todo, G2 antes de P1/P2, G3 al final) y el momento de correr `pnpm test:e2e` completo (mínimo: tras cada plan que toque un componente de `packages/ui`).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### El brief — la especificación de esta fase
- `docs/ui-build-prompt.md` — leer entero. En particular: §3 (inventario y deuda honesta), §4 (doctrina: fluidez, modo Operate, anti-slop, piso de calidad), §5.2 (tokens a agregar: `--shadow-floating`, easings, `SPRING`, superficies del navegador), §5.3 (conflictos resueltos: sombras, translucidez, springs, divisor del toolbar), §6 (movimiento: cuándo, duraciones, tabla §6.3, reglas §6.4, accesibilidad §6.5), §7 (técnicas: contrato del tipo §7.1, press §7.3, drag del Sheet §7.4, `clip-path` §7.5, blur puente §7.6, materiales §7.7, casos borde §7.8, a11y §7.9), §8 (backlog P0/P1/P2 y firma §8.4), §9 (20 prohibiciones), §10 (DoD), §11 (checklist antes de escribir CSS).

### Requisitos, roadmap y research
- `.planning/REQUIREMENTS.md` §"Rediseño de la app (UI)" — UI-03 … UI-12, texto exacto.
- `.planning/ROADMAP.md` §Phase 8 — objetivo, criterios de éxito 1–5, research flag (una verificación Context7 de `motion` drag/`useSpring`), y tabla "Decisions carried from research" (D19).
- `.planning/research/SUMMARY.md` — D19 (`motion@13.4.1`, `LazyMotion`, solo Sheet), sección "Phase 2: UI redesign" (nav jerárquica e inspector genéricos, sin placeholders), pitfalls P13–P17 mapeados.
- `.planning/research/PITFALLS.md` §Pitfall 13–17 — contraste re-medido por superficie, sin animación en teclado (branch en la API), presupuesto de `backdrop-filter`, no romper los E2E (hoy **104**, no 93: la Fase 7 añadió 11), flicker de tema.
- `.planning/research/ARCHITECTURE.md` §8 — estructura de rutas `(shell)/projects/**` + `@inspector` que la Fase 13 usará; el shell de esta fase debe encajarla sin reescritura.

### Design system y revisión
- `.claude/skills/noodara-ux-apple/SKILL.md` — tokens, superficies, tipografía, componentes, estados vacíos, motion (gitignored; leer del árbol de trabajo).
- `.claude/skills/noodara-ux-review/SKILL.md` — auditoría PASS/FLAG/BLOCK a correr sobre cada pantalla antes de G2 y G3.
- `.planning/milestones/v0.1-phases/05-ui-web/05-UI-SPEC.md` — el contrato de UI de v0.1 (shell SS1, componentes, breakpoints, focus order, resync SS6, a11y SS8) que esta fase evoluciona; los `data-testid` que nombra son contrato de los E2E.
- `docs/ui-review-05.md`, `docs/ui-review-07-brand.md`, `docs/contrast-decision-05.md` — auditorías previas y decisiones de contraste (D1–D5) que explican el desdoblamiento `accent`/`accent-fill`/`accent-text`.
- `docs/adr/0005-ui-package-and-component-testing.md` — tests de componente escritos antes (RED) en `packages/ui`; jsdom vs Playwright para comportamiento de Radix.
- `docs/adr/0000-package-legitimacy-approvals.md` — primitivas Radix aprobadas; toda dependencia nueva (`motion`, un eventual `react-dropdown-menu`) pasa por `scripts/check-package-provenance.mjs` y se registra.

### Marca (Fase 7) — insumo de los momentos autorados
- `.planning/phases/07-identidad-y-brand-kit/07-CONTEXT.md` — D-09 (marca monocroma en `currentColor` dentro de la app), D-15 (geometría por código), y la idea diferida "animación del monograma enfocando durante el discovery" que esta fase realiza (D-09).
- `docs/brand/BRAND.md` y `docs/brand/APPROVAL.md` — construcción del Viewfinder (anillo central = donde enfoca), usos prohibidos, y el formato de registro de aprobación que `docs/ui/APPROVAL.md` replica (D-15).
- `packages/ui/src/brand/geometry.ts`, `Logo.tsx`/`Wordmark.tsx`/`Lockup.tsx` — fuente única del SVG con grupos/`data-part` para animar el anillo.
- `scripts/brand/capture-brand-review.ts`, `scripts/brand/review-paths.ts`, `.planning/phases/07-identidad-y-brand-kit/07-04-SUMMARY.md` y `07-05-SUMMARY.md` — pipeline de captura in-app (Playwright, ambos temas) y gate humano con rondas acotadas que D-12/D-13 reutilizan.

### Referencias externas de diseño (inspiración, no mandato)
- `~/.claude/design-references/design-md/apple/DESIGN.md` (grouped inset lists de System Settings, materiales), `linear.app`, `vercel`, `raycast` (menú de cuenta al pie del sidebar, dashboards oscuros) en el mismo directorio.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/ui/tokens.css` / `theme.css`: única fuente de color, radio, tipografía y motion (`--duration-micro/panel/sheet`, `--ease-standard`). Los tokens nuevos de §5.2 se añaden aquí; `--ease-standard` queda como alias de `--ease-out`. Gate `scripts/check-ui-safety.mjs` (hex/rgb fuera de tokens, `outline: none`, spinners) — extenderlo para sombras (UI-03).
- `packages/ui/src/`: `Sheet` (Radix Dialog, 480 px, `translate-x` CSS — aquí entra `motion` para el drag), `Dialog`, `RowMenu` (hand-rolled sobre Dialog no-modal, trigger `opacity-0` en táctil, keys por label), `Tooltip`, `Disclosure`, `ListRow`, `StatTile` (medidor de disco de 1 px → `clip-path`), `StatusPill`, `Skeleton`, `Button`/`CopyButton`/`FileButton`/`SegmentedControl` (press feedback), `ThemeToggle` (único write path del tema), `contrast.ts` (medición AA por token/rol — generalizar a superficies nuevas), `cn.ts`, `testing/`.
- `packages/ui/src/brand/`: `geometry.ts` (retícula 24, `DEFAULT_CONCEPT = 'c'` Viewfinder), `Logo`/`Wordmark`/`Lockup` en `currentColor` con `data-part` — base del anillo animado (D-09) y del monograma en login/setup (D-11).
- `apps/web/src/components/`: `Sidebar` (tres items, cluster inferior a reemplazar por el menú de cuenta; breakpoints `min-[900px]`/`min-[1280px]`), `Toolbar` (52 px sticky, `border-b` a sustituir por scroll edge, `primaryAction` único por tipo), `DiscoverySection`/`DiscoveryStep` (seis pasos via `buildChecklist`; anuncio `aria-live` único por check), `FirstTrustNotice`, `TrustFingerprintDialog`, `HostKeyChangedBanner`, `ServerFacts` (fila fingerprint), `ServerList`/`ServerRow`, `ActivityList` (merge sin reset de scroll), `SettingsGroups`, `AuthCard`, `StreamStatus`.
- `apps/web/src/lib/`: `shell-context.tsx` (stream SSE + mobile nav), `theme-script.ts` (primer pintado del tema), `require-session.ts`, `discovery-progress.ts` (`buildChecklist`, `summarize`), `first-trust.ts`, `safe-storage.ts`.
- `scripts/brand/capture-brand-review.ts` + `tests/e2e/fixtures`: captura in-app en ambos temas con Playwright y fixture sshd real — base directa de los gates G1–G3.
- `tests/e2e/*.spec.ts` (15 specs, 104 tests): la red de seguridad de la fase; `shell.spec.ts`, `server-sheet.spec.ts`, `servers-list.spec.ts`, `server-detail.spec.ts`, `discovery.spec.ts`, `host-key.spec.ts` son los que tocan las superficies rediseñadas. `scripts/e2e-repeat.mjs` para el nightly 20x.

### Established Patterns
- **El tipo impide lo prohibido** (§7.1): `ToolbarProps.primaryAction` único, `SettingsRow` sin handler, `ServerView` sin credencial. Aplicar a: cierre sin animación en teclado (P14), "un solo backdrop-filter permanente", menú de cuenta con items fijos.
- **Tests de componente antes (RED)** en `packages/ui` (ADR-0005), comportamiento Radix real verificado en Playwright, no jsdom.
- **Gates estáticos filtrados por comentario** (Fase 5: nueve gates; Fase 7: `brand:check`): el modelo para el gate de sombras y para "no renombrar `data-testid`".
- **Aprobación humana con rondas acotadas y registro en `docs/`** (Fase 7: tres conceptos → una elección → ≤2 rondas → `APPROVAL.md` + capturas pineadas por test).
- **SSE sin replay, resync por GET, merge sin resetear scroll** (`ActivityList`, `DiscoverySection`): toda animación de entrada por evento debe respetar este contrato.
- **Un solo escritor del tema** (`ThemeToggle`, `STORAGE_KEY`), leído por `theme-script.ts` para el primer pintado.
- **Un solo color de acción; jerarquía por escalón de superficie + hairline** — los grupos inset (D-01) son la aplicación literal de este patrón, no una excepción.

### Integration Points
- `apps/web/src/app/(shell)/layout.tsx`: aquí entran el slot `@inspector` (`default.tsx` → null) y el layout de tres columnas condicional (D-08); `Sidebar` se sustituye por `NavTree` + menú de cuenta (D-05, D-07).
- `apps/web/src/components/Toolbar.tsx`: scroll edge effect; `Sidebar.tsx`: reemplazo del cluster inferior; `AuthCard.tsx`: monograma enfocando al cargar.
- `apps/web/src/app/(shell)/servers/[id]/page.tsx`, `ServerFacts.tsx`, `SettingsGroups.tsx`, `ServerList.tsx`: envolver en grupos inset (D-01/D-02) — probablemente un componente `Group`/`InsetGroup` nuevo en `packages/ui` que `LabelValue` y `ListRow` habitan.
- `DiscoverySection.tsx` / `DiscoveryStep.tsx`: timeline con hilo + cabecera con el anillo (D-09), consumiendo el mismo `buildChecklist`.
- `FirstTrustNotice.tsx`, `ServerFacts.tsx` (fila fingerprint), `TrustFingerprintDialog.tsx`: componente `Fingerprint` compartido (D-10).
- `packages/ui/package.json`: dependencia `motion@13.4.1` (provenance primero), exports de `NavTree`, `AccountMenu`, `Fingerprint`, `InsetGroup`.
- `scripts/check-ui-safety.mjs` y CI `lint` job: gate de sombras (UI-03) y, si se decide, gate de `data-testid`.
- `docs/ui/APPROVAL.md`, `docs/ui/approved/`, `docs/ui/review/` (gitignore), `tests/unit/ui/approval-record.test.ts`: registro de G1–G3 (D-15).
- `.planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md`: checklist de lo que el usuario prueba en vivo en G2/G3 (D-14).
</code_context>

<specifics>
## Specific Ideas
- "Lo sencillo sí, lo plano no" (PROJECT.md, Key Decisions): la respuesta elegida es la de macOS System Settings — grupos inset `surface-1` sobre `canvas` con el chrome fundido en el fondo — no sombras ni cards. La disciplina de hairline y escalón de superficie sigue siendo la firma (§8.4).
- El Viewfinder que **enfoca** durante el discovery es la unión de la marca (Fase 7: "la letra se vuelve un visor; el anillo central es donde se enfoca") con el momento de firma del producto (§8.4). Debe leerse como el producto entendiendo el servidor, no como un spinner: va ligado al progreso real y termina nítido; si el run falla o es parcial, el anillo se detiene donde llegó — nunca completa por decoración.
- El `Fingerprint` en bloques de 4 nace de cómo la gente compara huellas de verdad (a ojo, por tramos); el diff old/new en `HOST_KEY_CHANGED` convierte el momento de mayor desconfianza en el más legible de la app. Solo tinta, nunca rojo/verde.
- El menú de cuenta al pie del sidebar sigue a Linear/Vercel/Raycast; el avatar de iniciales monocromo sigue la lógica de la marca (azul solo en el tile del favicon).
- La revisión humana es un acto de producto, no un checkbox: baseline antes de tocar nada, dirección aprobada antes de invertir en movimiento, y el movimiento probado con las manos en la app en vivo.
</specifics>

<deferred>
## Deferred Ideas
- **Inspector con contenido real** (logs de build en vivo, detalle de deployment) — Fase 13; esta fase entrega el slot y el contrato por breakpoint (D-08).
- **Nav jerárquica con Projects → Environments → Services** — Fase 13 pasa datos al `NavTree` (D-07).
- **Perfil editable y preferencias (reducir movimiento, densidad) dentro del menú de cuenta** y **tema persistido en el servidor** — Fase 9 (SET-02..06, D20/D21); el menú de cuenta de esta fase deja los slots ocupados con lo que existe (Settings, tema, sign out).
- **Columna del inspector redimensionable por el usuario** — no en v0.2; si algún día entra, con CSS `resize`, no con otro gesto `motion`.
- **Randomart ASCII de OpenSSH** para el fingerprint — descartado por §9 #7 y por no aportar sobre el diff por bloques.
- **Confirmación por mantener presionado con `clip-path`** (§7.5) como alternativa al nombre exacto — el brief lo llama "alternativa futura"; §9 #18 manda en v0.2.
- **Screenshots reales de la app rediseñada en la landing** — Fase 10 consume `docs/ui/approved/` (D-15).
- Reconciliar `width="240"` vs `"220"` del lockup en README/BRAND.md (nota de 07-10) — trivial, puede ir en un `/gsd-quick` o en el plan de docs de esta fase.
</deferred>

---
*Phase: 08-redise-o-de-la-app*
*Context gathered: 2026-09-23*
