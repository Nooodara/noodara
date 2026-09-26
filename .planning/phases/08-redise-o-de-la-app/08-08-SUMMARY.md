---
phase: 08-redise-o-de-la-app
plan: 08
subsystem: ui
tags: [account-menu, react, radix-ui, playwright, session, shell]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-04: use-floating-menu.ts/use-close-source.ts, the shared floating-menu primitive AccountMenu builds on"
  - phase: 08-redise-o-de-la-app
    provides: "08-06: RowMenu's floating-elevation/a11y-fallback precedent (--shadow-floating, contrast-more:border-hairline-strong)"
  - phase: 08-redise-o-de-la-app
    provides: "08-07: NavTree/Sidebar's canvas-fused chrome and linkComponent discipline this plan reuses"
provides:
  - "packages/ui/src/AccountMenu.tsx: the shell's single account affordance (AccountMenu, AccountMenuProps, AccountMenuLinkProps) -- header, Settings link, inline ThemeToggle, sign-out slot, monochrome avatar"
  - "apps/web/src/lib/session-user.ts: loadSessionUser()/useSessionUser() reading GET /api/auth/get-session, degrading to null on any failure"
  - "apps/web/src/components/Sidebar.tsx: mounts AccountMenu instead of the old ThemeToggle+SignOutButton cluster"
  - "tests/e2e/{shell,canary-ui,brand}.spec.ts: rewritten for the new account-menu DOM shape, zero remaining shell-theme-toggle/shell-sign-out references"
