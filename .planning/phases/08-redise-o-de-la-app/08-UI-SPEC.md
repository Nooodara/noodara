---
phase: 8
slug: redise-o-de-la-app
status: draft
shadcn_initialized: false
preset: none
created: 2026-09-23
---

# Phase 8 — UI Design Contract

> Visual and interaction contract for the app-wide redesign (`apps/web` + `packages/ui`). Generated
> by gsd-ui-researcher, verified by gsd-ui-checker. This is **not** a new design system — the
> palette, type scale, spacing grid and radii are locked in `.claude/skills/noodara-ux-apple/SKILL.md`
> and `packages/ui/tokens.css` (Phase 5 + Phase 7 brand). This document is the phase-specific
> extension `docs/ui-build-prompt.md` describes: exact token names, px values, durations/easings and
> copy for the eleven new/changed surfaces this phase ships (`InsetGroup`, shell chrome, `NavTree`,
> `AccountMenu`, floating elevation, `RowMenu` fix, motion contract, authored moments, surface craft,
> a11y fallbacks, breakpoints/testids). Where this document and the skill or the brief conflict, the
> brief (`docs/ui-build-prompt.md`) wins for motion/elevation/craft; the skill wins for palette/type/
> spacing/radii — flag any conflict found during planning instead of silently resolving it.
>
> Locked inputs this document does not reopen: `08-CONTEXT.md` D-01…D-15 (all decisions below cite
> the D-number they implement), `docs/ui-build-prompt.md` §5.2/§6.3/§7.4/§9, and D19 (`motion@13.4.1`,
> `LazyMotion(domMax)`, scoped to `Sheet` only).

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — no shadcn/ui, no `components.json` (unchanged since Phase 5). Hand-built components on Radix primitives. |
| Preset | not applicable |
| Component library | Radix UI primitives (`@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-visually-hidden`, existing approved set per `docs/adr/0000-package-legitimacy-approvals.md`) + `motion@13.4.1` (new this phase, D19, scoped exclusively to `Sheet.tsx`) |
| Icon library | lucide-react, unchanged, `strokeWidth={1.5}`, 16/20px |
| Font | System stack per skill §2.2, unchanged: `-apple-system, "SF Pro Text/Display", "Inter", system-ui` / `"SF Mono", ui-monospace, "JetBrains Mono", "Geist Mono", Menlo, monospace` |

---

## Tokens

Single source of truth: `packages/ui/tokens.css` (values) + `packages/ui/theme.css` (Tailwind v4 `@theme` binding). This phase **verifies** §5.1 of the brief (palette, type roles, spacing, radii, motion durations — all already present and correct in `tokens.css`, no changes) and **adds** exactly the tokens below (§5.2 of the brief). No literal color/size/radius outside this file; every value in this document traces to one of these names.

### §5.1 — verify, do not touch

`--canvas`, `--surface-1/2/3`, `--hairline`, `--hairline-strong`, `--ink`, `--ink-secondary`, `--ink-tertiary`, `--accent`, `--accent-fill`, `--accent-text`, `--accent-soft`, `--on-accent`, `--status-{ok,warn,error,idle}` (+ `-soft`, `-text`), `--status-error-fill`, all eight `--text-*` role tuples, `--space-{1,2,3,4,5,6,8,12}`, `--r-{sm,md,lg,pill}`, `--duration-{micro,panel,sheet}`, `--ease-standard`. These already pass 67/76 audited pairs (`docs/contrast-decision-05.md` §4); the 9 documented `KNOWN_UNRENDERED_OR_DEFERRED_FAILURES` are out of scope for this phase.

### §5.2 — add in this phase (`packages/ui/tokens.css`, both theme blocks where noted)

```css
/* Floating elevation (UI-03) — Sheet, Dialog, RowMenu, AccountMenu only. Never cards/buttons/rows. */
--shadow-floating: 0 8px 30px rgba(0, 0, 0, 0.12);   /* :root (light) */
--shadow-floating: 0 12px 40px rgba(0, 0, 0, 0.50);  /* [data-theme="dark"] */

/* Custom easings (UI-05/06/07) — replace CSS built-ins everywhere. --ease-standard stays an
   alias of --ease-out so no existing call site breaks. */
--ease-out:    cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--ease-standard: var(--ease-out); /* alias, unchanged call sites keep working */

/* Lighter surface step in dark for solid/translucent floating panels (UI-03, resolves the
   "surface-2 vs surface-3" discretion item for Sheet/Dialog specifically — see §5 Floating
   Surfaces below for the full reasoning). RowMenu/AccountMenu already sit on --surface-3
   (already the lightest tier in both themes) and need no new token. */
--surface-elevated: var(--surface-1);  /* :root (light) — unchanged from today's Sheet/Dialog bg */
--surface-elevated: var(--surface-2);  /* [data-theme="dark"] — one step lighter than surface-1 */
```

`packages/ui/theme.css` gains matching `@theme` bindings: `--color-surface-elevated: var(--surface-elevated);` (Tailwind `bg-surface-elevated` utility). `--shadow-floating`, the three `--ease-*` and `SPRING` (below) are **not** bound into `theme.css`'s `@theme` block — they are consumed as raw CSS custom properties (`shadow-[var(--shadow-floating)]`, inline `style`, or JS constants), not as Tailwind utilities, since Tailwind has no `shadow-*`/`ease-*`/spring namespace that maps cleanly onto arbitrary multi-value box-shadows or JS spring configs.

