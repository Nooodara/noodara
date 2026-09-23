# UX Review — Phase 7 brand surfaces (sidebar rail, expanded sidebar, /login, /setup)

Date: 2026-09-22 · Commit: `51e3a05` · Reviewer: executor agent (`noodara-ux-review` skill, audited
against `noodara-ux-apple`) · Mode: **screenshots + code**

**Global verdict: PASS**

Scope: the four surfaces BRAND-02 puts the approved mark on, and only those. Two files changed —
`apps/web/src/components/Sidebar.tsx` (the brand slot above the nav list) and
`apps/web/src/components/AuthCard.tsx` (the lockup above the heading). The mark itself
(`packages/ui/src/brand/{Logo,Lockup}.tsx`) was audited in 07-03 and is unchanged here; this review
covers how it is mounted, sized, coloured and announced.

Screenshots are the eight freshly captured in-app surfaces in `docs/brand/approved/`, produced by
`pnpm brand:review --mounted --concept c` from the real running stack with the real components —
not the review-time DOM injection the earlier captures used. Four were opened and read directly
(`sidebar-rail-light.png`, `sidebar-rail-dark.png`, `login-light.png`, `setup-dark.png`, plus the
expanded-sidebar dark crop from `docs/brand/review/c/`).

---

## Verdicts by dimension

| Dimension | Verdict | Evidence |
|---|---|---|
| 1. Tokens | PASS | The mark inherits its colour from `text-ink` on the wrapper and paints with `currentColor` — `Sidebar.tsx:37-38` (`BRAND_RAIL_CLASSES`/`BRAND_EXPANDED_CLASSES`, both ending in `text-ink`), `AuthCard.tsx:22`. No colour value is passed to either component: `grep -cE "color=\|text-accent\|fill=" apps/web/src/components/Sidebar.tsx apps/web/src/components/AuthCard.tsx` prints 0 for both, and the mounted SVG's own `fill` is asserted to be exactly `currentColor` in `Sidebar.test.tsx` ("renders the monogram as an svg painted with currentColor") and `AuthCard.test.tsx`. No hex, no `rgb(`, no gradient anywhere — `pnpm check:ui-safety` exits 0 on all nine repo-wide gates. D-09 holds: the single action colour is untouched by the brand, and in `login-light.png` the only blue on screen is still the Sign in button. |
| 2. Surface and elevation | PASS | The brand slot adds no surface of its own: both wrappers are bare flex rows with no background, no border, no radius and no shadow (`Sidebar.tsx:37-38`, `AuthCard.tsx:22` — `flex items-center text-ink`). The sidebar's own `--surface-1` panel and hairline right border are unchanged (`Sidebar.tsx:59-63`), and the auth card keeps its single `rounded-lg`/`bg-surface-1` box (`AuthCard.tsx:21`). Visible in `sidebar-rail-dark.png`: the mark sits directly on the sidebar surface with no plate behind it. |
| 3. Typography and hierarchy | PASS | No typographic level was added. The word "noodara" in the lockup is drawn geometry, not text (`packages/ui/src/brand/Lockup.tsx` renders `<path>` elements only), so the auth card still has exactly one heading level plus labels and body — `login-light.png` reads mark → `Sign in` (`--text-title`, weight 600, `AuthCard.tsx:25`) → field labels → button, three levels, unchanged from before the mark. The lockup at `height={22}` sits just under the `--text-title` cap height, so it reads as chrome above the heading rather than competing with it. |
| 4. Layout and spacing | PASS | `h-11` (44px) is the sidebar's own item height (`ITEM_CLASSES`, `Sidebar.tsx:22-23`), and `px-3` is the same horizontal inset every nav item uses, so the monogram lands on the nav icons' own optical axis — visible in `sidebar-rail-light.png`, where the mark's centre sits directly above the Servers icon's centre in the 64px rail. `mb-3` (12px) is not a new number: `p-3`, `pt-3` and `gap-3` are already this file's established step (`Sidebar.tsx:59-63`, `:92`), and it separates brand from navigation by more than the 4px `gap-1` between nav items, which is the intent. The rail measures exactly 64px with the mark in it, asserted against the real browser in `tests/e2e/brand.spec.ts` ("the 64px rail shows the monogram and hides the lockup at 1024px"). On the auth card the mark takes the card's existing `gap-5` and adds no padding of its own (`AuthCard.tsx:21-24`). |
| 5. Components | PASS | Both mount points compose `packages/ui`'s own `Logo`/`Lockup` rather than re-drawing anything (`Sidebar.tsx:14`, `:67`, `:70`; `AuthCard.tsx:2`, `:23`), and neither passes a `concept` or a `color` — the approved concept comes from `DEFAULT_CONCEPT` (`docs/brand/APPROVAL.md`), so a future adjustment round is a constant edit, never a call-site edit. The test ids are supplied by the caller (`brand-monogram`, `brand-lockup`), matching how `ThemeToggle` is given `shell-theme-toggle` two lines below. The mark is deliberately not a link or a button in v0.2 — asserted in `Sidebar.test.tsx` ("does not make the mark a link or a control"), which also pins the sidebar at exactly three links. |
| 6. States (empty/loading/error) | PASS (nothing to regress) | The mark has no state: it renders identically whatever the page below it is doing, and it is outside every data-driven region. `sidebar-rail-light.png` and `sidebar-rail-dark.png` show it above the untouched "No servers yet" empty state (title + one sentence + one action, no illustration). No skeleton, no spinner and no banner changed — `pnpm check:ui-safety`'s `animate-spin`/`spinner` gate is still 0. |
| 7. Progressive disclosure | PASS | The mark adds zero depth: it is chrome, always present at ≥900px, never a disclosure target. It is deliberately absent from the below-900px bottom sheet, where the only job is navigation and vertical space is scarce (`Sidebar.tsx:29-36` states this; proven in `tests/e2e/brand.spec.ts`, "the below-900px bottom sheet carries no mark, closed or open"). The rail keeps showing the monogram alone and the expanded sidebar the full lockup, so the amount of brand shown scales with the space available (D-04). |
| 8. Copy | PASS | No user-facing string was added. The one new piece of text in the DOM is the SVG's accessible name, `Noodara` — the product name, exactly as spelled everywhere else, with no tagline, no exclamation and no marketing sentence (`Sidebar.tsx:67`, `:70`; `AuthCard.tsx:23`). Every existing string on the two auth screens is byte-identical, which is why `tests/e2e/auth.spec.ts`'s verbatim copy assertions still pass. |
| 9. Accessibility and themes | PASS | **Named:** the rail shows no brand text at all, so the mark must carry its own name — `title="Noodara"` makes each SVG `role="img"` with that accessible name (`Sidebar.test.tsx` "names both marks Noodara as images", `AuthCard.test.tsx` "names the lockup Noodara as an image"). **Never announced twice:** the breakpoint switch is `display:none`, so exactly one of the two marks is in the accessibility tree at any width — `tests/e2e/brand.spec.ts` asserts `getByRole('img', { name: 'Noodara' })` has count 1 on `/login` and `/setup`, and the expanded/rail tests assert the other one is hidden. **Both themes:** proven by computed colour, not by eye alone — the same spec reads the rendered `color` in light and dark and asserts they differ, on both `/login` and the rail, which is the direct proof that `currentColor` follows the theme with one asset. The pair is `--ink` on `--surface-1`, the system's primary text pair and its highest-contrast one, so no new contrast measurement is at risk. **Keyboard:** the wrappers are plain `div`s with no `tabindex` and no `href`, so the focus order is untouched — re-verified in a real browser, `tests/e2e/shell.spec.ts --grep @shell`, 9/9 passing, including "pressing Tab from page load moves through the skip link, the three sidebar items, the theme toggle, then sign out". **No secret on screen:** every captured field is empty, including `/setup`'s Token (`setup-dark.png`), and the authenticated shots show the empty-state screen with no hostname and no account email. |