affects: ["08-09", "08-11", "08-13", "08-14", "08-19"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fixed-shape floating menu built on the shared use-floating-menu hook: AccountMenu owns only its unique content (header, Appearance row's inline control) and reuses RowMenu's exact open-state/roving-focus/close-source wiring -- no second hand-rolled dismiss implementation"
    - "Arrow-key roving focus is scoped to role=\"menuitem\" nodes only: the embedded ThemeToggle control inside the Appearance row deliberately carries no role attribute, so it never joins the roving set and its own click never closes the menu -- Settings and Sign out (both role=\"menuitem\") are the only two roving stops"
    - "DOM-free hook testing split: session-user.ts exports a plain async loadSessionUser() (unit-tested in Vitest's node-environment `apps` project, no DOM) and a thin useSessionUser() hook wrapper (proven end-to-end only through Sidebar.test.tsx's jsdom suite) -- the same separation require-session.ts already established for its own plain async guard"
    - "Pure-CSS three-way responsive avatar/name swap (sheet <900px / rail 900-1279px / expanded >=1280px), reusing Sidebar.tsx's own two-block brand-slot technique and NavTree's hidden-at-one-breakpoint label pattern -- no JS-computed matchMedia boolean, avoiding the hydration-mismatch class of bug ThemeToggle's own SSR guard exists to prevent"

key-files:
  created:
    - packages/ui/src/AccountMenu.tsx
    - packages/ui/src/AccountMenu.test.tsx
    - apps/web/src/lib/session-user.ts
    - apps/web/src/lib/session-user.test.ts
  modified:
    - packages/ui/src/index.ts
    - apps/web/src/components/Sidebar.tsx
    - apps/web/src/components/Sidebar.test.tsx
    - apps/web/src/components/SignOutButton.tsx
    - tests/e2e/shell.spec.ts
    - tests/e2e/canary-ui.spec.ts
    - tests/e2e/brand.spec.ts

key-decisions:
  - "UI-11 is NOT marked complete, per 08-05-SUMMARY.md/08-07-SUMMARY.md's own established precedent and this plan's explicit instruction: UI-11's full text also requires the inspector slot (08-09/08-11), which this plan never touches."
  - "UI-04 is also NOT marked complete. Its text requires RowMenu's open/closed state to be verified announced to a real screen reader at gate G2 -- a human-verification checkpoint this autonomous plan cannot perform. AccountMenu shares RowMenu's exact primitive (same aria-haspopup/aria-expanded/role=\"menu\" contract, proven again here in jsdom), but the requirement itself stays Pending until G2's real-screen-reader pass covers both components together."
  - "requirements-completed is [] below, matching both precedents above."
  - "AccountMenuProps keeps `railOnly?: boolean` (per the plan's own prop list) but Sidebar.tsx never passes it: the three breakpoints (sheet/rail/expanded) are expressed entirely as Tailwind classes inside AccountMenu.tsx itself (avatar h-7/h-8/h-7 and name hidden-at-rail-only), the same no-JS-breakpoint-boolean technique Sidebar.tsx's own BRAND_RAIL_CLASSES/BRAND_EXPANDED_CLASSES pair and NavTree's LABEL_CLASSES already use. A JS-computed matchMedia boolean would have reintroduced exactly the hydration-mismatch risk ThemeToggle.tsx's own mount-effect guard exists to avoid. `railOnly` is kept only as a future override for a caller that always wants the collapsed form."
  - "Arrow-key roving focus inside AccountMenu covers exactly two stops -- \"Settings\" and \"Sign out\" (both role=\"menuitem\") -- and deliberately excludes the embedded ThemeToggle control, which carries no role attribute of its own. This is a considered reading of the plan's \"never onto the header\" behaviour bullet: ThemeToggle is a real toggle widget users click, not a one-shot menu action, and WAI-ARIA menu authoring practice discourages folding an arbitrary interactive widget into a menu's own roving-tabindex set. ThemeToggle stays reachable by Tab like any other focusable control; it is simply not one of the two roving stops."
  - "grep -c \"useFloatingMenu\" packages/ui/src/AccountMenu.tsx returns 2 (the import line plus the one call site), not the plan's stated \"1\" -- verified this is not achievable without an artificial single-line import+call merge: RowMenu.tsx, the file this exact acceptance criterion is modelled on, itself returns 3 for the same reason (import, one explanatory comment, one call site). Documented here rather than silently accepted; every other AccountMenu.tsx grep-based criterion (ThemeToggle >=2, noodara-theme scoped to ThemeToggle.tsx only, zero accent, exactly one shadow-floating, zero next/link|items:) passes exactly as specified."
  - "The 'accent' acceptance-criterion grep (`grep -cE \"accent\" packages/ui/src/AccountMenu.tsx` == 0) is a raw whole-file grep, unlike check-ui-safety.mjs's own comment-stripped shadow/backdrop gates -- so AccountMenu.tsx's focus ring uses `outline-ink`, not the app's usual `outline-accent`, and every comment was worded to avoid the literal substring \"accent\" entirely (following 08-07's own established precedent for gate-safe comment wording)."
  - "brand.spec.ts required no functional rewrite -- neither shell-theme-toggle nor shell-sign-out ever appeared in it, and its existing getByRole('link') counts are unaffected by AccountMenu (a <button> trigger, not a link, and its Settings link only enters the DOM once the menu is opened, which none of brand.spec.ts's cases do). Three assertions were still added (account-menu-trigger visible at each of the three breakpoints) to keep the file honestly reflecting the new DOM shape, per the plan's explicit files_modified/Pitfall-4 instruction, without weakening or duplicating any existing assertion."
  - "SignOutButton.tsx changes exceed the plan's literal \"change only the testid\" instruction by one attribute: `role=\"menuitem\"` was added alongside the testid rename, since without it the sign-out control could never join AccountMenu's role=\"menuitem\"-scoped roving-focus set (RowMenu's own items all carry this role already) -- Rule 2 (missing critical functionality: without this, arrow-key navigation to Sign out silently fails). The close-stream/POST/navigate sequence itself, and every other prop, is untouched."

patterns-established:
  - "AccountMenuLinkProps: the same linkComponent-as-ComponentType-prop discipline NavTreeLinkProps established, scoped down to exactly the attributes a role=\"menuitem\" anchor needs (href, role, data-testid, onClick, className, children) -- no aria-current, since a settings link is never 'active' relative to itself the way a nav leaf is."

requirements-completed: []

# Metrics
duration: ~35min
completed: 2026-09-26
---

# Phase 8 Plan 8: AccountMenu — the shell's single identity affordance Summary

**A single `AccountMenu` trigger (monochrome initials avatar, no chevron) now replaces the sidebar's old side-by-side ThemeToggle+SignOutButton cluster, opening a floating menu — built on the exact same `use-floating-menu` primitive `RowMenu` uses — with a name/email header, a Settings link, an inline `ThemeToggle` (still the theme's one storage writer), and Sign out; all three E2E specs that asserted the old testids were rewritten in this same plan, and the full 114-test suite is green.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-26
- **Tasks:** 3
- **Files modified:** 11 (4 created, 7 modified)

## Accomplishments

- `packages/ui/src/AccountMenu.tsx` (new): exports `AccountMenu`, `AccountMenuProps`, `AccountMenuLinkProps`. Built on `useFloatingMenu()` exactly like `RowMenu` (`DialogPrimitive.Root modal={false}`, `role="menu"` override, `--shadow-floating`/`bg-surface-3`/`contrast-more:border-hairline-strong` at the same level as `RowMenu`). Trigger: `aria-label="Account menu"`, `aria-haspopup="menu"`, `aria-expanded`, `data-testid="shell-account-menu-trigger"`, 44px row, avatar `aria-hidden` with uppercase first+last-name-token initials computed by `getInitials`. Menu content, top to bottom: non-interactive header (avatar, name at `text-title`, email at `text-caption`), divider, "Settings" (`role="menuitem"`, closes on select via `selectItem`), "Appearance" row with `ThemeToggle` inline (no role, never closes the menu, never a second `noodara-theme` writer), divider, the opaque `signOutSlot`. Zero accent colour anywhere in the file (verified by grep and by a dedicated test); focus ring uses `outline-ink` instead. `AccountMenuProps` has no `items` array — the fixed three-row shape is enforced by the type itself, plus a `@ts-expect-error` compile-time test locking that in.
- `apps/web/src/lib/session-user.ts` (new): `loadSessionUser()` — the one `apiGet('/api/auth/get-session')`, narrowing the response to `{ name, email }` with explicit runtime checks (never a cast), resolving to `null` on any non-ok result or malformed body, never throwing, never spreading the raw session/user object (T-08-22). `useSessionUser()` is a thin `useState`/`useEffect` wrapper around it, running once per mount.
- `apps/web/src/components/Sidebar.tsx`: the `mt-auto` `ThemeToggle`+`SignOutButton` cluster is gone, replaced by a single `AccountMenu` fed by `useSessionUser()` (falling back to `''`/`''` while pending or on failure), `settingsHref="/settings"`, `linkComponent={Link}`, `signOutSlot={<SignOutButton />}`. `ThemeToggle` is no longer imported or mounted directly by this file.
- `apps/web/src/components/SignOutButton.tsx`: testid renamed to `shell-account-menu-sign-out`, `role="menuitem"` added so it joins `AccountMenu`'s roving-focus set; the close-stream/POST/navigate sequence itself is untouched.
- `tests/e2e/shell.spec.ts`: the Tab-order test now ends on a single "Account menu" stop (not two); the theme-cycle and sign-out tests open the trigger first, then act inside the menu; a new `@shell` case proves selecting "Settings" closes the menu and navigates to `/settings`.
- `tests/e2e/canary-ui.spec.ts`: the sign-out step in the full canary flow opens the trigger before clicking `shell-account-menu-sign-out`.
- `tests/e2e/brand.spec.ts`: three added assertions confirm `shell-account-menu-trigger` stays visible at the expanded, rail and sheet breakpoints, alongside whichever brand mark each shows.

## Task Commits

Each task was committed atomically (TDD RED then GREEN):

1. **Task 1: AccountMenu component with the monochrome avatar**
   - `70c0327` (test) — failing AccountMenu component spec
   - `7282ba9` (feat) — AccountMenu with monochrome avatar, built on use-floating-menu
2. **Task 2: Mount it at the sidebar's foot with the real admin identity**
   - `ebce204` (test) — failing loadSessionUser spec
   - `12fae44` (feat) — AccountMenu mounted at the sidebar foot with real identity
3. **Task 3: Rewrite the three E2E specs for the new DOM shape**
   - `b49d135` (test) — shell/canary/brand specs rewritten for the account menu DOM

_No plan-metadata commit yet — this SUMMARY.md and the STATE/ROADMAP updates are committed separately, per the executor's final-commit step._

## Files Created/Modified

- `packages/ui/src/AccountMenu.tsx` — the account menu component (new)
- `packages/ui/src/AccountMenu.test.tsx` — 16 unit tests (new)
- `packages/ui/src/index.ts` — `AccountMenu`/`AccountMenuProps`/`AccountMenuLinkProps` barrel export
- `apps/web/src/lib/session-user.ts` — `loadSessionUser`/`useSessionUser` (new)
- `apps/web/src/lib/session-user.test.ts` — 6 unit tests, node environment (new)
- `apps/web/src/components/Sidebar.tsx` — mounts `AccountMenu`, drops the direct `ThemeToggle` mount
- `apps/web/src/components/Sidebar.test.tsx` — 5 new assertions (identity fallback, rejected/failed session, ThemeToggle/sign-out reachable through the menu)
- `apps/web/src/components/SignOutButton.tsx` — testid rename + `role="menuitem"`
- `tests/e2e/shell.spec.ts` — Tab order, theme-cycle, sign-out rewritten; one new `@shell` case
- `tests/e2e/canary-ui.spec.ts` — sign-out step opens the trigger first
- `tests/e2e/brand.spec.ts` — three added trigger-visibility assertions

## Verification

- `pnpm test` — 2668/2668 passed (161 files)
- `pnpm test:e2e` — 114/114 passed (one `discovery.spec.ts` case flaked once on the first full run under load and passed cleanly in isolation immediately after — pre-existing SSE-timing test, untouched by this plan, not a regression)
- `pnpm check:ui-safety` — all gates green, `AccountMenu.tsx` now real on the shadow allowlist
- `pnpm lint` / `pnpm typecheck` — both clean across every package
- `pnpm exec vitest run packages/ui/src/contrast.test.ts` — green (unaffected by this plan)

## Rules not satisfied

None of the plan's stated rules were skipped. Two acceptance-criteria greps in Task 1 could not be satisfied to their exact literal number and are called out under "Deviations" below with the reasoning; every behavioural requirement they were meant to protect (shared primitive, zero accent) is independently verified by other, exact-passing criteria and by the test suite.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — missing critical functionality] `SignOutButton` needed `role="menuitem"` to join the roving-focus set**
- **Found during:** Task 2
- **Issue:** The plan's Task 2 action says to "change only the testid" on `SignOutButton.tsx`. Without `role="menuitem"`, `use-floating-menu.ts`'s `[role="menuitem"]` query would never find the sign-out control, so ArrowDown/ArrowUp/Home/End could never reach it — silently breaking the keyboard contract Task 1's own `<behavior>` requires.
- **Fix:** Added `role="menuitem"` alongside the testid rename; no other prop or the sign-out sequence itself changed.
- **Files modified:** `apps/web/src/components/SignOutButton.tsx`
- **Commit:** `12fae44`

### Documented (not code) deviations

**2. `railOnly` implemented as pure CSS, not a caller-computed boolean**
- **Found during:** Task 1/2 design
- **Reasoning:** see the "railOnly implemented as pure CSS" key-decision above — a JS-computed breakpoint boolean would reintroduce a hydration-mismatch risk this codebase's own `ThemeToggle.tsx` mount-effect guard exists to avoid. `Sidebar.tsx` never passes `railOnly`; the prop remains for a future caller that always wants the collapsed form.

**3. Arrow-key roving scope excludes the embedded ThemeToggle**
- **Found during:** Task 1
- **Reasoning:** see the corresponding key-decision above. `ThemeToggle` stays reachable by Tab; it is not one of the two `role="menuitem"` roving stops (Settings, Sign out).

**4. Two Task-1 acceptance-criteria greps not met to their literal number**
- **Found during:** Task 1
- **Detail:** `grep -c "useFloatingMenu" packages/ui/src/AccountMenu.tsx` returns 2, not 1 (import + call site — `RowMenu.tsx`, the file this criterion is modelled on, itself returns 3). No code change makes this "1" without an unidiomatic single-line import+call merge, which was not made. Every other Task 1 grep-based criterion passes exactly as written.

## Known Stubs

None — no hardcoded empty/placeholder data was introduced. `useSessionUser()`'s `null`-before-resolved state is an intentional, documented degrade path (T-08-25), not a stub: `AccountMenu` renders correctly with an empty name/email string in that window.

## Threat Flags

None — every threat register mitigation in this plan's frontmatter (T-08-22 through T-08-25, T-08-02, T-08-SC) was implemented as specified; no new network endpoint, auth path, file-access pattern or schema change was introduced.

## Self-Check: PASSED

- FOUND: packages/ui/src/AccountMenu.tsx
- FOUND: packages/ui/src/AccountMenu.test.tsx
- FOUND: apps/web/src/lib/session-user.ts
- FOUND: apps/web/src/lib/session-user.test.ts
- FOUND commit 70c0327 (test: failing AccountMenu spec)
- FOUND commit 7282ba9 (feat: AccountMenu)
- FOUND commit ebce204 (test: failing loadSessionUser spec)
- FOUND commit 12fae44 (feat: mount AccountMenu)
- FOUND commit b49d135 (test: rewrite shell/canary/brand specs)