**Spring constants** (`packages/ui/src/motion-tokens.ts`, new file, plain JS/TS — not CSS, since `motion`'s spring API takes numeric config, not a CSS var):

```ts
export const SPRING = {
  default:  { damping: 1.0, response: 0.4 }, // critically damped, no overshoot
  momentum: { damping: 0.8, response: 0.4 }, // only when the gesture itself carried momentum
  drawer:   { damping: 0.8, response: 0.3 }, // Sheet entry
} as const;
```

Used exclusively inside `Sheet.tsx`'s `motion`-driven drag/entry logic (D19). No other component imports this file.

**Browser surfaces** (`::selection`, `caret-color`, `::-webkit-scrollbar`/`scrollbar-color`, `text-underline-offset`) are declared once, globally, in `apps/web/src/app/globals.css`, bound to existing tokens only (`--accent-soft` for selection background, `--ink` for selection/caret foreground, `--surface-2`/`--hairline-strong` for scrollbar track/thumb) — no new token needed, see §Surface Craft below.

---

## Spacing Scale

Unchanged 8px grid (skill §2.3, verified not redeclared):

| Token | Value | Usage in this phase |
|-------|-------|-------|
| `--space-1` | 4px | icon-to-label gaps inside `NavTree`/`AccountMenu` rows |
| `--space-2` | 8px | gap between an `InsetGroup` title and its block (D-01); gap between fingerprint 4-char blocks |
| `--space-3` | 12px | typographic micro-adjustment only, unchanged |
| `--space-4` | 16px | `InsetGroup` block horizontal padding when a row needs it beyond the row's own padding; `AccountMenu` item padding |
| `--space-5` | 20px | unchanged |
| `--space-6` | 24px | gap **between** `InsetGroup` blocks (D-04's "separación entre grupos") |
| `--space-8` | 32px | page content padding, unchanged (`max-w-[1120px] p-8`, D-04) |
| `--space-12` | 48px | unchanged, major section breaks |

Exceptions (unchanged from skill/05-UI-SPEC.md, restated because this phase touches every row height they govern): rows/list items 44px; desktop controls 32–36px; touch targets ≥44px everywhere, including the `NavTree` rail icon buttons and the `AccountMenu` footer trigger.

---

## Typography

Unchanged eight-role scale (skill §2.2). This phase's only typographic decisions are **which existing role** each new element uses — no new size, weight or line-height is introduced:

| Role | Used in this phase for |
|------|------|
| `--text-title` (20/600) | `Dialog` title (centered), `Sheet` title, `AccountMenu` header name |
| `--text-headline` (15/600) | `InsetGroup` row primary values where a row currently uses it (unchanged) |
| `--text-body` (15/400) | `AccountMenu` menu items, `NavTree` leaf labels (expanded) |
| `--text-callout` (13/400, 500 exception) | `NavTree` leaf labels keep the existing 500-weight sidebar exception; `RowMenu`/`AccountMenu` item text |
| `--text-caption` (12/400) | `AccountMenu` header email, discovery step duration labels, `Fingerprint`'s `SHA256:` prefix |
| `--text-label` (11/600 uppercase) | `InsetGroup` group titles (unchanged from `ServerFacts.tsx`'s existing `<h3 className="text-label uppercase text-ink-secondary">`) |
| `--text-mono` (13/400) | `Fingerprint`'s hex blocks — see §Authored Moments for the one exception (blocks render at `--text-body` size, 15px, for the "mono grande" hero treatment the brief calls for; still `--font-mono`, still `tabular` where numeric, prefix stays 12px `--text-caption`-mono) |

No screen in this phase exceeds three simultaneous typographic levels (skill §1) — `InsetGroup` wrapping does not add a fourth.

---

## Color

Unchanged 60/30/10 split (skill §2.1, `docs/contrast-decision-05.md`). This phase adds zero new hues — only the two alias/step additions in §Tokens above (`--surface-elevated`, and reuse of already-existing `--surface-3` for RowMenu/AccountMenu).

| Role | Token(s) | Usage this phase |
|------|-------|-------|
| Dominant (60%) | `--canvas` | Sidebar background (D-03: sidebar fuses with canvas, loses its own `surface-1`/`border-r`) |
| Secondary (30%) | `--surface-1` (`InsetGroup` block bg), `--surface-elevated` (Sheet/Dialog panel bg), `--surface-3` (RowMenu/AccountMenu bg, avatar circle bg, unchanged) | |
| Accent (10%) | `--accent` (focus rings only, unchanged), `--accent-soft` (active `NavTree` leaf bg, unchanged) | See reserved-for list below — **no new accent usage this phase** |
| Destructive | `--status-error-text` | RowMenu "Delete" item text (unchanged from 05-33 fix), never a new destructive surface |

**Accent remains reserved for exactly the same list 05-UI-SPEC.md already fixed** (primary button fill via `--accent-fill`, links via `--accent-text`, focus rings via `--accent`, active `NavTree` leaf bg via `--accent-soft`). This phase adds **zero** new accent usages — the account menu avatar is explicitly monochrome (D-06: `surface-3` + hairline + `ink` initials, never `accent`), the Viewfinder ring animates in `ink` only (D-09), and the `Fingerprint` diff uses `ink` weight 600 only, never color (D-10, §9 #1/#14).

**`Fingerprint` diff — no color, ever:** matching 4-char blocks render `text-ink-secondary font-normal`; differing blocks render `text-ink font-semibold` (weight 600, the one non-400 weight this system permits). This is the literal application of §9 #14 ("el estado nunca se comunica solo por color") to the single highest-stakes screen in the product.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA (unchanged from 05-UI-SPEC.md, phase 8 touches no toolbar copy) | "Save and connect" / "Connect" / "Re-run discovery" |
| `AccountMenu` header | Admin's name (`--text-title`, `--ink`) + email (`--text-caption`, `--ink-secondary`), read-only display, no edit affordance this phase (Phase 9 adds editing) |
| `AccountMenu` item — Settings | "Settings" (link to `/settings`) |
| `AccountMenu` item — Appearance | Label "Appearance" (`--text-body`) + inline `ThemeToggle` control on the same row, cycling "Light" → "Dark" → "System" (unchanged copy from the existing `ThemeToggle`, `MODE_LABEL`) |
| `AccountMenu` item — Sign out | "Sign out" (ghost-styled, unchanged copy from `SignOutButton`) |
| `NavTree` leaves (unchanged labels) | "Servers", "Activity", "Settings" |
| `Fingerprint` — trusted/new labels (`TrustFingerprintDialog`, D-10) | "Trusted" (caption, above the old block) / "New" (caption, above the new block) — never "old" (ambiguous with a stale/bad value), never colored |
| Discovery step duration format (D-09) | `{ms}ms` for &lt;1000ms, `{s.s}s` for ≥1000ms (e.g. `340ms`, `2.1s`), always `tabular-nums`, always `--text-caption` `--text-mono` |
| Inspector empty contract (D-08, this phase ships only the empty slot) | No visible copy in v0.2 — `default.tsx` returns `null`; the slot renders no placeholder text, no "coming soon" (§9 #19). Phase 13 owns the first real inspector copy. |
| `InsetGroup` empty state (servers list, D-02) | Unchanged from 05-UI-SPEC.md: "No servers yet" / "Connect your first Ubuntu server to let Noodara discover it." + "Add server" — now rendered **inside** the single inset block instead of as a bare page-level empty state. |
| Destructive confirmation (unchanged) | "Delete server" / "Trust new fingerprint", type-the-exact-name pattern, unchanged from 05-UI-SPEC.md §5.7 |

All copy: English, sentence case, no exclamation marks (§9 #20, skill §6) — this phase introduces no new error codes or destructive actions, only new chrome/menu copy, all listed above.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|--------------|
| shadcn official | none — shadcn is not used | not applicable |
| third-party component registries | none declared this phase | not applicable — no registry vetting triggered |

This phase's one new npm dependency, `motion@13.4.1` (D19, pinned), is **not** a shadcn registry block — it goes through the standard `scripts/check-package-provenance.mjs` + `docs/adr/0000-package-legitimacy-approvals.md` gate per `08-RESEARCH.md`'s Package Legitimacy Audit (already run: `[OK]`, `[VERIFIED: Context7 + npm registry]`). If the planner chooses to migrate `RowMenu` to `@radix-ui/react-dropdown-menu` instead of the recommended in-place fix (see §RowMenu below), that package requires the same gate before install (`[ASSUMED]` provenance tag per `08-RESEARCH.md` — needs a `checkpoint:human-verify`).

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending

---

## 1. `InsetGroup` (UI-11 layout, D-01/D-02/D-04)

**New component:** `packages/ui/src/InsetGroup.tsx`, consumed by `LabelValue`/`ListRow`/`EmptyState` children.

**Structure** (macOS System Settings / iOS grouped list, per D-01):
- Group title: `<h3 className="text-label uppercase text-ink-secondary">` — **unchanged markup and role** from today's `ServerFacts.tsx` (`text-label`, 11px/600/uppercase/`+0.04em`, `--ink-secondary`), rendered **outside** the block, `--space-2` (8px) above the block.
- Block: `bg-surface-1`, `border border-hairline`, `rounded-lg` (`--r-lg`, 16px), **no shadow** (§9 #2, this is elevation-step not floating), **no nesting** — an `InsetGroup` never contains another `InsetGroup`.
- Rows inside: separated by `border-b border-hairline` on every row except the last (internal divider, not a block border); each row keeps its existing height/padding contract (44px for list rows per D-02, unchanged `LabelValue` row padding for label/value groups per D-04 — "layout intacto salvo lo que los grupos exigen").
- Between two consecutive `InsetGroup` blocks on the same screen: `--space-6` (24px) vertical gap (D-04).

**Applied to** (D-01, exact scope — no other screen gets this treatment this phase):
1. Server detail (`/servers/:id`): the three existing label/value groups (`System`, `Docker`, `Connection` in `ServerFacts.tsx`) each become one `InsetGroup`.
2. Settings (`/settings`): `Instance` and `Advanced` each become one `InsetGroup` (the `Advanced` group's existing `Disclosure` collapse/expand behavior is preserved — the `InsetGroup` wraps the disclosed content, it does not replace the disclosure).
3. Servers list (`/servers`): the entire list becomes **one** `InsetGroup` (D-02) — 44px rows inside, hairline row separators, the row stays a native `<Link>` (unchanged), `RowMenu` sits at the row's right edge (unchanged position), and the empty state (`EmptyState`: "No servers yet" / body / "Add server" button) renders **inside** this same block rather than replacing the toolbar-level empty state.

**Not applied to:** Activity log (rows already have day-header grouping and no natural single-block shape), stat tile row (unchanged four-tile grid), any Sheet/Dialog body content.

---

## 2. Shell (UI-11, D-03/D-08)

### 2.1 Sidebar fuses with canvas (D-03)

`Sidebar.tsx` (or its `NavTree`-based replacement, see §3) loses `bg-surface-1` and `border-r border-hairline` entirely — background becomes `bg-canvas` (same token as the page), separation comes from spacing and the `InsetGroup` blocks' own hairline borders in the content column, never a sidebar edge. The mobile bottom-sheet variant (&lt;900px) **keeps** `bg-surface-1` + `border-t` — it is a temporary overlay sheet, not permanent chrome, and needs its own surface to read as a sheet over the content behind it.

### 2.2 Toolbar scroll-edge effect replaces `border-b` (D-03, brief §5.3/§7.7)

`Toolbar.tsx` drops its permanent `border-b border-hairline`. Replacement: a `hairline`-colored 1px pseudo-border that fades in via `opacity` transition (200ms `--ease-out`) driven by a `scroll`-position class toggle on the scrollable content ancestor (`main`/the page's own scroll container) — `border-b border-transparent` at scroll-top, `border-b border-hairline` (or an equivalent bottom-edge gradient mask) once `scrollTop > 0`. Implementation detail (CSS `@supports` for `animation-timeline: scroll()` vs. a small `IntersectionObserver`-driven class toggle) is left to the executor; the **contract** is: no visible 1px line when the page is scrolled to the very top, a visible 1px line the instant content passes under the toolbar. The toolbar keeps its existing `bg-surface-1/90 backdrop-blur` translucent treatment (this is the **one permanent `backdrop-filter`** on the page, per D-03 and §Floating Surfaces below).

### 2.3 Three-column conditional layout with `@inspector` slot (D-08)

`apps/web/src/app/(shell)/layout.tsx` gains a Next.js parallel-route slot:

```
apps/web/src/app/(shell)/
├── layout.tsx           # + `inspector` prop from the @inspector slot
└── @inspector/
    └── default.tsx      # returns null — zero width, zero border when empty
```

- `≥1280px`: inspector renders as a **fixed right column, 384px wide** (8px-grid-aligned, inside the 360–400px range CONTEXT.md left to discretion; chosen because it is exactly half of `Sheet`'s existing 480px width, keeping the two panel widths visually related), narrowing `main`'s available width. Zero border/shadow on the column itself when it has content this phase does not populate — content and its own chrome are Phase 13's responsibility.
- `<1280px`: inspector presents as a lateral `Sheet` instead of a column (reusing the existing `Sheet` component, D-08's "sin scrim" caveat below still applies — see §5.4/§7.7 note that a non-blocking parallel panel never gets a scrim, unlike the destructive-confirmation Dialog).
- `default.tsx` returns `null` unconditionally — when nothing is passed, the slot reserves **zero width and draws zero border**, verified by the Playwright test in `08-RESEARCH.md`'s Pattern 4 (`shell-inspector-slot` testid, `boundingBox().width === 0`).
- This phase ships the slot, the breakpoint-driven column-vs-sheet presentation logic, and its test — **not** any inspector content (Phase 13's scope, per Deferred Ideas).

---

## 3. `NavTree` (UI-11, D-07)

**New component:** `packages/ui/src/NavTree.tsx`, replacing the flat `<ul>` inside `Sidebar.tsx`.

- **Data shape:** `NavTreeItem { id, label, href, icon, children?: readonly NavTreeItem[] }` — generic, no `Project`/`Environment`/`Service` types imported (D-07 explicitly: generic today, Phase 13 only passes data).
- **Today's data:** exactly three flat leaves, no children — `Servers` (`Server` icon), `Activity` (`History` icon), `Settings` (`Settings` icon). Renders **visually identical** to today's flat list at every breakpoint.
- **Expand/collapse** (for when a future leaf gains children): `grid-template-rows: 0fr → 1fr` transition (same technique as `Disclosure`, 200ms `--ease-out`), `aria-expanded` on the parent's own toggle control, expansion state held per-item (not global).
- **Rail behavior (900–1279px, 64px icon rail):** a leaf with children collapses to a hover/focus-triggered tooltip or flyout listing its children (not exercised by today's flat data, but the component must support it structurally without a v0.2 rewrite).
- **No animation on navigation itself** (D-07, §6.1: "la navegación del sidebar no se anima" — clicking a leaf and routing to it has zero transition beyond the browser's own navigation; only the *expand/collapse disclosure* of a parent item animates, never the act of navigating to a leaf).
- **No section labels, no disabled items** (§9 #8/#19) — a leaf with no destination is never rendered at all, not rendered disabled.

---

## 4. `AccountMenu` (UI-11, D-05/D-06)

**New component:** `packages/ui/src/AccountMenu.tsx`, mounted at the sidebar's foot, replacing the current `ThemeToggle` + `SignOutButton` cluster in `Sidebar.tsx`.

### 4.1 Trigger

- Expanded sidebar (`≥900px`): avatar (28px circle) + admin name (`--text-callout`, 500 weight — the sidebar-label exception) + no chevron needed (a hover/press affordance is enough; do not add a decorative chevron icon per anti-slop §4.3's icon discipline).
- Rail (`900–1279px`, 64px): avatar only, 32px circle, centered in the same 44px-tall footer row the expanded trigger occupies.
- Below `900px` (bottom-sheet nav): same as expanded trigger, inside the sheet.
- Trigger row height: 44px (touch target, matches `NavTree` leaf height).
- **Accessible name (all breakpoints):** the trigger is a `<button>` with `aria-label="Account menu"` (added to `data-testid="shell-account-menu-trigger"`); in rail mode the avatar is icon-only, so the label is the *only* accessible name — the initials are `aria-hidden`. Announced as "Account menu, button, collapsed/expanded" via `aria-haspopup="menu"` + `aria-expanded`. Same pattern as `NavTree`'s rail icons (tooltip-based accessible name), verified with VoiceOver at G2.

### 4.2 Menu content

Floating menu, **288px wide** (8px-grid-aligned; wider than `RowMenu`'s 160px min-width to fit the header row), `bg-surface-3` (solid, unchanged surface tier already used by `RowMenu`), `rounded-md`, `border border-hairline`, `--shadow-floating` (see §Floating Surfaces).

Structure, top to bottom:
1. Header row (non-interactive): avatar (28px) + name (`--text-title`, `--ink`) + email (`--text-caption`, `--ink-secondary`), padding `--space-4` (16px).
2. `border-t border-hairline` divider.
3. "Settings" — link item, navigates to `/settings`, closes menu on click (same close-on-select fix as `RowMenu`, see §6).
4. "Appearance" — a **non-navigating** row containing the label "Appearance" and the existing `ThemeToggle` control **inline on the same row** (D-05: the control *is* `ThemeToggle` or calls its one write path, `STORAGE_KEY = 'noodara-theme'` — never a second writer, pitfall P17). Clicking the `ThemeToggle` control itself does **not** close the menu (cycling the theme is a repeatable action within one visit, matching the existing standalone `ThemeToggle`'s own behavior); clicking anywhere else in the row is a no-op (the row's own click target is the control, not the whole row).
5. `border-t border-hairline` divider.
6. "Sign out" — ghost-styled item (unchanged copy/behavior from `SignOutButton`), closes menu and navigates to `/login` on completion.

### 4.3 Avatar (D-06)

`Avatar` sub-component (or inline in `AccountMenu`): circle, `bg-surface-3`, `border border-hairline`, initials (first letter of first + last name token, uppercase) in `--ink`, role `label` (`--text-label` sizing scaled to fit the circle — 11px base role, rendered at the circle's own font-size via the component, not a new type role). **Zero blue** — never `--accent`/`--accent-fill` (§9 #1, D-06, Fase 7 D-09's in-app monochrome-mark precedent). No image upload this phase (Deferred Ideas).

### 4.4 Shared primitive with `RowMenu` (D-05's explicit ask)

`AccountMenu` and `RowMenu` (§6 below) both consume a new shared hook, `packages/ui/src/use-floating-menu.ts`, extracted from `RowMenu`'s existing `DialogPrimitive.Root modal={false}` foundation: open state, arrow-key roving focus (`ArrowUp`/`ArrowDown`/`Home`/`End`, lifted verbatim from `RowMenu.tsx`'s `handleContentKeyDown`), close-on-select, and the keyboard-vs-pointer close-source tracking described in §6.2. `AccountMenu`'s own `.tsx` file owns only its unique content (header row, Appearance row's inline control) — no second hand-rolled dismiss/focus implementation.

### 4.5 E2E impact (Pitfall 4 — must ship in the same plan)

`tests/e2e/shell.spec.ts`, `tests/e2e/canary-ui.spec.ts`, `tests/e2e/brand.spec.ts` currently assert `getByTestId('shell-theme-toggle')`/`getByTestId('shell-sign-out')` directly. The plan that ships `AccountMenu` **must** rewrite these three specs in the same plan (open the account menu trigger first, then assert the theme control/sign-out item inside it) — see §Breakpoints & Testids below for the exact new ids.

---

## 5. Floating Surfaces (UI-03)

### 5.1 Elevation

`--shadow-floating` applies to exactly four components: `Sheet`, `Dialog`, `RowMenu`, `AccountMenu` (the last two share the same shadow level per D-05's "mismo nivel que RowMenu"). **No other component ever receives a shadow** — cards, buttons, rows, `InsetGroup` blocks, `StatTile`, `Banner`/`Notice` all stay shadow-free (§9 #2).

### 5.2 Surface step lighter in dark

| Component | Light bg | Dark bg | Rationale |
|---|---|---|---|
| `Sheet` panel | `bg-surface-elevated/72` = `surface-1/72` (unchanged) | `bg-surface-elevated/72` = `surface-2/72` (was `surface-1/72`) | New `--surface-elevated` alias token (§Tokens); one step lighter in dark only, light unchanged |
| `Dialog` panel | `bg-surface-elevated` = `surface-1` (unchanged) | `bg-surface-elevated` = `surface-2` (was `surface-1`) | Same alias, solid (no translucency — Dialog is a modal, scrim-backed, per §7.7) |
| `RowMenu` content | `bg-surface-3` (unchanged) | `bg-surface-3` (unchanged) | Already the lightest surface tier in both themes — already satisfies "lighter step in dark" without a new token |
| `AccountMenu` content | `bg-surface-3` (new component, matches RowMenu) | `bg-surface-3` (new component, matches RowMenu) | Same reasoning as RowMenu |

Contrast verification obligation (Pitfall 13/P13): the plan that introduces `--surface-elevated` must add `ink`/`ink-secondary`-on-`surface-elevated` pairs to `contrast.ts`'s generalized audit loop for both themes, in the same plan. Provisional numbers already on record in `docs/contrast-decision-05.md` §1.1 (`--ink`/`--surface-2` dark = 14.05:1, `--ink-secondary`/`--surface-2` dark = 5.94:1) indicate no new failures are expected, but this must be re-verified against the actual `--surface-elevated` alias, not assumed.

### 5.3 `backdrop-filter` budget (UI-10)

Current, unchanged-by-this-phase state: only the **toolbar** (`backdrop-blur`) and **Sheet** (`backdrop-blur-xl backdrop-saturate-[1.8]`) use `backdrop-filter` at all. `Dialog`, `RowMenu`, `Tooltip` are **already solid** (`bg-surface-1`/`bg-surface-3`, no blur class) — confirmed by direct source read of `Dialog.tsx`/`Tooltip.tsx`/`RowMenu.tsx`. `AccountMenu` (new) follows `RowMenu`'s solid precedent.

**Resolution:** worst case is toolbar (1, permanent) + Sheet (1, conditional, only while open) = **2 simultaneous `backdrop-filter` instances**, safely under the "never more than three" budget (UI-10 success criterion 4) without any component needing to change its material this phase. `RowMenu`/`Tooltip`/`AccountMenu` staying solid is not a new decision this phase makes to fit a budget — it is the codebase's existing, correct state, restated here so no plan "fixes" something that was never broken.

---

## 6. `RowMenu` (UI-04)

### 6.1 Decision: fix in place, do not migrate

Per `08-RESEARCH.md`'s Pattern 3/Open Question 3 recommendation: keep `DialogPrimitive.Root modal={false}` (Esc-close, outside-click-close and close→trigger-focus-return already work "for free" from Radix). Three targeted fixes, all in `packages/ui/src/RowMenu.tsx` (extracted partly into the shared `use-floating-menu.ts` hook, §4.4):

1. **Close on select.** `RowMenuProps` gains no new prop — the component lifts `open`/`setOpen` internally (`useState`, was implicitly uncontrolled) and every `item.onSelect()` call is wrapped to also call `setOpen(false)`.
2. **`aria-expanded={open}`** added to `DialogPrimitive.Trigger` (today only `aria-haspopup="menu"` is present).
3. **Stable keys.** `key={item.label}` → `key={item.id ?? index}`; `RowMenuItem` gains an optional `id?: string`.

Migration to `@radix-ui/react-dropdown-menu` remains available as a fallback only if `AccountMenu`'s richer composition (header + link + inline control + destructive-adjacent item) proves awkward on the hand-rolled foundation during implementation — not the default path.

### 6.2 Keyboard-vs-pointer close-animation suppression (P14, resolves the static-gate conflict)

**Mechanism (must not touch `onEscapeKeyDown`/`onInteractOutside` — those Radix props stay untouched, per the existing `check-ui-safety.mjs` gate):** the shared `use-floating-menu` hook attaches its own **capture-phase** native listeners (`keydown` for `Escape`, `pointerdown` for outside clicks) on `document`, separate from and in addition to Radix's own dismiss handling. These listeners run *before* Radix's own (capture phase fires first) and set a `closeSourceRef.current = 'keyboard' | 'pointer'` ref — they never call `preventDefault()` or `stopPropagation()`, so Radix's own dismissal still fires normally afterward. The component's exit-transition logic reads `closeSourceRef.current` at the moment `onOpenChange(false)` fires: `'keyboard'` → apply an instant, non-animated unmount (skip the `scale(0.97)+opacity` exit class entirely); `'pointer'` or unset (e.g. programmatic close-on-select) → the normal 150ms `--ease-out` scale-from-trigger exit. This same mechanism is reused by `Sheet`/`Dialog` for their own `Esc`-vs-drag/click distinction (UI-05's "ninguna acción iniciada por teclado se anima").

### 6.3 Verification

UI-04's screen-reader requirement ("verificado con un lector de pantalla real") is a G2 human-verification item (manual-only, per `08-RESEARCH.md`'s Validation Architecture) — recorded in `docs/ui/APPROVAL.md`/the phase's human-UAT doc, not an automated test.

---

## 7. Motion Contract (UI-05/06/07)

### 7.1 Press feedback

Every pressable control (`Button`, `ListRow`, `RowMenu`/`AccountMenu` items, `CopyButton`, `FileButton`, `SegmentedControl`, `NavTree` leaves) gets:

```css
transition: transform 160ms var(--ease-out);
&:active { transform: scale(0.97); }
```

### 7.2 Durations/easings table (brief §6.3, verbatim — replaces every CSS built-in easing in the inventory)

| Interaction | Technique | Value |
|---|---|---|
| Press | `scale(0.97)` on `:active` | 160ms `--ease-out` |
| Sidebar/`NavTree` navigation | none | — (D-07, §6.1) |
| `StatusPill` state change | color + bg transition | 150ms `--ease-out` |
| `CONNECTING` pulse | opacity loop, `motion-safe:` only | — |
| `Sheet` entry | translateX + spring | `SPRING.drawer` |
| `Sheet` exit (button, not drag) | translateX, same path as entry | 200ms `--ease-drawer` |
| `Sheet` drag-to-dismiss | tracking 1:1 → projection → velocity handoff | see §7.4 below |
| `Dialog` (confirm/destructive/trust) | `scale(0.95)+opacity 0` → `scale(1)+opacity 1`, origin **center** | 200ms `--ease-out` |
| `RowMenu`/`AccountMenu` open | `scale(0.97)+opacity`, origin **trigger** | 150ms `--ease-out` |
| `Tooltip` | 125ms; instant on repeat hover within one hover session | `--ease-out` |
| `Disclosure` (Advanced settings, discovery step raw checks) | `grid-template-rows: 0fr → 1fr` | 200ms `--ease-out` |
| Discovery check arrival / list row first-load entry | `translateY(4px)+opacity`, 40ms stagger | 200ms per item |
| Skeleton → content | crossfade + `filter: blur(2px)` bridge | 200ms |
| Banner entry | `translateY(-4px)+opacity` | 200ms `--ease-out` |
| Theme change | color transition, never a brightness jump | 200ms |
| SSE stream indicator | color only | 150ms |

Hard ceiling: 300ms for any UI transition (brief §6.2). `ease-in` is never used (§9 #9). `transition: all` is never used — every transition names its properties explicitly.

### 7.3 `Sheet` drag-to-dismiss (UI-06, D19, brief §7.4)

Scoped **exclusively** to `packages/ui/src/Sheet.tsx`, wrapped in `<LazyMotion features={domMax} strict>` — `strict` mode makes any accidental `motion.*` usage elsewhere in the tree throw at runtime, enforcing D19's "motion nowhere else" rule mechanically, not by convention.

```tsx
import { LazyMotion, m } from 'motion/react';
const loadFeatures = () => import('./motion-features.js').then((res) => res.default); // exports domMax

<LazyMotion features={loadFeatures} strict>
  <m.div
    drag="x"
    dragConstraints={{ left: 0, right: 0 }}
    dragElastic={0.15}      // starting point approximating brief's rubberband(constant=0.55) — verify felt curve, don't assume formula equivalence
    dragMomentum
    onDragEnd={(event, info) => { /* velocity-sign decision, see below */ }}
  />
</LazyMotion>
```

- `domMax` (not `domAnimation`) is required — `domAnimation` excludes drag/pan entirely.
- Velocity threshold: start at **110 px/s** (brief's `0.11 px/ms`, assuming Motion's `info.velocity` is px/s per its own `useVelocity` docs) — tag this constant with a comment naming it "calibrated empirically, not derived" and tune during G2/G3 live review (D-14), never treat it as fixed at write time.
- Rubber-banding, momentum projection and handoff-of-velocity (steps 5–8 of brief §7.4) are Motion's `dragElastic`/`dragMomentum`/`onDragEnd`'s `info.velocity` internals — verify the *rendered* curve with a component/E2E test (does the panel visibly resist past the edge with progressive resistance, does a fast short flick close regardless of distance), not Motion's private implementation.
- Interruptibility (step 9): re-grabbing mid-close must resume 1:1 tracking from the panel's current on-screen position — tagged `[ASSUMED]` in research (A2), requires a dedicated Playwright test (grab mid-flight, assert tracking from current position) before relying on it.
- Keyboard-initiated close (`Esc`) uses the §6.2 mechanism — **no** `motion` animation, instant unmount.
- Entry/manual-close-by-button keep their existing CSS-transition treatment (`SPRING.drawer` for entry, 200ms `--ease-drawer` for the close-button path) — only the **drag** gesture itself is `motion`-driven.

### 7.4 Origin anchoring, scroll-edge, disclosure, stagger (UI-07)

- `RowMenu`/`AccountMenu`/`Tooltip`: `transform-origin` anchored to the trigger element (`var(--transform-origin)` pattern).
- `Dialog`: always centered, never trigger-anchored (brief §6.4, modals are the stated exception).
- Toolbar: scroll-edge effect per §2.2 above.
- `Disclosure` (`NavTree` expand, Settings "Advanced", discovery step raw checks): `grid-template-rows: 0fr → 1fr`, never height animation (§9 #11 — animating layout-triggering properties is a hard prohibition; `grid-template-rows` avoids this because the browser can interpolate the fractional unit without triggering the three-pass layout/paint/composite cost of animating `height` directly).
- Discovery checks + servers-list first-load rows: 40ms stagger, `translateY(4px)+opacity`, never blocking interaction while the stagger plays (§9 forbids blocking input during any transition).

---

## 8. Authored Moments (UI-08)

### 8.1 Discovery timeline + Viewfinder ring (D-09)

**Timeline thread:** a 1px vertical `bg-hairline` line runs the full height of the six-step list, positioned behind the step markers. A second, overlaid `bg-ink` line of the same geometry fills progressively as steps complete, implemented as `transform: scaleY(completedFraction)` with `transform-origin: top` on a fixed-height inner element (never an animated `height`, per §9 #11) — `completedFraction = completedSteps / 6`, sourced from the exact same `buildChecklist`/`summarize` counts `DiscoverySection.tsx` already computes (never a second progress calculation, D-09's "nunca inventa progreso"). Transition: 200ms `--ease-out` per step completion.

**Per-step duration:** `tabular-nums`, `--text-caption` `--text-mono`, format per §Copywriting Contract (`{ms}ms` / `{s.s}s`).

**Viewfinder ring** (the aperture ring of the monogram, `[data-part="aperture"]` in `packages/ui/src/brand/geometry.ts` — the hook Phase 7 built specifically for this): animates from open/blurred to sharp/closed as discovery steps complete, driven by an inline CSS custom property, `--aperture-progress` (0 → 1, one increment per completed step, identical source as the timeline fill above — one progress computation feeding both the thread and the ring). Visual mapping:

```css
[data-part="aperture"] {
  transition: r 200ms var(--ease-out), filter 200ms var(--ease-out);
  filter: blur(calc((1 - var(--aperture-progress)) * 3px));
  /* r itself can also step down slightly toward the "closed" reading — exact geometry values
     are the executor's to derive from geometry.ts's existing aperture radius constant, not a
     new coordinate invented here (per geometry.ts's own "no coordinate outside the named
     constants" discipline). */
}
```

- Ties to the **real** run: if a run fails or is partial, the ring stops exactly where the run stopped — never completes by decoration (D-09, brief §8.4's "no inventa progreso" restated for the mark specifically).
- `prefers-reduced-motion`: replace the interpolated `r`/`filter` transition with a two-state opacity crossfade (blurred-open visible until 100% complete, then an instant, non-animated swap to sharp-closed) — no trajectory.
- Used identically (D-11) on `/login`/`/setup`: the mark focuses once on load, no loop, same technique, `--aperture-progress` driven by a one-shot mount animation instead of discovery state.

### 8.2 `Fingerprint` component (D-10)

**New component:** `packages/ui/src/Fingerprint.tsx`. Single implementation, three call sites: `FirstTrustNotice`, `ServerFacts` (Connection group's fingerprint row), `TrustFingerprintDialog` (old/new diff).

- Parses `"SHA256:<hex>"` into: prefix `SHA256:` rendered `--text-caption` `--font-mono`, `--ink-tertiary` (dimmed); hash body split into 4-character blocks separated by a literal space, rendered at `--text-body` size (15px) `--font-mono`, `--ink` — the "mono grande" hero treatment the brief calls for (larger than the system's default 13px `--text-mono` role, still monospace, still a declared role combination not an ad hoc size).
- `CopyButton` (existing component, reused) copies the full unblocked string.
- **Diff mode** (`TrustFingerprintDialog` only): two `Fingerprint` instances stacked, labeled "Trusted" / "New" (`--text-caption`, `--ink-secondary`, above each block per §Copywriting). Blocks are compared pairwise; a differing block renders `font-weight: 600` (`--ink`, full strength) instead of the matching-block default `font-weight: 400` (`--ink-secondary`) — **never a color change** (§9 #14, D-10). No randomart ASCII (Deferred Ideas, §9 #7).

### 8.3 One discrete moment per screen (D-11)

| Screen | The one authored moment |
|---|---|
| `/login`, `/setup` | Monogram focuses once on load (§8.1's technique, one-shot, no loop) |
| `/servers` | Row stagger on first load + `StatusPill` color/bg transition on state change |
| `/servers/:id` | Discovery timeline + Viewfinder ring (§8.1) |
| `/activity` | New rows entering via SSE animate `translateY+opacity`, scroll/content preserved (existing merge-not-reset contract, unchanged) |
| `/settings` | The "Advanced" `Disclosure`'s `grid-template-rows` expand/collapse — its only movement |

Never the same entry animation reused across sections (brief §8.4).

---

## 9. Surface Craft (UI-09)

All declared globally in `apps/web/src/app/globals.css`, bound to existing tokens — no new color/size token required:

```css
::selection { background: var(--accent-soft); color: var(--ink); }
:root, [data-theme="dark"] { caret-color: var(--accent); }
* { font-variant-numeric: tabular-nums; } /* opt-out per element where a non-numeric mono string would misalign — Fingerprint's hex blocks WANT this, activity prose sentences do not */
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background: var(--hairline-strong); border-radius: var(--r-pill); }
::-webkit-scrollbar-track { background: transparent; }
* { scrollbar-color: var(--hairline-strong) transparent; }
a { text-underline-offset: 2px; }
```

- `text-wrap: balance` on headings (`--text-display`/`--text-title`/`--text-headline` roles when used as a heading element); `text-wrap: pretty` on body copy (`EmptyState`, `Banner`, `Notice`, `Dialog` body).
- Measure: 65–75ch cap on `EmptyState` body text, `Banner`/`Notice` message text, `Dialog` body text (`max-width: 70ch` as the single implementation value, mid-range of the 65–75 spec).
- Skeleton → content blur bridge: `filter: blur(2px)` during the 200ms crossfade (servers list, server detail — unchanged targets from 05-UI-SPEC.md, now with the blur added).
- `@starting-style` replaces any remaining `useEffect`+`mounted`-state entrance pattern.
- Disk meter (`StatTile`): reveal via `clip-path: inset(0 100% 0 0)` → `inset(0 0 0 0)` (unchanged target, this phase implements the technique).

---

## 10. Accessibility Fallbacks (UI-10)

```css
@media (prefers-reduced-motion: reduce) {
  /* Every transition in §7.2's table collapses to a short opacity-only crossfade, no
     translate/scale/spring, no overshoot. Applies to: press feedback (opacity dim instead of
     scale), Sheet entry/exit (opacity only, drag-to-dismiss falls back to a simple close button
     tap target with no gesture at all — motion's drag prop itself respects prefers-reduced-motion
     for its own spring physics per Motion's documented behavior), RowMenu/AccountMenu/Tooltip/
     Dialog open, Disclosure (instant, no grid-template-rows interpolation), discovery/list
     stagger (instant, no per-item delay), Viewfinder ring (crossfade per §8.1). */
}
@media (prefers-reduced-transparency: reduce) {
  /* Toolbar: bg-surface-1 solid, backdrop-filter: none. Sheet: bg-surface-elevated solid (drop
     the /72 opacity and backdrop-blur entirely). Dialog/RowMenu/AccountMenu: already solid,
     unaffected. */
}
@media (prefers-contrast: more) {
  /* Toolbar/Sheet: border-hairline-strong instead of border-hairline, background pushed toward
     fully opaque surface-elevated. Dialog/RowMenu/AccountMenu: border-hairline-strong. InsetGroup
     blocks: border-hairline-strong. */
}
```

- Hover gating: every `:hover` style in the redesigned surfaces (`RowMenu`/`AccountMenu` trigger reveal, `NavTree` leaf hover, `ListRow` hover) is wrapped in `@media (hover: hover) and (pointer: fine)` so a tap on touch never triggers a stuck hover state.
- `backdrop-filter` budget: covered in §5.3 above (max 2 simultaneous, toolbar + Sheet).

---

## 11. Breakpoints & Review Matrix (UI-12)

### 11.1 Matrix

375 / 900 / 1280 / 1920 px × light/dark, for all six screens (`/setup`, `/login`, `/servers`, `/servers/:id`, `/activity`, `/settings`) plus overlay captures (`Sheet` open, `Dialog` open, `RowMenu` open, `AccountMenu` open). Fixture states per D-12: connected server with full discovery, one server in error, a list entry with an 80-character name, an empty list. Capture pipeline reuses `scripts/brand/capture-brand-review.ts`'s shape (Phase 7 precedent) — see `08-RESEARCH.md` Pattern 7.

Contrast: ≥4.5:1 body text, ≥3:1 large text and any border that is a control's sole visible boundary — measured via `contrast.ts`'s generalized token-loop, extended to cover `--surface-elevated` and any newly-rendered pair this phase introduces (`AccountMenu` header text, `InsetGroup` title-outside-block spacing does not change any pair already audited).

### 11.2 `data-testid` contract — stable (must not change)

Per `05-UI-SPEC.md` §9 and the E2E suite (104 tests, 15 specs — corrected count from `08-RESEARCH.md`, not the stale "93" in `research/PITFALLS.md`): `shell-sidebar`, `shell-toolbar`, `shell-menu-button`, `shell-sidebar-scrim`, `servers-add-button`, `servers-row`, `server-sheet-credential-type`, `server-sheet-save-connect`, `server-detail-primary-action`, `discovery-summary`, `discovery-step-{stepId}`, `discovery-check-{checkId}`, `activity-row`, `activity-load-older`, `brand-monogram`, `brand-lockup`. None of these are renamed by this phase's work.

### 11.3 `data-testid` contract — new / changed (must ship in the same plan as the component)

| Old id | New id(s) | Owning component | Specs to update |
|---|---|---|---|
| `shell-theme-toggle` | `shell-account-menu-trigger` (opens the menu) + `shell-account-menu-theme-toggle` (the `ThemeToggle` control inside) | `AccountMenu` | `shell.spec.ts`, `canary-ui.spec.ts`, `brand.spec.ts` |
| `shell-sign-out` | `shell-account-menu-trigger` (open first) + `shell-account-menu-sign-out` | `AccountMenu` | `shell.spec.ts`, `canary-ui.spec.ts` |
| n/a (new) | `shell-inspector-slot` | `@inspector` slot | new assertion, `shell.spec.ts` |
| n/a (new) | `shell-account-menu-settings-link` | `AccountMenu` | new assertion if the plan adds one |
| n/a (new) | `nav-tree-item-{id}` (e.g. `nav-tree-item-servers`) | `NavTree` | replaces any bare link-role selector currently used for sidebar items, if a spec relies on DOM structure rather than accessible name |

The plan that ships `AccountMenu` must update `shell.spec.ts`, `canary-ui.spec.ts`, and `brand.spec.ts` in the same commit (Pitfall 4/16 discipline) — not as a follow-up. `pnpm test:e2e` runs after every `packages/ui` component-level change per `08-RESEARCH.md`'s Sampling Rate; `pnpm test:e2e:repeat` (nightly 20×) must be green before the phase's `/gsd:verify-work`.

---

## 12. Human Gates (D-13, cross-references only — full checklist lives in `08-HUMAN-UAT.md`)

- **G1** (baseline, D-12): before any CSS change, six screens + overlays captured at all four widths, both themes, real fixture data. Blocks everything else.
- **G2** (after P0 + `InsetGroup` + shell): floating elevation, `RowMenu` fixed, a11y fallbacks, `AccountMenu`, `NavTree`, `@inspector` slot. Includes real screen-reader verification (UI-04) and live drag-feel review (D-14) at this point only for whatever is already built. Blocks P1/P2 motion investment.
- **G3** (final, P1/P2 + authored moments): Sheet drag-to-dismiss, Viewfinder ring, `Fingerprint` diff, full motion table, tested live in the running app per D-14 (real hardware for touch drag if available on the LAN, DevTools Animations slow-motion for everything else).

Approval recorded in `docs/ui/APPROVAL.md` (mirrors `docs/brand/APPROVAL.md`'s exact table shape: date, gate, approver, rounds used, notes), approved 1280px captures committed to `docs/ui/approved/`, all other widths/rounds in gitignored `docs/ui/review/`, pinned by `tests/unit/ui/approval-record.test.ts` (forbids AI-attribution strings under `docs/ui/`, same pattern as `tests/unit/brand/approval-record.test.ts`).
