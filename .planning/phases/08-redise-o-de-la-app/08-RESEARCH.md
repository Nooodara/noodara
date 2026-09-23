# Phase 8: Rediseño de la app - Research

**Researched:** 2026-09-23
**Domain:** UI motion/gesture engineering (`motion`/Framer Motion drag), Radix menu primitives, Next.js parallel routes, static safety gates, contrast auditing, human visual-review pipelines
**Confidence:** HIGH

## Summary

This phase is almost entirely spec-driven: `docs/ui-build-prompt.md` (the brief) and `08-CONTEXT.md`
(the locked decisions) already answer nearly every design and behavior question. The roadmap marks
research "light" and scopes it to exactly one item — verifying the `motion@13.4.1` drag/spring API
against the brief's §7.4 drag-to-dismiss sequence — plus a set of discretion areas the planner needs
concrete API shapes for (RowMenu primitive choice, keyboard-vs-pointer detection, shadow gate
extension, `backdrop-filter` budget, `@inspector` parallel route).

The Context7 check confirms `motion`'s built-in `drag` gesture (pointer capture, 1:1 tracking,
`dragElastic` rubber-banding, `dragMomentum`/`dragTransition` inertia, `onDragEnd`'s `info.velocity`)
covers most of brief §7.4 out of the box, **but two real gaps exist that the planner must account
for**: (1) `domAnimation` (the smaller LazyMotion feature bundle) does **not** include drag/pan —
only `domMax` does, so D19's "LazyMotion scoped to Sheet" must load `domMax`, not `domAnimation`;
(2) `motion`'s exact rubber-band constant and the brief's own hand-specified formula
(`constant = 0.55`) are not guaranteed to match — Motion's `dragElastic` accepts a 0–1 multiplier,
not the brief's exact hyperbolic-resistance formula, so a component test must assert the *felt*
curve, not assume Motion's default reproduces it.

Direct source reading of the current codebase surfaced three load-bearing facts CONTEXT.md does not
state explicitly, all of which change what the first plan must do:

1. **`RowMenu` does not currently close on select** (its Radix `Dialog` non-modal wrapper closes on
   `Esc` and outside-click via the primitive, but nothing calls `onOpenChange(false)` when
   `item.onSelect()` fires) and **has no `aria-expanded`** on its trigger — both are real, unfixed
   gaps, not already-closed debt, confirmed by reading `RowMenu.tsx` and its test file directly.
2. **The existing static gate `scripts/check-ui-safety.mjs` currently *forbids* `onEscapeKeyDown`/
   `onInteractOutside` overrides** on Radix Dialog/Sheet ("Radix's default behaviour must stay
   untouched"). The keyboard-vs-pointer detection this phase's discretion item asks for (to suppress
   close-animation on `Esc`, pitfall P14) must **not** be implemented by overriding those Radix
   escape hatches — it needs a different mechanism (e.g., branching inside the component's own
   `onOpenChange`/animation-trigger logic on `event.detail === 0` or a `pointerType` check), or the
   existing gate needs a deliberate, reviewed exception.