---

## Blockers

None. No non-negotiable rule was broken: no second accent, no decorative gradient, no shadow on a
card or button, no inline hex, no state conveyed by colour alone, no missing theme, no visible
secret.

## Suggested corrections

None required for release. Two items were considered and deliberately left as they are:

1. **The rail monogram is 24px while the nav icons are 20px.** This is intentional, not a drift
   from the skill's 16/20px icon scale: the mark is the product's identity, not a member of the
   icon family, and at 20px the Viewfinder's centre ring loses its counter. The 4px difference is
   what makes the mark read as a brand rather than a fourth nav item, and the capture
   (`sidebar-rail-light.png`) shows the two still sharing one optical axis.
2. **No tooltip on the rail mark.** Every nav item has one because every nav item is a control.
   The mark is not interactive in v0.2 (Phase 8 decides whether it becomes a link home), so a
   tooltip would advertise an affordance that does not exist. Its accessible name covers the
   screen-reader case.

## What works well

- **One asset, two themes, zero branching.** There is no light/dark brand variant, no theme
  conditional and no second file — the mark inherits `--ink` through `currentColor`, and that is
  now proven by a computed-colour assertion in a real browser rather than by convention.
- **The breakpoint story is honest at every width.** Full lockup where there is room, monogram
  alone in the rail, nothing at all in the bottom sheet — and each of the three is asserted, not
  assumed.
- **Nothing existing moved.** The diff is an extended import, two named class constants and one
  five-line block in `Sidebar.tsx`, plus one wrapper in `AuthCard.tsx`. Every test id the E2E suite
  depends on is intact, and `@shell`, `@auth` and `@setup` (26 tests) were re-run against the real
  stack after the mount, all passing.
- **The call sites hold no brand knowledge.** No concept id, no colour, no geometry — the approval
  record drives what gets drawn, so a future adjustment round never touches `apps/web`.

## Needs human review

A screenshot at 2× on a headless Chromium settles layout and colour, not craft. These still want a
person in front of a real display:

1. The monogram's optical weight at 24px in the rail on a non-retina screen — whether the counter
   inside the ring stays open.
2. Whether the lockup above `Sign in` feels like the right size relative to the heading, or wants
   a point more or less.
3. The 12px gap between the mark and the first nav item at both sidebar widths, judged by eye.
4. The mark on a real browser tab as a favicon — still uncapturable by Playwright, and still
   07-09's own check.
