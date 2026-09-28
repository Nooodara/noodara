---
phase: 10
slug: sitio-de-docs-y-landing-publica
status: draft
shadcn_initialized: false
preset: none
created: 2026-09-27
---

# Phase 10 — UI Design Contract

> Visual and interaction contract for `apps/site` (landing `/` + Fumadocs docs `/docs`). Generated
> by gsd-ui-researcher from CONTEXT.md D-01..D-18 (locked) and the existing `packages/ui` design
> system. Verified by gsd-ui-checker against the same six dimensions as every other phase, plus
> D-17's screenshot allowlist and D-10's forbidden-words rule.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — this repo does not use shadcn anywhere; the design system is the hand-built `packages/ui` token set (`tokens.css`, `theme.css`, `aperture.css`) consumed by `apps/web` and now `apps/site`. No `components.json` exists and none is introduced by this phase (would create a second, un-audited component system alongside the token-governed one — rejected). |
| Preset | not applicable |
| Component library | None (Radix/Base UI not used). `apps/site` imports the same primitives `apps/web` already built on `packages/ui` where useful (e.g. a `CopyButton`-style component for the install command per D-01); Fumadocs UI ships its own React components (`RootProvider`, sidebar, TOC, search dialog) which are re-skinned via CSS variable mapping (§Fumadocs Re-skin below), not replaced. |
| Icon library | None — the brief prohibits third-party icon glyphs and emoji (ui-build-prompt.md §9 #6/#7). The one diagram this phase needs (D-05 "How it works") is a hand-drawn SVG in `currentColor` using brand-kit geometry (`packages/ui/src/brand/geometry.ts` construction primitives), not an icon set. |
| Font | System stack only, identical to the app: `--font-sans` (`-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif`), `--font-display` for the two ≥20px roles, `--font-mono` (`'SF Mono', ui-monospace, ...`) for the install command, exit codes, error codes and every code block. Zero downloaded fonts (D-16). |

**shadcn gate outcome:** No `components.json` found; stack is Next.js but the project already has a mature, locked design system predating this phase (Phases 7-9) that explicitly forbids introducing a parallel component system. Per the non-interactive scope note, decision recorded: **do not initialize shadcn**. `apps/site` consumes `@noodara/ui` tokens/brand assets directly and Fumadocs UI's own components, re-skinned.

---

## Spacing Scale

Reusing the locked token scale from `packages/ui/tokens.css` verbatim — `apps/site` imports this file, never redeclares spacing.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Icon-to-label gaps, inline chip padding |
| `--space-2` | 8px | Compact element spacing, pill padding |
| `--space-3` | 12px | Typographic micro-adjustments (reserved) |
| `--space-4` | 16px | Default element spacing, card padding |
| `--space-5` | 20px | (reserved, typographic) |
| `--space-6` | 24px | Section-internal padding, hero button gap |
| `--space-8` | 32px | Landing section vertical rhythm (mobile) |
| `--space-12` | 48px | Landing section vertical rhythm (desktop), major breaks |

Exceptions for this phase:
- Landing section-to-section gap on desktop (≥1280px) uses **96px** (`--space-12 * 2`, expressed as a one-off `--site-section-gap-lg` local var, not a new global token) — sections in D-01..D-06 need more breathing room than the app's own 48px max because there is no persistent chrome (sidebar/toolbar) competing for vertical space. Declared once in `apps/site/app/global.css`, never a literal elsewhere.
- Sidebar/TOC internal item padding in the Fumadocs docs layout follows Fumadocs' own spacing defaults (already 4/8/16px-aligned) rather than being rewritten — verify at implementation time that it doesn't introduce off-grid values; if it does, override with `--space-2`/`--space-4`.

---

## Typography

Reusing the locked type roles from `packages/ui/tokens.css`. Landing and docs pick from this exact set — no new sizes.

| Role | Size | Weight | Line Height | Where used this phase |
|------|------|--------|-------------|------------------------|
| Display | 28px | 600 | 1.14 | Hero headline ("Your infrastructure, understood.") |
| Title | 20px | 600 | 1.2 | Section headings (pillars, "How it works", docs page H1) |
| Headline | 15px | 600 | 1.33 | Pillar card titles, docs H2/H3, sidebar group labels |
| Body | 15px | 400 | 1.47 | All prose — landing copy, docs body, measure capped at 65-75ch (ui-build-prompt.md UI-09) |
| Mono | 13px | 400 | 1.5 | Install command, exit code table, error code table, all inline code and code blocks |

Weights used: **400 and 600 only** (matches the app-wide two-weight rule; no 500, no 700, anywhere in `apps/site`).

Heading measure and body measure both respect the 65-75ch rule already required app-wide (UI-09) — Fumadocs' default prose width is checked against this at implementation time and clamped with a `max-inline-size` if it ships wider.

---

## Color

Reusing `packages/ui/tokens.css` exactly — `:root` (light) / `[data-theme="dark"]` (dark), no new hex literals anywhere in `apps/site`.

| Role | Token | Usage |
|------|-------|-------|
| Dominant (60%) | `--canvas` | Page background (landing sections, docs content pane) |
| Secondary (30%) | `--surface-1` / `--surface-2` | Docs sidebar, code block background, screenshot card frame, footer band |
| Accent (10%) | `--accent` / `--accent-fill` | Reserved for: primary CTA button ("Read the docs"), inline text links, the one hero focus-animation stroke, active sidebar item indicator, search dialog focus ring. Never used for section backgrounds, decorative shapes, or the "How it works" diagram strokes (those stay `currentColor`/`--ink`). |
| Destructive | `--status-error` / `--status-error-fill` | Not used on the public site — there are no destructive actions in `apps/site` (no forms, no data mutation). Declared here only for completeness/consistency with the template; omit from implementation. |

Fumadocs `--color-fd-*` variable mapping (Claude's Discretion per CONTEXT.md, decided here):

| Fumadocs variable | Maps to |
|---|---|
| `--color-fd-background` | `var(--canvas)` |
| `--color-fd-foreground` | `var(--ink)` |
| `--color-fd-muted-foreground` | `var(--ink-secondary)` |
| `--color-fd-card` | `var(--surface-1)` |
| `--color-fd-card-foreground` | `var(--ink)` |
| `--color-fd-popover` | `var(--surface-2)` |
| `--color-fd-border` | `var(--hairline)` |
| `--color-fd-primary` | `var(--accent-fill)` |
| `--color-fd-primary-foreground` | `var(--on-accent)` |
| `--color-fd-secondary` | `var(--surface-2)` |
| `--color-fd-accent` | `var(--surface-3)` (Fumadocs "accent" = hover/active row background, NOT Noodara's brand accent — do not map to `--accent`, this would violate "one accent color" by turning every hovered sidebar row blue) |
| `--color-fd-ring` | `var(--accent)` (focus ring only) |

Enumerate the remaining `--color-fd-*` variables against `fumadocs-ui/css/neutral.css`'s actual list at implementation time and map every one — none may be left at Fumadocs' own default palette (SITE-03 "mismo piso de calidad").

---

## Copywriting Contract

All copy in English (CLAUDE.md §7.1), sentence case, no exclamation marks, present-tense facts only (D-03/D-10: no "coming soon", "soon", "roadmap", no dates — enforced by a Vitest scan test).

| Element | Copy |
|---------|------|
| Hero headline | "Your infrastructure, understood." (locked wordmark tagline, D-01) |
| Hero subline | One factual sentence on what Noodara is today, e.g. "Connect a server over SSH, watch Noodara discover it, and see exactly what's running — no agent, no black box." |
| Primary CTA | "Read the docs" → `/docs` |
| Secondary CTA | "View on GitHub" → repo URL |
| Install command label | none needed — the command itself is the content; a `CopyButton`-style control has an accessible name "Copy install command" |
| Pillar 1 heading | "Connect" |
| Pillar 1 body | One sentence describing SSH connect + fingerprint trust, no more |
| Pillar 2 heading | "Discover" |
| Pillar 2 body | One sentence describing step-by-step discovery |
| Pillar 3 heading | "Understand" |
| Pillar 3 body | One sentence describing activity log + settings/themes |
| Positioning line | "Most panels manage your servers. Noodara helps you understand them." (D-04, wording adjustable, intent locked) |
| "What it does not do yet" heading | "What it does not do yet" (D-03, verbatim) |
| Scope block body | Factual bullet list in present tense, e.g. "Noodara does not manage domains or TLS. Put configuration in the image." Link: "See full scope" → `/docs/reference/scope` |
| Footer links | "Docs" · "GitHub" · license identifier from `LICENSE` (build-time read, never hand-typed) · version (build-time read from tag/`package.json`, never hand-typed) |
| 404 heading | "Page not found" |
| 404 body | "This page doesn't exist. Head back to the docs or the homepage." with links to `/docs` and `/` |
| Docs "Scope of this release" page | Table "Included / Not included", present tense, no dates (D-10) |
| Forbidden vocabulary (enforced by test) | `coming soon`, `soon`, `roadmap`, any literal year/month date pattern — none may appear anywhere in `apps/site/content/**` |
| Destructive confirmation | Not applicable — `apps/site` has no destructive actions (static, read-only, no forms) |

---

## Component Inventory (site-specific)

Since there is no shadcn registry, list the concrete pieces this phase builds or reuses so planner/executor share one inventory.

| Component | Source | Notes |
|---|---|---|
| `Hero` | New, `apps/site` | Wordmark lockup (`packages/ui/brand/lockup-{light,dark}.svg`), headline, subline, install command block, `<picture>` screenshot (servers-{light,dark}.png), one-shot Viewfinder focus animation (D-18, reusing `packages/ui/src/brand/geometry.ts`) |
| `InstallCommand` | New, `apps/site` | Mono text, copy button, exact string match with `install.sh`/README (tested) |
| `PillarCard` | New, `apps/site` | Heading + body + `<picture>` screenshot, hairline border, `--r-lg` radius, no shadow (matches app-wide "no shadow on cards" rule) |
| `HowItWorksDiagram` | New, `apps/site` | Hand-drawn SVG, `currentColor` strokes, 3 steps, brand-kit geometry — no third-party icons |
| `ScopeBlock` | New, `apps/site` | "What it does not do yet" list + link to `/docs/reference/scope` |
| `SiteHeader` | New, `apps/site` | Wordmark, nav (Docs/GitHub), theme toggle (localStorage-only variant of `ThemeToggle`) |
| `SiteFooter` | New, `apps/site` | Docs/GitHub links, license, version |
| `ScreenshotFrame` | New, `apps/site` | `<picture>` wrapper: hairline border, `--r-lg` radius, no window chrome, no shadow (D-17) |
| `CodeBlock` | Fumadocs UI, re-skinned | System mono font, copy button, `--surface-2` background, `--hairline` border |
| Docs sidebar / TOC / search dialog | Fumadocs UI, re-skinned | CSS-variable mapped per §Color above; must key off `[data-theme="dark"]` not a bare `.dark` class (verify per RESEARCH.md Pitfall 5) |
| `Callout` (docs admonitions) | Fumadocs UI, re-skinned | Maps to `--status-*-soft`/`--status-*-text` tokens only for genuinely semantic notes (e.g. a warning callout on the install page uses `--status-warn-*`, not decoration) |

---

## Layout Contract

| Property | Value |
|---|---|
| Landing max width | 1120px content column, centered, with `--space-6` (24px) side padding on mobile scaling to `--space-8` (32px) at ≥900px |
| Docs content max width | Fumadocs default reading column, clamped to 75ch prose measure per app-wide rule |
| Section vertical rhythm | `--space-8` (32px) mobile → 96px desktop (see Spacing exceptions) between major landing sections |
| Wordmark size in hero | Lockup height 32px mobile, 40px at ≥900px — same proportions as the app sidebar lockup, never redrawn |
| Screenshot presentation | `<picture>` with light/dark source per D-17, hairline border (`1px solid var(--hairline)`), `--r-lg` (16px) radius, no window chrome, no drop shadow (app-wide "no shadow on cards" rule extends here) |
| Code block style | `--font-mono`, `--surface-2` background, `--hairline` border, `--r-md` (10px) radius, copy button top-right, no line numbers unless a doc page genuinely needs them (install script excerpts do not) |
| Breakpoints | 375 / 900 / 1280 / 1920 — same four widths the app-wide DoD requires (ui-build-prompt.md §10), tested for landing and at least one representative docs page |
| Header | Sticky, hairline bottom border only (no shadow), wordmark + Docs/GitHub links + theme toggle; scroll-edge effect reused from the app toolbar pattern (UI-07) rather than a permanent border, for visual consistency — optional refinement, permanent hairline is an acceptable fallback if scroll-edge adds scope |

---

## Motion Contract

Per D-18 and ui-build-prompt.md §9's hard prohibitions:

| Rule | Value |
|---|---|
| Hero focus animation | One-shot, on load only, using `packages/ui/src/brand/geometry.ts`'s Viewfinder aperture (same primitive as `/login`, Phase 8 D-11) |
| Everything else | Hover/focus only, subtle (`scale`/opacity transitions on `--duration-micro`/`--ease-out`, matching the app's press/hover contract) — no scroll-triggered animation, no parallax |
| `prefers-reduced-motion` | Hero animation replaced by a static or crossfade reveal of the final aperture state — never removed silently, an intentional fallback (per Definition of Done: "if removing it loses nothing, it was decoration") |
| Forbidden | Gradients, glow, decorative blur, spinners, `scale(0)` entrances, `ease-in`, `transition: all`, animation on keyboard-initiated actions (n/a here — no interactive forms) |

---

## Accessibility Contract

| Requirement | Value |
|---|---|
| Contrast | ≥4.5:1 body text, ≥3:1 large text and borders that are the sole visible boundary of a control — measured (not estimated) in both themes, reusing the same measurement discipline as `packages/ui/src/contrast.test.ts` |
| Focus ring | Visible on every interactive element (links, copy button, theme toggle, search trigger, nav items) — `--accent` outline, same treatment as the app |
| Keyboard | Full keyboard nav through header, hero CTAs, docs sidebar, search dialog, footer; tab order = visual order |
| Reduced transparency / high contrast | If any `backdrop-filter` is used (e.g. sticky header), it must have a `prefers-reduced-transparency` fallback per the app-wide rule; cap at ≤3 simultaneous `backdrop-filter` instances (unlikely to be reached on this simpler surface, but the rule still applies) |
| Screen reader | Copy button announces its action and result ("Copied"); theme toggle announces state; 404 page has a proper heading hierarchy |

---

## SEO / Metadata Contract

| Property | Value |
|---|---|
| `metadataBase` | `https://noodara.com` |
| OG image | Self-hosted, 1200×630, Phase 7 brand asset (`packages/ui/brand/og-image.png` or equivalent) — no third-party OG generator |
| `sitemap.xml` / `robots.txt` | Generated at build (`force-static`), per D-14 |
| Canonical URLs | Always `https://noodara.com/...`, independent of the basePath computed for the non-CNAME preview build |
| Third-party requests | Zero — no Google Fonts, no analytics, no star-count API calls (D-06, D-14) |

---

## Registry Safety

Not applicable — no shadcn registry is used in this project (see Design System section). No third-party component blocks are pulled from any registry. Fumadocs UI and its dependencies are vetted through the existing `scripts/check-package-provenance.mjs` gate (not the shadcn registry vetting flow), consistent with how `motion` was vetted in Phase 8.

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable |
| third-party | none | not applicable |

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