3. **The shell's current sidebar cluster testids (`shell-theme-toggle`, `shell-sign-out`) are
   directly asserted by `tests/e2e/shell.spec.ts`, `canary-ui.spec.ts`, and `brand.spec.ts`.**
   D-05's account-menu consolidation removes this cluster, so those exact E2E assertions must be
   rewritten in the same plan that ships the account menu (Pitfall 16's own discipline), not as a
   follow-up.

**Primary recommendation:** Treat this phase as implementation-of-a-known-spec, not exploration.
Sequence per D-13's three gates (G1 baseline → G2 shell/P0 → G3 motion/P1-P2), fix `RowMenu`'s two
real bugs explicitly (test-first, per ADR-0005) before it is reused by the account menu, register
`motion` (and `@radix-ui/react-dropdown-menu` if chosen) in `docs/adr/0000-package-legitimacy-
approvals.md` before install, and budget every static-gate change (shadow gate, `onEscapeKeyDown`
exception if needed) as its own reviewed diff against `scripts/check-ui-safety.mjs`.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**Superficies — cómo se cura lo "plano"**
- **D-01: Grupos inset.** El contenido de cada pantalla se organiza en bloques `surface-1` sobre `canvas`, radio `lg`, borde `hairline`, con las filas separadas por `hairline` dentro del bloque — el idioma de macOS System Settings / iOS grouped list. Aplica a los tres grupos label/valor del detalle (System, Docker, Connection), a `Instance` y `Advanced` de Settings, y a la lista de servidores. Es escalón de superficie, no card: **nunca sombra** en estos bloques (§9 #2), nunca bloques anidados (§9 #5).
- **D-02: La lista de servidores es un solo grupo inset** con las filas de 44 px dentro, separadas por hairline. La fila sigue siendo un link nativo; el `RowMenu` a la derecha; el empty state vive dentro del mismo bloque.
- **D-03: El chrome retrocede.** El sidebar deja de ser `surface-1` y se funde con el `canvas` — sin `border-r`; la separación la dan el espacio y el propio escalón de los grupos inset. El toolbar sigue translúcido sobre canvas y sustituye el `border-b` permanente por scroll edge effect (§5.3). Un solo `backdrop-filter` permanente en la página (el toolbar).
- **D-04: Layout intacto salvo lo que los grupos exigen.** Se conservan `max-w-[1120px]`, `p-8`, filas de 44 px, stat tiles, roles tipográficos y grid de 8 px. Cambia únicamente lo que los grupos inset obligan: padding interno del bloque, título de grupo fuera del bloque (rol `headline`/`label` según skill), separación entre grupos. No se rediseñan las pantallas como composición ni se toca la densidad.

**Shell preparado (UI-11)**
- **D-05: Menú de cuenta al pie del sidebar, absorbe tema y sign out.** Un único trigger al pie: avatar + nombre del admin (solo avatar en el rail de 64 px). Abre un menú flotante (`--shadow-floating`, mismo nivel que `RowMenu`) con: cabecera nombre/email, `Settings` (link), `Appearance` con el control de tema inline, `Sign out`. Reemplaza el cluster actual `ThemeToggle` + `SignOutButton`. El control de tema que vive dentro del menú **es** `ThemeToggle` o llama a su único write path (`STORAGE_KEY = 'noodara-theme'`, `packages/ui/src/ThemeToggle.tsx`) — nunca un segundo escritor (pitfall P17). La Fase 9 añade perfil y preferencias a este mismo menú sin reestructurarlo.
- **D-06: Avatar de iniciales monocromo.** Círculo `surface-3` con hairline, iniciales del nombre en `ink`, rol `label`. Cero azul: el acento sigue reservado a acciones (§9 #1) y la marca es monocroma dentro de la app (Fase 7 D-09). No hay subida de imagen.
- **D-07: `NavTree` genérico con hojas planas hoy.** Se construye en `packages/ui` un componente de árbol de navegación: items con hijos opcionales, expand/collapse animado con `grid-template-rows` (`Disclosure`), `aria-expanded`, estado de expansión por item, y en el rail de 64 px los hijos colapsan a tooltip/flyout. Hoy recibe exactamente tres hojas sin hijos (Servers, Activity, Settings) y se ve idéntico a la lista plana actual. La Fase 13 solo pasa datos (Projects con su subárbol). Sin etiquetas de sección ni ítems deshabilitados (§9 #8, #19). La navegación del sidebar **no** se anima (§6.1).
- **D-08: Slot del inspector como parallel route `@inspector`** en `apps/web/src/app/(shell)/layout.tsx`, con `default.tsx` que devuelve `null`: cuando está vacío no reserva ancho ni dibuja borde. Contrato para cuando la Fase 13 lo llene: a ≥1280 px es una columna derecha fija (~360–400 px) que estrecha el contenido; por debajo de 1280 px se presenta como `Sheet` lateral. Panel paralelo no bloqueante, sin scrim (§7.7). Esta fase entrega el slot, el layout de tres columnas condicional y su test; no el contenido.

**Momentos autorados (UI-08)**
- **D-09: Discovery = timeline con hilo + Viewfinder enfocando.** Los seis pasos cuelgan de un hilo vertical (hairline) que se "llena" en `ink` conforme los pasos completan; cada paso muestra su duración en `tabular-nums`; los checks entran con `translateY(4px) + opacity` y stagger de 40 ms sin bloquear la interacción. En la cabecera de la sección, el anillo central del monograma Viewfinder (Fase 7, `packages/ui/src/brand/geometry.ts`) va de abierto/desenfocado a nítido/cerrado a medida que avanzan los pasos — la idea diferida en 07-CONTEXT.md, "ver con claridad" hecha movimiento. Es **el** momento autorado del detalle: un único elemento de marca animado, ligado al estado real del run (nunca inventa progreso — `buildChecklist` sigue siendo la única fuente). En `prefers-reduced-motion` el anillo cambia de estado por crossfade sin trayectoria.
- **D-10: TOFU = componente `Fingerprint` + diff old/new.** Nuevo componente en `packages/ui`: el hash `SHA256:…` en mono grande, agrupado en bloques de 4 caracteres con espacio, prefijo `SHA256:` atenuado (`ink-secondary`), copiable de un tap (`CopyButton`). Es el mismo componente en las tres superficies: aviso de primera confianza (`FirstTrustNotice`), fila "Host fingerprint" del grupo Connection (`ServerFacts`) y diálogo de `HOST_KEY_CHANGED` (`TrustFingerprintDialog`), donde la huella confiada y la nueva se muestran alineadas bloque a bloque y los bloques que difieren se marcan con `ink` fuerte / peso 600 — **nunca con color** (§9 #1, #14). El diálogo sigue exigiendo el nombre exacto (§9 #18). Sin randomart ASCII.
- **D-11: Un momento discreto y propio por pantalla**, todos ya en la tabla §6.3 — aquí solo se fija cuál es "el" de cada una: `/login` y `/setup` → el monograma llega enfocando una sola vez al cargar (misma animación que D-09, sin loop); `/servers` → las filas entran con stagger en la primera carga y el `StatusPill` transiciona color/fondo al cambiar de estado; `/activity` → las filas nuevas que llegan por evento entran con `translateY + opacity` conservando scroll y contenido cargado (§7.8); `/settings` → la `Disclosure` "Advanced" con `grid-template-rows` es su único movimiento. Nunca la misma animación de entrada en todas las secciones (§8.4).

**Revisión visual humana (UI-12)**
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

### Deferred Ideas (OUT OF SCOPE)
- Inspector con contenido real (logs de build en vivo, detalle de deployment) — Fase 13; esta fase entrega el slot y el contrato por breakpoint (D-08).
- Nav jerárquica con Projects → Environments → Services — Fase 13 pasa datos al `NavTree` (D-07).
- Perfil editable y preferencias (reducir movimiento, densidad) dentro del menú de cuenta y tema persistido en el servidor — Fase 9 (SET-02..06, D20/D21); el menú de cuenta de esta fase deja los slots ocupados con lo que existe (Settings, tema, sign out).
- Columna del inspector redimensionable por el usuario — no en v0.2; si algún día entra, con CSS `resize`, no con otro gesto `motion`.
- Randomart ASCII de OpenSSH para el fingerprint — descartado por §9 #7 y por no aportar sobre el diff por bloques.
- Confirmación por mantener presionado con `clip-path` (§7.5) como alternativa al nombre exacto — el brief lo llama "alternativa futura"; §9 #18 manda en v0.2.
- Screenshots reales de la app rediseñada en la landing — Fase 10 consume `docs/ui/approved/` (D-15).
- Reconciliar `width="240"` vs `"220"` del lockup en README/BRAND.md — trivial, puede ir en un `/gsd-quick` o en el plan de docs de esta fase.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UI-03 | `Sheet`, `Dialog`, `RowMenu` get `--shadow-floating` (+ lighter dark-mode surface step); gate fails if any other component gets a shadow | Current state confirmed: none of the three has any shadow today (see Architecture Patterns §1, Code Examples §1); shadow-gate extension pattern in Common Pitfalls / Code Examples |
| UI-04 | `RowMenu` closes on select, returns focus to trigger, visible on touch, announces open/closed | Two real, unfixed gaps confirmed by direct source read (no close-on-select call, no `aria-expanded`) — see Summary and Architecture Patterns §2; RowMenu-vs-dropdown-menu comparison in Don't Hand-Roll |
| UI-05 | Press feedback `scale(0.97)` everywhere pressable; custom easings/duration table replace built-ins; no animation on keyboard-initiated actions | Pitfall 14 (P14) + the `onEscapeKeyDown`/`onInteractOutside` static-gate conflict this research found — see Common Pitfalls §1 |
| UI-06 | `Sheet` drag-to-dismiss, full §7.4 sequence, `motion` scoped to Sheet | Context7-verified `motion` drag API mapping in Architecture Patterns §3; gaps vs. brief noted (domMax requirement, rubber-band formula, velocity units) |
| UI-07 | Scroll-edge toolbar; `RowMenu`/`Tooltip` origin-anchored, `Dialog` centered; `Disclosure` grid-rows; discovery/list stagger 40ms | Values already fixed in brief §6.3, table reproduced in State of the Art |
| UI-08 | Discovery narration + fingerprint/TOFU as authored moments (brand-swap test) | D-09/D-10 fully spec'd; Viewfinder `data-part="aperture"` hook confirmed present in `geometry.ts`/`Logo.tsx` — see Architecture Patterns §4 |
| UI-09 | Surface craft: tabular numerals, text-wrap, measure, themed browser surfaces, blur bridge, `@starting-style`, clip-path disk meter | Brief §5.2/§7.5/§7.6/§8.3 fully spec'd; no additional research needed |
| UI-10 | `prefers-reduced-motion`/`-transparency`/`contrast: more` fallbacks; hover gated; ≤3 simultaneous `backdrop-filter` | Backdrop-filter worst-case count derived in Architecture Patterns §5; media-query patterns in brief §6.5 |
| UI-11 | Shell ships inspector slot, hierarchical nav, account menu with no visible placeholders | `@inspector` parallel-route pattern confirmed against Next.js 16 (pinned) docs and existing `ARCHITECTURE.md` §8 route tree — see Architecture Patterns §6; E2E testid impact on `shell-theme-toggle`/`shell-sign-out` flagged in Summary |
| UI-12 | Contrast measured, both themes, 4 widths, human-approved screenshots; existing E2E stay green | Capture pipeline reuse pattern from Phase 7 (07-04/07-05) documented in Architecture Patterns §7; current E2E inventory (15 specs, ~104 tests) in Environment Availability / Validation Architecture |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Floating elevation (`--shadow-floating`), surface tokens | Browser / Client (CSS, `packages/ui/tokens.css`) | — | Pure visual tokens, no data flow |
| `Sheet` drag-to-dismiss gesture | Browser / Client (`motion` inside `packages/ui/src/Sheet.tsx`) | — | Gesture physics run entirely client-side against DOM pointer events; no server involvement |
| `RowMenu` / Account menu behavior (close-on-select, focus return, `aria-expanded`) | Browser / Client (Radix primitive + `packages/ui`) | — | Pure interaction state, no persistence |
| Theme write path (`ThemeToggle` inside account menu) | Browser / Client (`localStorage` + `theme-script.ts` first paint) | Frontend Server (SSR first-paint script) | v0.2 keeps theme client-only (server persistence is Phase 9/D20-D21) |
| `NavTree` hierarchical nav (shell/interaction pattern) | Browser / Client (`packages/ui`) | Frontend Server (Next.js route tree drives which leaves render) | Data (Projects) stays out of scope; only the generic tree component is built now |
| `@inspector` parallel-route slot | Frontend Server (Next.js App Router route group, `apps/web/src/app/(shell)/layout.tsx`) | Browser / Client (breakpoint-driven column-vs-sheet presentation) | Next.js parallel routes are resolved server-side per request but the empty/column/sheet decision is a client-side breakpoint read |
| Viewfinder ring animation (discovery progress) | Browser / Client (SVG `data-part` + CSS/WAAPI) | — | Purely derived from client-side `buildChecklist` state already streamed via SSE |
| `Fingerprint` component (TOFU diff) | Browser / Client (`packages/ui`) | — | Renders data already delivered by existing API; no new data flow |
| Baseline/approval screenshot pipeline | Browser / Client (Playwright captures the running app) | CI/tooling (`scripts/brand/capture-brand-review.ts`-derived script) | Same pattern as Phase 7; not part of the shipped product |
| Contrast measurement | Tooling (`packages/ui/src/contrast.ts`, Vitest) | — | Static analysis over `tokens.css`, no runtime component |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `motion` | `13.4.1` (pinned by D19; latest on registry at research time is `13.4.2` — do not bump without re-running provenance) | Interruptible spring-based drag-to-dismiss for `Sheet` only | `[VERIFIED: Context7 (motion.dev docs) + npm registry]`. D19 is a locked decision from `research/SUMMARY.md`; this session re-confirmed the exact version exists on the registry and that its documented `drag`/`useMotionValue`/`useSpring`/`animate`/`LazyMotion` APIs cover brief §7.4's required behaviors (see Architecture Patterns §3) |

### Supporting (discretion — planner decides)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@radix-ui/react-dropdown-menu` | `2.1.24` (latest stable; repo `radix-ui/primitives`, same org as every other approved Radix package) | Alternative `RowMenu`/`AccountMenu` primitive if the planner chooses migration over fixing the hand-rolled non-modal `Dialog` | `[ASSUMED]` — name and fitness came from training knowledge of the Radix primitive family plus this session's `npm view`/`slopcheck` check, not from a Context7 docs fetch of the dropdown-menu component itself. Registry existence + matching repo (`radix-ui/primitives`, identical to the seven already-approved Radix packages) is a strong signal but does not upgrade this past `[ASSUMED]` per the package-name provenance rule. If chosen, a human should confirm this is the right migration path is worth the diff vs. the two-bug fix (see Don't Hand-Roll) before committing to it. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Fixing hand-rolled `RowMenu` (non-modal Radix `Dialog`) | `@radix-ui/react-dropdown-menu` | The hand-rolled version already gets Esc-close, outside-click-close, and focus-return "for free" from `DialogPrimitive`'s non-modal mode (confirmed by reading `RowMenu.tsx`'s own header comment and test file) — the two real bugs (no close-on-select, no `aria-expanded`, plus the `key={item.label}` collision risk) are small, targeted fixes. `react-dropdown-menu` gives WAI-ARIA Menu semantics and close-on-select natively but is a net-new dependency requiring a new ADR-0000 entry and provenance re-run, and its own focus-management/typeahead behavior would need to be re-verified against this app's screen-reader requirement (G2) from scratch rather than building on a component already partially screen-reader-shaped. |
| Motion's built-in `dragElastic`/`dragTransition` momentum | Hand-rolled rubber-band + momentum-projection functions exactly as written in brief §7.4 | Motion's built-ins are close in spirit (both use a hyperbolic-resistance-style elastic formula and an exponential-decay-style inertia animation) but are not guaranteed byte-for-byte identical to the brief's own `rubberband(overshoot, dimension, 0.55)` and `project(velocity, 0.998)` formulas. A component test should assert the *rendered* curve (e.g., snapshot the transform at a few time steps) rather than assume Motion's internals match; if they diverge visibly, `useMotionValue` + a hand-written `animate()`/`useSpring()` pipeline driven by raw `pointermove` events (not the `drag` prop) is the fallback that gives full formula control. |

**Installation:**
```bash
pnpm --filter @noodara/ui add motion@13.4.1
# If RowMenu migrates:
pnpm --filter @noodara/ui add @radix-ui/react-dropdown-menu@2.1.24
```

**Version verification:** confirmed via `npm view motion versions` (13.4.1 present, 13.4.2 is latest) and `npm view motion repository.url` → `git+https://github.com/motiondivision/motion.git`, matching D19's locked choice. `npm view @radix-ui/react-dropdown-menu version` → `2.1.24`, `repository.url` → `git+https://github.com/radix-ui/primitives.git` (same repo as every already-approved Radix package in `docs/adr/0000-package-legitimacy-approvals.md`).

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `motion` | npm | mature (Framer Motion's successor package, multi-year history) | very high (millions/week under `framer-motion` + `motion`) | `github.com/motiondivision/motion` | `[OK]` (`slopcheck scan --pkg npm motion --json` → `status: OK`, no flags) | Approved — `[VERIFIED: Context7 + npm registry]`, matches D19's locked pin |
| `@radix-ui/react-dropdown-menu` | npm | mature (same monorepo/release cadence as the 8 already-approved `@radix-ui/react-*` packages) | high (same publisher, `radix-ui`) | `github.com/radix-ui/primitives` | `[OK]` (`slopcheck scan --pkg npm @radix-ui/react-dropdown-menu --json` → `status: OK`, no flags) | Conditionally approved — `[ASSUMED]` provenance tag (see Standard Stack note); only needed if the planner chooses the migration path for `RowMenu`. Neither package declares a `postinstall` script (checked via `npm view <pkg> scripts.postinstall`, both empty). |

**Packages removed due to slopcheck `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none — both packages returned clean `[OK]` verdicts. `@radix-ui/react-dropdown-menu` is still tagged `[ASSUMED]` per the package-name provenance rule (not discovered via Context7/official docs this session), so if the planner selects it, gate the install behind a `checkpoint:human-verify` per the Package Legitimacy Gate protocol, exactly as Phase 7 did for `sharp`/`png-to-ico`.

Both packages must be added to `scripts/check-package-provenance.mjs`'s `EXPECTED_PACKAGES` list (`motion` → `motiondivision/motion`; `@radix-ui/react-dropdown-menu` → `radix-ui/primitives`) and to `docs/adr/0000-package-legitimacy-approvals.md`'s "Phase 8 additions" section before either is installed, following the exact table format Phase 7 used.

## Architecture Patterns

### System Architecture Diagram

```
User gesture (pointerdown on Sheet)
        │
        ▼
┌─────────────────────────────┐
│ packages/ui/src/Sheet.tsx    │  LazyMotion(features=domMax) wraps ONLY this subtree
│  <m.div drag="x"              │  (D19: motion never leaks outside Sheet)
│    dragConstraints            │
│    dragElastic                │──► onDrag(event, info) ──► rubber-band feel while dragging
│    dragMomentum/dragTransition│──► onDragEnd(event, info) ──► info.velocity (px/s)
│  >                            │        │
└─────────────────────────────┘        ▼
                                  decide close-vs-snap-back
                                  (velocity sign threshold, brief §7.4 #6)
                                        │
                                        ▼
                              animate() to target with
                              initial velocity = release velocity
                              (handoff, brief §7.4 #8)
                                        │
                                        ▼
                              onOpenChange(false) → Radix Dialog unmounts
                                        │
                                        ▼
                     ── separate path: Esc key ──►  NO motion animation
                                                     (keyboard-initiated, §6.1/§9 #10)
                                                     branch lives INSIDE Sheet's own
                                                     close handler, never at call site


Shell render (server + client)
        │
        ▼
apps/web/src/app/(shell)/layout.tsx
   ├── NavTree (packages/ui)      ── client, no animation on nav click (D-07)
   ├── AccountMenu (packages/ui)  ── client, shares floating-menu primitive with RowMenu (D-05)
   ├── {children}                 ── content panel, existing screens + InsetGroup wrapping
   └── @inspector (parallel route)── Next.js slot; default.tsx returns null when empty (D-08)
                                      ≥1280px → fixed column, <1280px → Sheet, both client-breakpoint-driven
```

### Recommended Project Structure

```
packages/ui/src/
├── Sheet.tsx                 # gains drag-to-dismiss (motion, LazyMotion domMax scoped here only)
├── RowMenu.tsx                # fixed: close-on-select, aria-expanded, stable keys, --shadow-floating
├── Dialog.tsx                 # gains --shadow-floating, centered scale(0.95)→1 transform-origin
├── AccountMenu.tsx            # NEW — shares floating-menu primitive with RowMenu (D-05)
├── NavTree.tsx                # NEW — generic hierarchical nav, flat 3-leaf data today (D-07)
├── InsetGroup.tsx             # NEW — surface-1 grouped-list wrapper consumed by LabelValue/ListRow (D-01/D-02)
├── Fingerprint.tsx            # NEW — shared TOFU block component (D-10)
├── tokens.css                 # + --shadow-floating, --ease-out/in-out/drawer, browser-surface tokens
├── contrast.ts                # generalized token-loop to also audit new elevation/surface tokens (P13)
apps/web/src/
├── app/(shell)/layout.tsx     # + @inspector slot, NavTree/AccountMenu replace Sidebar's flat cluster
├── app/(shell)/@inspector/
│   └── default.tsx            # returns null — empty slot, no width/border reserved
├── components/
│   ├── DiscoverySection.tsx   # timeline-with-thread + Viewfinder ring header (D-09)
│   ├── FirstTrustNotice.tsx   # ── consumes Fingerprint
│   ├── ServerFacts.tsx        # ── consumes Fingerprint + InsetGroup
│   └── TrustFingerprintDialog.tsx # ── consumes Fingerprint (old/new diff)
scripts/
└── check-ui-safety.mjs        # + shadow-outside-allowlist gate (UI-03)
docs/ui/
├── APPROVAL.md                # D-15, mirrors docs/brand/APPROVAL.md
├── approved/                  # 1280px final captures, in git
└── review/                    # gitignored scratch, all widths/rounds
```

### Pattern 1: `Sheet` drag-to-dismiss with `motion`, scoped by `LazyMotion`

**What:** Wrap only `Sheet.tsx`'s panel in `<LazyMotion features={domMax} strict><m.div drag="x" ...>`.
**When to use:** Exactly one place — the `Sheet` component. D19 forbids `motion` anywhere else in the codebase; `strict` mode makes any accidental `motion.*` import elsewhere in the tree throw at runtime instead of silently working, which is a useful enforcement mechanism worth adopting.
**Confirmed via Context7 (motion.dev docs, this session):**
```jsx
// Source: https://motion.dev/docs/react-reduce-bundle-size
// domAnimation: animations, variants, exit, tap/hover/focus gestures (+15kb) — NO drag
// domMax: all of the above PLUS pan/drag gestures and layout animations (+25kb)
import { LazyMotion, m } from 'motion/react';
const loadFeatures = () => import('./motion-features.js').then((res) => res.default); // exports domMax

function Sheet() {
  return (
    <LazyMotion features={loadFeatures} strict>
      <m.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.15}          // approximate the brief's constant=0.55 rubber-band; verify by feel, not formula equality
        dragMomentum
        onDragEnd={(event, info) => {
          // info.velocity is in px/s per Motion's own useVelocity example range (±3000)
          // brief's threshold (0.11 px/ms = 110 px/s) may need recalibration against this unit — see Open Questions
        }}
      />
    </LazyMotion>
  );
}
```
**Gap vs. brief:** the brief's §7.4 steps 1–5 (manual `setPointerCapture`, offset-from-grab, 10px hysteresis threshold, multi-touch ignore, hand-written rubber-band formula) are handled *internally* by Motion's `drag` implementation — the component does not need to hand-roll them, but the planner should decide whether to trust Motion's internals as satisfying those acceptance criteria or write an E2E/component test that observes the *rendered behavior* (e.g., does the panel visibly resist past the edge with progressive resistance) rather than trying to assert Motion's private implementation matches the formula literally.

### Pattern 2: Interruptibility

**What:** Grabbing the `Sheet` mid-close-animation must resume 1:1 tracking from the panel's current on-screen position, not finish closing.
**Confirmed via Context7:** Motion's `drag` gesture writes directly to the element's `MotionValue`; a `pointerdown` during an in-flight `animate()`/spring on that same value takes over control of it automatically (this is a well-established Motion/Framer Motion behavior family, not something the component needs to hand-implement) — but this session's Context7 queries did not surface an explicit doc passage stating this for the exact `drag` + `animate()`-to-close combination used here, so tag this specific claim `[ASSUMED]` and verify it with a dedicated Playwright test (grab the sheet mid-flight, assert it tracks the pointer from its current position, not the target) before relying on it.

### Pattern 3: `RowMenu` fix (recommended over migration)

**What:** Keep the existing `DialogPrimitive.Root modal={false}` foundation (it already gives Esc-close, outside-pointer-down-close, and close→trigger-focus-return "for free" from Radix, per the component's own header comment and confirmed by its test file). Add exactly three things:
1. `onSelect` handlers call `setOpen(false)` (currently `RowMenuProps` has no open-state callback at all — the component manages `DialogPrimitive.Root`'s open state internally with no controlled prop, so item selection has nothing to close). This requires either lifting to a controlled `open`/`onOpenChange` pair or wrapping each `item.onSelect` internally to also close.
2. `aria-expanded={open}` on the `DialogPrimitive.Trigger` (currently only `aria-haspopup="menu"` is present).
3. Replace `key={item.label}` with a stable, caller-supplied `id` (or index) — two menu items with the same label currently collide.
**When to use:** This is the P0 backlog item 2 fix; do it *before* `AccountMenu` (D-05) is built, since D-05 explicitly says the account menu should share the same floating-menu primitive.

### Pattern 4: `@inspector` parallel route, empty by default

**What:** Next.js App Router parallel route slot with a `default.tsx` returning `null`.
```tsx
// Source: pattern confirmed against .planning/research/ARCHITECTURE.md §8.1 and Next.js 16
// (pinned, apps/web/package.json) App Router parallel-route conventions
// apps/web/src/app/(shell)/@inspector/default.tsx
export default function InspectorDefault() {
  return null;
}
```
The layout composes it as a sibling slot prop:
```tsx
export default function ShellLayout({ children, inspector }: { children: ReactNode; inspector: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <NavTree />
      <main className="min-w-0 flex-1">{children}</main>
      {/* At >=1280px: fixed column that narrows `main`. At <1280px: rendered as a Sheet instead
          (breakpoint read client-side, since Next's slot itself doesn't know the viewport). */}
      <aside className="hidden min-[1280px]:block w-[380px]">{inspector}</aside>
    </div>
  );
}
```
`ARCHITECTURE.md` §8's own route tree (already researched for a later phase) puts the real inspector content under `.../deployments/[deploymentId]/@inspector/...` — this phase only needs the slot to exist and render nothing, at the `(shell)` layout level, so Phase 13 can nest a populated version without restructuring.
**Verification approach (Playwright, no content):** assert the slot renders (element exists, zero width/no border at <1280px and when nothing is passed) and assert the ≥1280px column reserves ~360–400px and visibly narrows the content column — both testable with a stub `inspector` prop or by temporarily rendering a marker node in the E2E fixture, not by adding product content early.

### Pattern 5: `backdrop-filter` worst-case count

Per Pitfall 15 and CONTEXT.md's own explicit worst case: **toolbar (1, permanent) + Sheet (1) + RowMenu-inside-Sheet (1) + Tooltip (1) = 4**, one over the brief's stated "never more than three" (UI-10, success criterion 4). The planner must collapse at least one to a solid/near-solid material. Recommended (per CONTEXT.md's own candidate list and the brief's §7.7 "heavier materials for structural/small regions" guidance): make `RowMenu` and `Tooltip` solid `surface-3` (both are small, chip-like surfaces where §7.7 explicitly permits heavier material), leaving `Sheet` as the one translucent overlay besides the toolbar. This keeps the worst case at exactly 2 simultaneous `backdrop-filter` instances (toolbar + Sheet), safely under budget even before the count is measured on real hardware per §7.10.

### Pattern 6: Viewfinder ring animation hook

`packages/ui/src/brand/geometry.ts` already exports `[data-part="aperture"]` specifically for this phase's animation (confirmed by reading the file's own header comment: *"Phase 8 animates the mark (UI-08) by selecting `[data-part="aperture"]`"*). No `motion` — CSS custom properties driven by discovery step count, or WAAPI (`element.animate()`) if programmatic control over the crossfade-on-reduced-motion fallback is needed. `DiscoverySection`/`DiscoveryStep` already consume `buildChecklist` (`apps/web/src/lib/discovery-progress.ts`) as the single source of step-completion state — the ring's visual state must derive from the same function, never a second progress computation.

### Pattern 7: Baseline + gated approval pipeline (reuse Phase 7's exact shape)

Phase 7's `scripts/brand/{review-paths,board-html,capture-brand-review}.ts` + `docs/brand/APPROVAL.md` + `tests/unit/brand/approval-record.test.ts` is the direct template:
- `review-paths.ts`-equivalent: enumerate the 6 screens × 2 themes × 4 widths (375/900/1280/1920) + overlay captures (Sheet, Dialog, RowMenu open) as a fixed matrix, derived from a `SCREENS`/`THEMES`/`WIDTHS` constant, never hand-listed per capture.
- `capture-brand-review.ts`-equivalent: reuse `tests/e2e/fixtures/stack.ts`'s `startStack()`/`stopStack()` Docker path (same as Phase 7) with the sshd Testcontainers fixture states D-12 names (connected+discovered, error, 80-char name, empty list) rather than inventing a new fixture mechanism.
- `docs/ui/APPROVAL.md` + `docs/ui/approved/` (1280px only, git-tracked) + `docs/ui/review/` (gitignored, all widths/rounds) mirrors `docs/brand/` exactly, including a `tests/unit/ui/approval-record.test.ts` that (a) parses the approval table, (b) pins the approved file set, (c) forbids AI-attribution strings under `docs/ui/`.

### Anti-Patterns to Avoid

- **Animating `Esc`-triggered `Sheet`/`Dialog`/`RowMenu` close the same way as gesture-close** — explicitly banned (brief §9 #10, Pitfall P14). The current `check-ui-safety.mjs` gate also means this cannot be solved by overriding `onEscapeKeyDown`; the branch must live inside the component's own close-trigger-source detection.
- **A second theme write path inside the new `AccountMenu`** — must call `ThemeToggle`'s existing single write path, not `localStorage.setItem` directly (Pitfall P17, already fixed once in this codebase for the sidebar's own toggle).
- **Building `NavTree` against real `Project` data now** — D-07 explicitly wants it built generic-first, wired with real data only in Phase 13, per `ARCHITECTURE.md` §8.2's own warning about inventing a flat-nav pattern that later needs restructuring.
- **Treating Motion's `dragElastic`/`dragMomentum` defaults as automatically satisfying brief §7.4's literal formulas** — verify the felt curve, don't assume equivalence (see Standard Stack Alternatives).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Interruptible, velocity-aware drag-to-dismiss physics | A custom `requestAnimationFrame` physics integrator tracking `pointermove` history, computing rubber-band resistance and momentum projection by hand | `motion`'s `drag` + `dragElastic` + `dragMomentum`/`dragTransition` + `onDragEnd`'s `info.velocity`, scoped via `LazyMotion(domMax)` | D19's own stated reasoning: "Interruptible spring gestures are not achievable with CSS; hand-rolling a physics integrator is more code to own than the library" (`research/SUMMARY.md`) |
| WAI-ARIA Menu Button semantics (`aria-expanded`, close-on-select, roving focus) if migrating away from the hand-rolled `RowMenu` | A second hand-rolled implementation reinventing what Radix already ships | `@radix-ui/react-dropdown-menu` (if the planner chooses migration) — already vetted at `[OK]` by slopcheck and matches the org (`radix-ui/primitives`) of every other approved primitive | Radix already solves focus management, typeahead, and ARIA roles correctly; reinventing it is exactly the kind of "delete instead of maintain" case the brief's §7.1 discipline argues against for anything Radix already provides |
| Contrast measurement for new elevation/surface tokens | A one-time manual audit at the start of the phase | Generalize `packages/ui/src/contrast.ts`'s existing `FILL_TOKEN_RE`-style name-derived loop to also catch new `--shadow-floating`-adjacent surface tokens as they're added | Pitfall P13: contrast is a property of the *rendered* pair, not the token; a name-derived loop (already built once for `accent-fill`-family tokens) stays correct as new tokens are added, a hand-maintained audit list goes stale |
| Screenshot capture/approval tooling | A new bespoke Playwright harness for this phase | Copy Phase 7's `scripts/brand/*` shape almost verbatim (see Architecture Patterns §7) | The exact same problem (multi-theme, multi-surface, human-gated capture) was solved once, two weeks prior, in this same repo — reusing it is strictly cheaper and keeps the approval-record test pattern consistent |

**Key insight:** every "don't hand-roll" item in this phase has a same-repo precedent already built and proven (Phase 7's capture pipeline, `contrast.ts`'s token-loop, `RowMenu`'s existing Radix foundation) or a research-backed library choice (`motion` for D19). The risk in this phase is not missing tooling, it is *reimplementing* something that already exists nearby.

## Common Pitfalls

### Pitfall 1: The existing shadow/escape-hatch static gate conflicts with the P14 fix

**What goes wrong:** `scripts/check-ui-safety.mjs` currently has a gate named *"zero `onEscapeKeyDown`/`onInteractOutside` overrides (Radix Dialog/Sheet default behaviour must stay untouched)"*, with `expected: 0`. Pitfall P14 (from `research/PITFALLS.md`) recommends exactly the kind of trigger-source branching that a naive implementation might reach for via `onEscapeKeyDown`. If a plan adds `onEscapeKeyDown` to suppress the close-animation on `Esc`, the very gate that predates this phase will fail CI.
**Why it happens:** The gate was written in Phase 5 for a different reason (preventing accidental overrides of Radix's own dismiss *behavior* — closing at all), not anticipating a future need to distinguish *how* a dismissal is animated without touching *whether* it dismisses.
**How to avoid:** Implement the keyboard-vs-pointer distinction entirely inside the component's own state (e.g., track `event.detail === 0` inside a native `keydown`/`click` listener the component already owns, or read `:focus-visible` via a class toggle), never via Radix's `onEscapeKeyDown`/`onInteractOutside` props. If no clean alternative exists, treat extending or narrowing this specific gate as its own reviewed diff (name the exception explicitly, don't silently loosen the regex).
**Warning signs:** `pnpm check:ui-safety` (or its future name) failing right after a `Sheet`/`Dialog`/`RowMenu` animation-suppression change; a PR touching `onEscapeKeyDown` anywhere in `packages/ui`/`apps/web`.
**Phase to address:** This phase, specifically whichever plan implements the keyboard/pointer-close distinction (Claude's Discretion item).

### Pitfall 2: `RowMenu`'s current state is *less* fixed than the brief's own §3.3 debt list implies

**What goes wrong:** The brief and CONTEXT.md both describe `RowMenu`'s debt as "seleccionar un item no cierra el menú ni devuelve el foco" — but direct source reading shows `RowMenu.tsx`'s *close-on-Escape-with-focus-return* and *close-on-outside-click* already work today (inherited free from `DialogPrimitive.Root modal={false}`). Only close-on-**select** and `aria-expanded` are actually missing. A plan that assumes focus-return is entirely broken and re-implements it from scratch risks duplicating (and potentially conflicting with) Radix's own working focus-return logic.
**Why it happens:** The brief's §3.3 was written in prose before this session's direct source read; "seleccionar un item no cierra el menú ni devuelve el foco" is one sentence describing two coupled symptoms (if it never closes on select, focus obviously never returns *from that specific trigger path* either — but the underlying focus-return mechanism itself is not broken).
**How to avoid:** Read `RowMenu.tsx` and `RowMenu.test.tsx` before writing the fix plan; write the RED test for "closes and returns focus after selecting" specifically (not "closes and returns focus" in general, which already partially passes via Esc/outside-click), confirm it fails only on the select path, then fix narrowly (see Architecture Patterns §3).
**Warning signs:** A plan that rewrites `RowMenu`'s dismiss/focus logic wholesale instead of adding the three specific, narrow fixes in Pattern 3.
**Phase to address:** This phase, G2 wave (per D-13).

### Pitfall 3: `motion`'s velocity units may not match the brief's calibrated threshold

**What goes wrong:** Brief §7.4 step 6 states *"velocidad > 0.11 px/ms cierra sin importar la distancia recorrida"* — a threshold calibrated against a specific (unstated) velocity-computation method. Motion's own documented `useVelocity` example uses a range of `[-3000, 0, 3000]` (implying px/s, consistent with Motion's own docs describing `info.velocity` in px/s), meaning `0.11 px/ms` converts to `110 px/s` — plausible but not verified against Motion's actual sampling window, which may compute velocity differently (e.g., averaged over the last N pointer events) than however the brief's number was originally derived.
**Why it happens:** The brief's number was written as generic implementation guidance (likely from the same design-engineering sources the doc cites in its own header), not measured against this specific library's velocity computation.
**How to avoid:** Treat `0.11 px/ms` (110 px/s) as a *starting point*, not a hard-coded final value. Add a component/E2E test that performs a fast, short flick and asserts the sheet closes, and a slow, long drag past the midpoint that asserts it also closes (position-based fallback) — tune the exact threshold empirically against Motion's real `info.velocity` output rather than trusting the brief's number to transfer unit-for-unit.
**Warning signs:** A flick that visually "should" close the sheet not closing in manual testing (G2/G3 live review per D-14); a threshold constant with no comment explaining how it was measured.
**Phase to address:** This phase, the drag-to-dismiss plan (P1, UI-06).

### Pitfall 4: E2E testids the account-menu consolidation will remove

**What goes wrong:** `tests/e2e/shell.spec.ts`, `tests/e2e/canary-ui.spec.ts`, and `tests/e2e/brand.spec.ts` all assert `getByTestId('shell-theme-toggle')` and/or `shell-sign-out` directly (confirmed by grep). D-05 replaces this cluster with a single `AccountMenu` trigger. If the account-menu plan does not update these three spec files in the same plan, `pnpm test:e2e` breaks immediately and stays broken until a later "fix the tests" pass — exactly the anti-pattern Pitfall P16 warns against.
**Why it happens:** CONTEXT.md correctly says the account menu "reemplaza el cluster actual" but doesn't enumerate which E2E specs assert the old testids by name; that enumeration only surfaces by reading the specs directly.
**How to avoid:** The plan that ships `AccountMenu` must, in the same commit/plan, update `shell.spec.ts`/`canary-ui.spec.ts`/`brand.spec.ts` to assert the new menu's structure (e.g., open the account menu, then assert the theme control and sign-out item inside it) — TDD RED-first on the new expected DOM shape, per ADR-0005.
**Warning signs:** `pnpm test:e2e` failures in exactly those three spec files right after an account-menu PR; a plan that touches `Sidebar.tsx`/`SignOutButton.tsx`/`ThemeToggle.tsx` mounting with no corresponding `tests/e2e/*.spec.ts` diff.
**Phase to address:** This phase, the shell/account-menu plan (G2 wave, UI-11).

### Pitfall 5 (inherited from `research/PITFALLS.md`, restated with this session's specifics): Contrast regression from new elevation/materials

See `research/PITFALLS.md` Pitfall 13 verbatim — restated here because it applies directly to every G2/G3 plan in this phase. Concretely: any plan adding `--shadow-floating`, the account-menu's `surface-3` avatar circle, `InsetGroup`'s `surface-1`-on-`canvas` treatment, or the toolbar's scroll-edge material must add a corresponding `contrast.ts`-style measurement for every new text/border pair, in both themes, in the *same* plan — not a phase-end audit.

### Pitfall 6 (inherited): Animating keyboard-initiated actions

See `research/PITFALLS.md` Pitfall 14 verbatim; this session's specific addition is Pitfall 1 above (the static-gate conflict this creates).

### Pitfall 7 (inherited): `backdrop-filter` jank from stacking translucent surfaces

See `research/PITFALLS.md` Pitfall 15 verbatim; this session's specific addition is the worked worst-case count and recommended fix in Architecture Patterns §5.

### Pitfall 8 (inherited): Breaking the existing E2E suite

See `research/PITFALLS.md` Pitfall 16 verbatim. **Correction to the pitfall's own text:** it says "93 E2E tests" — CONTEXT.md and this session's own count confirm the *current* count is **104** across 15 spec files (Phase 7 added 11 new brand-related E2E tests after Pitfall 16 was written). Use 104 as the baseline to preserve, not 93.

### Pitfall 9 (inherited): Theme-override flicker on reload

See `research/PITFALLS.md` Pitfall 17 verbatim — directly relevant here because D-05 moves the theme control into a new mounting location (`AccountMenu`); it must still call `ThemeToggle`'s one write path, not a new one.

## Code Examples

### `RowMenu` close-on-select fix (sketch, not final code)

```tsx
// packages/ui/src/RowMenu.tsx — sketch of the minimal diff
export interface RowMenuProps {
  readonly items: readonly RowMenuItem[];
  readonly triggerLabel: string;
  readonly 'data-testid'?: string;
}

export function RowMenu({ items, triggerLabel, 'data-testid': testId }: RowMenuProps) {
  const [open, setOpen] = useState(false); // NEW — was implicit/uncontrolled before
  // ...
  return (
    <DialogPrimitive.Root modal={false} open={open} onOpenChange={setOpen}>
      <div className="relative inline-block">
        <DialogPrimitive.Trigger
          aria-haspopup="menu"
          aria-expanded={open} // NEW — was missing entirely
          // ...
        />
        <DialogPrimitive.Content /* gains --shadow-floating class */>
          {items.map((item, index) => (
            <button
              key={item.id ?? index} // NEW — was key={item.label}, collision risk
              role="menuitem"
              onClick={() => {
                item.onSelect();
                setOpen(false); // NEW — the actual UI-04 fix
              }}
            >
              {item.label}
            </button>
          ))}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Root>
  );
}
```

### `@inspector` empty slot test (Playwright, no content)

```ts
// Source: pattern derived from ARCHITECTURE.md §8.1's route tree + this session's Next.js 16 confirmation
test('inspector slot reserves no space when empty, at any width', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/servers');
  const inspector = page.locator('[data-testid="shell-inspector-slot"]');
  await expect(inspector).toHaveCount(1);
  const box = await inspector.boundingBox();
  expect(box?.width ?? 0).toBe(0); // default.tsx returns null -> zero-width slot
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| No shadow on `Sheet`/`Dialog`/`RowMenu` | `--shadow-floating` (light `0 8px 30px rgba(0,0,0,.12)`, dark `0 12px 40px rgba(0,0,0,.50)` + lighter surface step) | This phase, P0 item 1 | Closes the one elevation FLAG the design system specified but never shipped (§3.3) |
| `RowMenu` never closes on select, no `aria-expanded` | Fixed per Pattern 3 | This phase, P0 item 2 | Unblocks reuse by `AccountMenu` (D-05) and the screen-reader G2 check |
| `border-b border-hairline` under toolbar | Scroll-edge effect (gradient/mask, appears only when content scrolls under) | This phase, P1 item 8 | §5.3's own conflict-resolution table: "gana la doctrina" over the locked design system's static border |
| Flat 3-item sidebar list | `NavTree` (generic, 3 flat leaves today) | This phase, UI-11/D-07 | Phase 13 wires real `Project` subtrees without restructuring |
| Two-panel shell (nav + content) | Three-panel-ready shell (`@inspector` slot present, empty) | This phase, UI-11/D-08 | Phase 13 populates the inspector without a layout rewrite |
| Separate `ThemeToggle` + `SignOutButton` in sidebar | Single `AccountMenu` (avatar + name trigger) absorbing both | This phase, UI-11/D-05 | Phase 9 extends the same menu with profile/preferences, no restructure |
| CSS-only motion (durations/easings) everywhere | `motion` (scoped, `LazyMotion(domMax)`) for `Sheet` drag only, CSS transitions everywhere else | This phase, D19 (locked pre-phase) | Only interruptible/gesture-driven motion needs a JS library; everything else stays cheaper CSS per brief §6.4 |

**Deprecated/outdated:**
- Pitfall P16's own stated E2E baseline ("93 E2E tests") is stale — the real current count is 104 (Phase 7 added 11). Use 104.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@radix-ui/react-dropdown-menu@2.1.24` is a legitimate, fit-for-purpose package for the `RowMenu`/`AccountMenu` migration path | Standard Stack, Package Legitimacy Audit | Low — slopcheck returned clean, repo matches the already-trusted `radix-ui/primitives` org, and this is only relevant if the planner chooses migration over the recommended in-place fix; a human should still confirm at a `checkpoint:human-verify` before install per the Package Legitimacy Gate protocol |
| A2 | Motion's `drag` gesture auto-resumes 1:1 tracking when re-grabbed mid-close-animation (interruptibility, brief §7.4 #9) without extra code | Architecture Patterns, Pattern 2 | Medium — if false, the Sheet could visually "finish closing" before responding to a re-grab, which is a direct UI-06/§7.4 failure; must be verified with a dedicated Playwright test before relying on it, not assumed from Motion's general reputation |
| A3 | Motion's `dragElastic`/`onDragEnd` `info.velocity` unit is px/s (not px/ms or a normalized value) | Common Pitfalls #3, Architecture Patterns Pattern 1 | Medium — if the unit assumption is wrong, the brief's `0.11 px/ms` threshold conversion is wrong by an order of magnitude, and the close/snap-back decision will feel wrong until recalibrated by hand during implementation (recommended mitigation already stated: test empirically, don't hard-code) |
| A4 | `@radix-ui/react-dropdown-menu`'s own close-on-select/`aria-expanded`/focus-return behavior needs no additional wrapping to satisfy UI-04, if chosen | Don't Hand-Roll | Low — Radix's dropdown-menu is a mature, purpose-built menu primitive; the main residual risk is screen-reader-specific phrasing/behavior that must still be checked live at G2 regardless of which primitive is chosen |

**If this table is empty:** N/A — see rows above. All other claims in this research are either `[VERIFIED: Context7]` (the `motion` drag/LazyMotion API shape), `[CITED: docs/ui-build-prompt.md]` (every value pulled directly from the brief), or derived from direct source reads of this repository's own files (`RowMenu.tsx`, `check-ui-safety.mjs`, `tests/e2e/*.spec.ts`, `geometry.ts`, `ADR-0000`), which this research treats as ground truth, not assumption.

## Open Questions

1. **Exact velocity threshold for the Sheet's flick-to-close decision**
   - What we know: the brief specifies `0.11 px/ms` (110 px/s); Motion's `info.velocity` is very likely in px/s based on its own documented `useVelocity` example range.
   - What's unclear: whether Motion's internal velocity sampling (window size, smoothing) produces numbers directly comparable to whatever manual sampling method the brief's number was originally calibrated against.
   - Recommendation: implement with `110` as the starting constant, name it clearly as calibrated-empirically-not-derived, and tune it during the G2/G3 live-hardware review (D-14) rather than treating it as fixed at write time.

2. **Whether Motion's `dragElastic`/`dragTransition` defaults are close enough to the brief's exact formulas to skip a fully custom implementation**
   - What we know: both use a hyperbolic-resistance-style rubber-band and an exponential-decay-style momentum model, conceptually matching brief §7.4.
   - What's unclear: whether the *felt* curve at the brief's specified constants (`0.55` resistance, `0.998` deceleration) is indistinguishable from Motion's own tuned defaults, or whether a custom `useMotionValue` + `animate()` pipeline (bypassing the `drag` prop's built-in physics) is needed to hit the brief's numbers precisely.
   - Recommendation: build with the `drag` prop + built-in physics first (fastest path, Pattern 1), evaluate against the brief's language ("resistencia progresiva, nunca un tope duro"; "no salta al límite más cercano") at G2's live review, and fall back to the custom pipeline only if the built-in feel is judged wrong by the user.

3. **Final choice: fix `RowMenu` in place vs. migrate to `@radix-ui/react-dropdown-menu`**
   - What we know: the in-place fix is three small, well-scoped changes (Pattern 3); the migration gives native WAI-ARIA menu semantics but is a new dependency requiring ADR-0000 + provenance updates and a full behavioral re-verification.
   - What's unclear: whether `AccountMenu`'s own requirements (D-05's richer content — header, link, inline theme control, destructive-adjacent sign-out) are easier to build on `react-dropdown-menu`'s richer primitive (`Item`, `Separator`, `Label`, `Sub`) than on a second hand-rolled non-modal `Dialog`.
   - Recommendation: default to the in-place `RowMenu` fix (lower risk, smaller diff, builds on already-working Radix behavior) and share that same primitive with `AccountMenu`; only migrate if `AccountMenu`'s composition (header row + link + inline control + destructive item) proves awkward on the hand-rolled foundation during actual implementation.

4. **Exact inspector column width within 360–400px, account-menu width, avatar size**
   - What we know: CONTEXT.md leaves these to discretion, bounded only by the 360–400px inspector range.
   - What's unclear: no measured constraint pins an exact number yet.
   - Recommendation: pick round, 8px-grid-aligned values (e.g., 384px inspector column, matching `packages/ui`'s existing 480px `Sheet` width scaled down proportionally) and confirm visually at G2/G3 rather than deriving them analytically.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | Playwright fixture stack (`tests/e2e/fixtures/stack.ts`), baseline/approval captures | ✓ (used successfully by Phase 7's `pnpm brand:review`) | — | — |
| Playwright / Chromium | All E2E, baseline captures, live/slow-motion animation review support | ✓ (already a devDependency, chromium installed per 07-04-SUMMARY.md) | `1.63.0` (per ADR-0000) | — |
| `motion` npm package | Sheet drag-to-dismiss | ✓ on registry (`13.4.1` confirmed present) | `13.4.1` (pinned, D19) | — |
| `@radix-ui/react-dropdown-menu` | Only if RowMenu migration path chosen | ✓ on registry | `2.1.24` | Fallback IS the default path (fix in place, Pattern 3) if this is not installed |
| Real screen reader (VoiceOver/NVDA) | UI-04/success-criterion-1's "verificado con un lector de pantalla real" | Human-only, cannot be automated | — | None — must be performed live by the user at G2, same class of gap `07-CONTEXT.md`/STATE.md already records for v0.1's `RowMenu` (never tested with a real screen reader before) |
| Real touch hardware (iPad/phone on LAN) | D-14's live drag/momentum review | Human-only, conditional ("si hay iPad/teléfono en la LAN") | — | Desktop pointer-drag simulation is an accepted, explicitly-named fallback (§7.10: "el simulador es aceptable pero inferior") |

**Missing dependencies with no fallback:**
- None that block automated execution. The two human-only items (real screen reader, real touch hardware) are explicitly gated as live human-verification steps (D-14, success criterion 1), not automated test dependencies — their absence at plan-writing time does not block planning, only the G2/G3 gate's *closure*.

**Missing dependencies with fallback:**
- Real touch hardware — desktop pointer-drag simulation, explicitly sanctioned by the brief itself.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (jsdom `dom` project for `packages/ui` component tests, per ADR-0005) + Playwright (`tests/e2e/*.spec.ts`) |
| Config file | `vitest.config.ts` (root, `dom` project), `playwright.config.ts` |
| Quick run command | `pnpm exec vitest run <changed-test-file>` (per-component iteration, ADR-0005's own documented pattern) |
| Full suite command | `pnpm test` (unit, all projects) + `pnpm test:e2e` (Playwright) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UI-03 | `Sheet`/`Dialog`/`RowMenu` get `--shadow-floating`; nothing else does | static gate | `pnpm check:ui-safety` (extended gate) | ❌ Wave 0 — extend `scripts/check-ui-safety.mjs` |
| UI-03 | Dark-mode surface step is measurably lighter, still passes AA | unit | `pnpm exec vitest run packages/ui/src/contrast.test.ts` | ✅ exists, extend cases |
| UI-04 | `RowMenu` closes on select, keeps stable keys | unit (jsdom, Testing Library) | `pnpm exec vitest run packages/ui/src/RowMenu.test.tsx` | ✅ exists, add RED cases |
| UI-04 | `RowMenu` trigger has `aria-expanded`, visible on touch, real focus/keyboard behavior | E2E | `pnpm test:e2e -- --grep @rowmenu` (or existing `servers-list.spec.ts` RowMenu assertions) | ✅ existing specs touch RowMenu; add cases |
| UI-04 | Real screen-reader announcement | manual-only | N/A — human verification at G2, recorded in `docs/ui/APPROVAL.md`/UAT doc | manual-only, justified: jsdom/Playwright cannot honestly verify real AT behavior (ADR-0005 (c)) |
| UI-05 | Press feedback `scale(0.97)` on every pressable control | unit + E2E (computed style) | `pnpm exec vitest run packages/ui/src/Button.test.tsx` (etc.) + Playwright computed-style assertion | Partial — component unit tests exist per-component, add press-state assertions |
| UI-05 | No animation on keyboard-initiated `Esc`/`Tab`/sidebar-nav | E2E | `pnpm test:e2e -- --grep @keyboard-no-animation` (new tag) | ❌ Wave 0 — new spec/tag needed |
| UI-06 | Full §7.4 drag sequence (rubber-band, momentum, handoff, interruptible) | E2E (Playwright pointer simulation) | `pnpm test:e2e -- --grep @sheet-drag` (new tag, extends `server-sheet.spec.ts`) | ❌ Wave 0 — extend `server-sheet.spec.ts` |
| UI-07 | Scroll-edge toolbar, origin-anchored menus, `Disclosure` grid-rows, 40ms stagger | E2E (computed style / DOM order) + component unit (Disclosure) | `pnpm test:e2e`, `pnpm exec vitest run packages/ui/src/Disclosure.test.tsx` | ✅ Disclosure test exists; add grid-rows assertion |
| UI-08 | Discovery narration + Viewfinder ring tied to real `buildChecklist` state | unit (`discovery-progress.ts`) + E2E (`discovery.spec.ts`) + human (brand-swap test) | `pnpm exec vitest run apps/web/src/lib/discovery-progress.test.ts`, `pnpm test:e2e -- --grep discovery` | ✅ both exist, extend |
| UI-08 | `Fingerprint` component, diff old/new, no color-only signaling | unit (new `Fingerprint.test.tsx`) + E2E (`host-key.spec.ts`) | `pnpm exec vitest run packages/ui/src/Fingerprint.test.tsx`, `pnpm test:e2e -- --grep host-key` | ❌ Wave 0 for the unit test file; E2E spec exists, extend |
| UI-09 | Tabular numerals, text-wrap, browser-surface theming, `@starting-style`, `clip-path` disk meter | unit (`StatTile.test.tsx`) + visual (screenshot review) | `pnpm exec vitest run packages/ui/src/StatTile.test.tsx` | ✅ exists, extend |
| UI-10 | `prefers-reduced-motion`/`-transparency`/`contrast: more` fallbacks; hover gated; ≤3 `backdrop-filter` | unit (media-query mock) + static count (manual/script) | `pnpm exec vitest run packages/ui/src/Sheet.test.tsx` (etc., with `matchMedia` mocked) | Partial — add media-query test cases per component |
| UI-11 | `@inspector` slot present, empty, no placeholder; `NavTree`/`AccountMenu` structurally correct | E2E (`shell.spec.ts` extended) | `pnpm test:e2e -- --grep shell` | ✅ exists, extend per Pitfall 4 |
| UI-12 | Contrast measured both themes; 4 widths; human-approved screenshots; existing E2E green | static (`contrast.ts`) + E2E (viewport matrix) + human gate | `pnpm exec vitest run packages/ui/src/contrast.test.ts`, `pnpm test:e2e`, `pnpm test:e2e:repeat` | ✅ contrast.ts exists; extend for new surfaces |

### Sampling Rate
- **Per task commit:** `pnpm exec vitest run <changed test file>` (component-level TDD cycle per ADR-0005)
- **Per wave merge:** `pnpm test` (full unit) + `pnpm test:e2e` (full Playwright, per Pitfall P16's own "run the full suite after every component-level change" discipline — non-negotiable given the current 104-test baseline)
- **Phase gate:** `pnpm test:e2e:repeat` (nightly 20x) green, per success criterion 5, before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Extend `scripts/check-ui-safety.mjs` with the shadow-outside-allowlist gate (UI-03) — no existing gate covers this
- [ ] New `packages/ui/src/Fingerprint.test.tsx` — covers UI-08/D-10 (component does not exist yet)
- [ ] New `packages/ui/src/AccountMenu.test.tsx` — covers UI-11/D-05
- [ ] New `packages/ui/src/NavTree.test.tsx` — covers UI-11/D-07
- [ ] New `packages/ui/src/InsetGroup.test.tsx` — covers UI-01/D-01/D-02
- [ ] New/extended `tests/e2e/server-sheet.spec.ts` cases for the full §7.4 drag sequence — covers UI-06
- [ ] New E2E tag/spec for "no animation on keyboard-initiated close" — covers UI-05/P14
- [ ] Update `tests/e2e/shell.spec.ts`, `canary-ui.spec.ts`, `brand.spec.ts` for the `AccountMenu` DOM shape replacing `shell-theme-toggle`/`shell-sign-out` — required before merge, not optional (Pitfall 4)
- [ ] `docs/ui/` scaffold (`APPROVAL.md`, `approved/`, `review/`, `tests/unit/ui/approval-record.test.ts`) — covers D-12/D-13/D-15, mirrors `docs/brand/`

## Security Domain

`security_enforcement` is not set in `.planning/config.json` (absent = enabled), but this phase introduces no new authentication, authorization, or data-handling surface — it is a visual/interaction redesign over existing, already-secured screens. The relevant controls are narrow:

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Unchanged — no new auth surface this phase |
| V3 Session Management | No | Unchanged |
| V4 Access Control | No | Unchanged — `AccountMenu`/`RowMenu` are UI affordances over already-authorized actions, not new authorization boundaries |
| V5 Input Validation | No | No new user input surfaces (drag gestures are pointer coordinates, not data entry) |
| V6 Cryptography | No | Unchanged |
| V7 Error Handling / Logging | Yes (narrow) | `Fingerprint` component and baseline/approval screenshots must never render or capture real secrets/credentials — mirrors the exact discipline Phase 7's `07-04-SUMMARY.md` already proved (fresh unauthenticated browser context, empty fields, no hostname/email in captures) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Approved/reviewed screenshots (`docs/ui/approved/`) accidentally capturing a real fixture credential, hostname, or admin email | Information Disclosure | Same mitigation Phase 7 proved: capture from a fresh, unauthenticated browser context before sign-in for any screen with a credential field; manually verify each approved capture (`grep`-style check for known fixture strings) before committing, per `tests/unit/brand/approval-record.test.ts`'s own pattern extended to `docs/ui/` |
| `dangerouslySetInnerHTML` reintroduced by a new component (`Fingerprint`, `AccountMenu`, `NavTree`, `InsetGroup`) | Tampering (XSS) | ADR-0005 (g)'s existing repo-wide prohibition already covers new components; `check-ui-safety.mjs`'s "exactly one reviewed `dangerouslySetInnerHTML` occurrence" gate will fail loudly if violated |
| A new Radix primitive (`@radix-ui/react-dropdown-menu`, if chosen) shipping a malicious/typosquatted package | Supply chain | Package Legitimacy Gate already run this session (`[OK]` via slopcheck); still requires the `checkpoint:human-verify` per the `[ASSUMED]` tag before install |

## Project Constraints (from CLAUDE.md)

- **TDD obligatorio (§2.1):** every behavior-carrying change in `packages/ui`/`apps/web` (RowMenu fix, `AccountMenu`, `NavTree`, `InsetGroup`, `Fingerprint`, Sheet drag) must follow RED → GREEN → REFACTOR, per ADR-0005's colocated Vitest component-test pattern; Playwright owns cross-screen flows, real keyboard/focus, and computed-style/contrast verification.
- **Definition of Done (§2.2):** explicit error handling (no infra failure crashes the app — not directly at risk in this UI-only phase, but any new client-side fetch/SSE consumption inside `AccountMenu`/`NavTree` must still degrade gracefully), no secrets in logs/screenshots, security review when touching AI/secrets/shell (not triggered this phase), CI green, zero TS/lint errors, zero skipped/flaky tests.
- **Seguridad por defecto (§2.3):** no credential/secret ever rendered — directly relevant to the `Fingerprint` component (hashes only, never raw credentials) and to the baseline/approval screenshot pipeline (see Security Domain above).
- **Stack técnico (§3):** TypeScript strict, `noUncheckedIndexedAccess`; Next.js App Router; Tailwind v4 CSS-first `@theme`; Vitest/Playwright/Testcontainers — all already the stack this phase builds on, no deviation needed.
- **Idioma (§7.1):** code, identifiers, commits, UI copy, error messages — English. Planning docs (this file, CONTEXT.md, plans) — Spanish is fine, matching this phase's own CONTEXT.md.
- **Workflow (§7):** feature branch `feat/v0.2-<slug>` if branching is used; Conventional Commits, no Claude/Co-Authored-By trailers in commit messages (note: this constraint is about product commits inside the Noodara repo itself — it does not affect this research response's own attribution rules imposed by the surrounding tool environment).
- **GSD Workflow Enforcement:** all file-changing work for this phase must go through `/gsd:plan-phase` → `/gsd:execute-phase`, not direct edits — this research file itself is written via the sanctioned GSD research step.

## Sources

### Primary (HIGH confidence)
- Context7 `/websites/motion_dev` — `react-drag`, `react-reduce-bundle-size`, `react-use-drag-controls`, `animate`, `vue-use-velocity`, `react-transitions`, `react-animate-presence` topics (drag prop, dragConstraints/dragElastic/dragMomentum/dragTransition, LazyMotion domAnimation vs domMax feature bundles, initial-velocity handoff via `animate()`, `useDragControls`, `onDrag`/`onDragEnd` info object shape)
- `docs/ui-build-prompt.md` — the full brief, read entirely (§0–§11)
- `.planning/phases/08-redise-o-de-la-app/08-CONTEXT.md`, `08-DISCUSSION-LOG.md` — locked decisions and discretion areas
- `.planning/REQUIREMENTS.md` (UI-03…UI-12 exact text), `.planning/ROADMAP.md` (Phase 8 section, D19 in "Decisions carried from research")
- `.planning/research/SUMMARY.md`, `.planning/research/PITFALLS.md` (Pitfalls 13–17), `.planning/research/ARCHITECTURE.md` §8
- `docs/adr/0005-ui-package-and-component-testing.md`, `docs/adr/0000-package-legitimacy-approvals.md`
- Direct source reads: `packages/ui/src/Sheet.tsx`, `packages/ui/src/RowMenu.tsx`, `packages/ui/src/RowMenu.test.tsx`, `scripts/check-ui-safety.mjs`, `scripts/check-package-provenance.mjs`, `packages/ui/src/contrast.ts`, `packages/ui/src/brand/geometry.ts`, `packages/ui/src/brand/Logo.tsx`, `apps/web/src/app/(shell)/layout.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/SignOutButton.tsx`, `tests/e2e/*.spec.ts` (all 15 files, grepped for testids and counts)
- `.planning/phases/07-identidad-y-brand-kit/07-04-SUMMARY.md`, `07-05-SUMMARY.md`, `docs/brand/APPROVAL.md` — capture pipeline and human-gate pattern this phase reuses
- npm registry (`npm view motion`, `npm view @radix-ui/react-dropdown-menu`) and `slopcheck scan --pkg npm <name> --json` — run live this session

### Secondary (MEDIUM confidence)
- Motion's `drag` gesture "interrupts on re-grab" behavior (Pattern 2) — general, well-established knowledge of the Motion/Framer Motion `MotionValue` model, not backed by an explicit Context7 doc passage for this exact combination this session; flagged `[ASSUMED]` (A2) and requires a dedicated test before being trusted.

### Tertiary (LOW confidence)
- None — every claim in this document is either directly cited to a file/tool result or explicitly logged in the Assumptions table above.

## Metadata

**Confidence breakdown:**
- Standard stack (motion): HIGH — Context7-confirmed API shape, registry-confirmed version, matches a pre-locked decision (D19)
- Architecture (RowMenu fix, @inspector slot, shell restructuring): HIGH — derived from direct reads of this repo's own source files, not inference
- Pitfalls: HIGH — five of nine pitfalls are this session's own direct findings from source code (RowMenu gaps, static-gate conflict, E2E testid impact, stale 93-vs-104 count, velocity-unit mismatch); the other four are the project's own pre-existing, well-evidenced `research/PITFALLS.md` entries

**Research date:** 2026-09-23
**Valid until:** 30 days (stable brief/spec; the one fast-moving element, `motion`'s exact patch version, should be re-checked with `npm view motion version` if this research is used more than a few weeks after this date)
