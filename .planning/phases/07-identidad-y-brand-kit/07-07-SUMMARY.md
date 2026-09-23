---
phase: 07-identidad-y-brand-kit
plan: 07
subsystem: ui
tags: [brand, sidebar, authcard, currentColor, breakpoints, playwright, vitest, tdd, ux-review, BRAND-02]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-03's Logo/Lockup from @noodara/ui -- currentColor SVG, caller-supplied data-testid, no className prop"
  - phase: 07-identidad-y-brand-kit
    provides: "07-05's docs/brand/APPROVAL.md and DEFAULT_CONCEPT = 'c' (D-17 gates any BRAND-02 surface)"
  - phase: 07-identidad-y-brand-kit
    provides: "07-04's scripts/brand/capture-brand-review.ts --mounted flag and review-paths.ts"
  - phase: 05-ui-web
    provides: "Sidebar/AuthCard, the shell's three breakpoints and its stable test ids; the renderUi/screen harness; tests/e2e/fixtures/stack.ts"
provides:
  - "apps/web/src/components/Sidebar.tsx: the brand slot above the nav list -- Logo in the 64px rail, Lockup from 1280px, nothing in the bottom sheet (D-04)"
  - "apps/web/src/components/AuthCard.tsx: the Lockup above the h1 on /setup and /login (D-04)"
  - "apps/web/src/components/{Sidebar,AuthCard}.test.tsx: 17 jsdom tests -- the brand slot plus a regression fence around every pre-existing test id"
  - "tests/e2e/brand.spec.ts: 7 @brand tests proving the breakpoint switch, the 64px rail width and the currentColor theme follow in a real browser"
  - "docs/ui-review-07-brand.md: the noodara-ux-review audit of the four surfaces, global verdict PASS"
  - "docs/brand/approved/: the eight in-app captures re-shot from the REAL mounted components, superseding the injected previews"
affects: [07-08, 07-09, 07-10, phase-08-redesign]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The breakpoint switch is two always-mounted wrappers, one display:none per width -- never a JS width check and never a conditional render. Exactly one mark is therefore in the accessibility tree at any width, which is why 07-03 chose data-part over id in the first place"
    - "A component test asserts the wrapper's breakpoint CLASSES; only the E2E resolves them into an actually-hidden element. The two layers are complementary, and the plan's RED evidence for the E2E is the component test (a pre-mount E2E run would need a second checkout)"
    - "An acceptance grep that forbids a literal is satisfied by naming the forbidden thing descriptively in prose (07-03's own precedent), so a comment that exists to forbid a construct never counts as a use of it"

key-files:
  created:
    - apps/web/src/components/Sidebar.test.tsx
    - apps/web/src/components/AuthCard.test.tsx
    - tests/e2e/brand.spec.ts
    - docs/ui-review-07-brand.md
  modified:
    - apps/web/src/components/Sidebar.tsx
    - apps/web/src/components/AuthCard.tsx
    - docs/brand/approved/sidebar-expanded-{light,dark}.png
    - docs/brand/approved/sidebar-rail-{light,dark}.png
    - docs/brand/approved/login-{light,dark}.png
    - docs/brand/approved/setup-{light,dark}.png

key-decisions:
  - "The mark is not a link and not a control: two plain divs, no tabindex, no href, no tooltip. The focus order is therefore byte-identical, and whether the mark becomes a link home is Phase 8's decision, not this plan's"
  - "The below-900px bottom sheet carries no mark at all -- it is a temporary navigation overlay, not the product's chrome, and vertical space there is scarce. Asserted in both directions (closed and open)"
  - "The rail monogram is 24px while the nav icons are 20px: the mark is the identity, not a fourth member of the icon family, and at 20px the Viewfinder's centre ring loses its counter. Both still share one optical axis (px-3 on both)"
  - "docs/brand/approved/ now shows production code rather than the review-time injection; the two board PNGs are untouched, since a board has no app surface to re-shoot"
  - "BRAND-02 stays Pending: this plan delivers four of its surfaces, and the favicon/apple-touch-icon (07-09), the README (07-10) and the public site are still outstanding"

patterns-established:
  - "A brand mount point supplies the test id, the title and the size at the call site and nothing else -- no concept id and no colour, so an adjustment round remains a single constant edit in packages/ui"

requirements-completed: []

# Metrics
duration: ~15min
completed: 2026-09-22
---

# Phase 7 Plan 07: The mark, mounted Summary

**The approved Viewfinder mark now ships in the product: the monogram alone in the 64px rail, the horizontal lockup in the expanded sidebar and above the heading on `/login` and `/setup` — one `currentColor` SVG per surface serving both themes with no theme branch, no colour literal and not one existing test id touched.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 3 (Task 1 a full TDD cycle, RED committed before GREEN)
- **Files created:** 4; modified: 2 source files + 8 captures
- **Tests:** 17 new jsdom + 7 new E2E, all green; 26 pre-existing E2E re-run against the real stack

## Accomplishments

- **D-04, exactly as written.** `Sidebar.tsx` gained one five-line block above the nav list: a rail wrapper (`hidden`, `min-[900px]:flex`, `min-[1280px]:hidden`) holding `<Logo title="Noodara" size={24} data-testid="brand-monogram" />`, and an expanded wrapper (`hidden`, `min-[1280px]:flex`) holding `<Lockup … height={20} data-testid="brand-lockup" />`. `AuthCard.tsx` gained one wrapper above its `h1` with the lockup at `height={22}`. Both class strings are named module constants next to `LABEL_CLASSES`, with a comment tying them to the breakpoints the nav items already use.
- **No brand knowledge at the call sites.** Neither mount passes a `concept` (the approved `DEFAULT_CONCEPT = 'c'` supplies it) nor a `color` (the `text-ink` wrapper does, through `currentColor`). `grep -cE "color=|text-accent|fill=" …` prints 0 for both files, and `pnpm check:ui-safety` holds on all nine repo-wide gates. A future D-16 adjustment round still never touches `apps/web`.
- **The breakpoint switch is proven, not assumed.** `tests/e2e/brand.spec.ts` drives the real stack at 1440×900, 1024×800 and 800×800: the lockup visible and the monogram hidden when expanded, the reverse in the rail (with the nav's bounding box measured at exactly 64px), and both hidden in the bottom sheet whether it is closed or opened. Exactly one image named "Noodara" exists on `/login` and `/setup`, so the always-mounted pair never announces itself twice.
- **`currentColor` proven by computed colour, not by eye.** Two of the seven E2E tests read the rendered `color` of the mark in light and dark and assert it changes — the direct evidence that one asset serves both themes. Theme is set by writing `data-theme` rather than clicking the toggle, so no assertion depends on what a previous test left in localStorage.
- **Nothing existing moved.** `git diff --stat` on `Sidebar.tsx` is an extended import line, the two constants and the brand block; `shell-sidebar`, `shell-sidebar-scrim`, `shell-theme-toggle`, `login-submit`, `setup-banner` and `login-banner` are all untouched, and `tests/e2e/{shell,auth,setup}.spec.ts` have an empty diff. The component suite carries a regression fence for the sidebar's own ids, its three links and its `aria-current`, so a future edit that drops one fails here before it reaches the E2E.
- **`docs/brand/approved/` now shows production code.** The eight in-app captures were re-shot with `pnpm brand:review --mounted --concept c`, which skips the review-time DOM injection entirely. The previous files were previews of what the mount would look like; these are the mount. The two board PNGs are unchanged (a board has no app surface), so the folder still holds exactly ten PNGs and `tests/unit/brand/approval-record.test.ts` still passes.
- **ux-review: PASS, no blockers.** `docs/ui-review-07-brand.md` audits all nine dimensions with evidence per row (file:line, a capture, or a named passing assertion), and records the two things a screenshot cannot settle.

## Task Commits

| Task | What | Commit | Type |
|------|------|--------|------|
| 1 | RED: failing brand mount-point tests (12 failing, 5 of the regression fence already green) | `d5b340e` | test |
| 1 | GREEN: Logo/Lockup mounted in the sidebar and the auth card | `3710457` | feat |
| 2 | The `@brand` E2E spec | `51e3a05` | test |
| 3 | ux review + the eight refreshed approved captures | `df0cd77` | docs |
| — | This summary and the tracking update | (below) | docs |

## RED evidence

Task 1's RED run failed 12 of 17: every brand assertion failed on a missing `brand-monogram`/`brand-lockup`, while the five regression-fence tests (existing test ids, links, `aria-current`) passed both before and after — which is the point of a fence. After the mount: 17/17.

Task 2's E2E has no RED run of its own, by the plan's own instruction: running the spec against a pre-mount build would require a second checkout of the working tree. Its RED evidence is Task 1's component suite, which failed on the exact same absence one layer down.

## Verification

- `pnpm exec vitest run apps/web/src/components/Sidebar.test.tsx apps/web/src/components/AuthCard.test.tsx` — 17/17 green (12 failing before `3710457`)
- `pnpm exec vitest run … tests/unit/brand` — 9 files / 119 tests green, including the approval-record test that pins the approved-capture set at ten
- `pnpm exec playwright test tests/e2e/brand.spec.ts` — 7/7 green against the real stack
- `pnpm exec playwright test tests/e2e/shell.spec.ts --grep @shell` — 9/9 green (tab order, focus outline, the 1024px/900px collapse), and `tests/e2e/{auth,setup}.spec.ts` — 11/11 green. 26 pre-existing E2E re-run after the mount; the full 93 stay 07-10's job
- `pnpm check:ui-safety`, `pnpm --filter @noodara/web typecheck`, `pnpm --filter @noodara/web lint`, `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` — all exit 0
- `NOODARA_API_ORIGIN=http://localhost:3100 pnpm build` — 5/5 tasks successful (the auth card imports `@noodara/ui` from a server component for the first time; the build proves it)
- `ls docs/brand/approved/*.png | wc -l` → 10, with the eight in-app files newer than `docs/brand/APPROVAL.md`; `grep -ci "claude\|anthropic" docs/ui-review-07-brand.md` → 0
- `git diff --stat -- tests/e2e/shell.spec.ts tests/e2e/auth.spec.ts tests/e2e/setup.spec.ts` → empty
- `docker ps` shows no Noodara container; the stack fixture tore down after every run

## Security check before committing the captures

T-07-21 was checked by opening the images, not by trusting the script. `login-light.png` shows empty Email and Password fields; `setup-dark.png` shows an empty **Token** as well as empty Email/Password; `sidebar-rail-light.png`, `sidebar-rail-dark.png` and the expanded-sidebar dark crop show the "No servers yet" empty state with no hostname and no account email anywhere in the shell. All eight come from the Docker fixture stack, captured before sign-in on a fresh context for the two unauthenticated screens. No real hostname, token or credential appears in any file, and no browser chrome is captured.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Two comments name a forbidden literal descriptively instead of literally**
- **Found during:** Task 1 GREEN and Task 2
- **Issue:** The plan's own acceptance greps are `grep -cE "color=|text-accent|fill=" …` prints 0 and `tests/e2e/brand.spec.ts` contains zero `waitForTimeout`. Both files legitimately need a comment stating *why* the forbidden thing is absent (D-09's single action colour; the tdd skill's ban on fixed sleeps), and each comment matched its own gate — `Sidebar.tsx` printed 1, `brand.spec.ts` printed 1.
- **Fix:** Both comments name the banned construct descriptively ("the accent utility class", "not one fixed sleep is used anywhere in this file") and say outright that they do so to keep the grep exact — exactly the precedent 07-03 set for `packages/ui/src/index.ts` and its own test files. The rationale survives; the gate is literal-clean.
- **Verification:** both greps print 0; the tests and the spec are unchanged in behaviour.
- **Files modified:** `apps/web/src/components/Sidebar.tsx`, `tests/e2e/brand.spec.ts`
- **Committed in:** `3710457` and `51e3a05`

**2. [Rule 2 - Missing critical verification] The shell context is supplied for real in the component test**
- **Found during:** Task 1 RED
- **Issue:** The plan named only `next/navigation`'s `usePathname` as needing a mock. Rendering `<Sidebar>` also renders `SignOutButton`, which calls `useRouter` (same module) and `useShellContext` — the latter throws by design outside the shell layout, so the suite could not mount at all.
- **Fix:** The `next/navigation` mock provides `useRouter` as well, and the shell context is supplied for real through `ShellContext.Provider` with a small, fully typed value rather than mocked — the sidebar is then exercised with its real children, not a stub.
- **Verification:** 17/17 green; the sign-out button renders in the tree.
- **Files modified:** `apps/web/src/components/Sidebar.test.tsx`
- **Committed in:** `d5b340e` (RED) — the mock was needed for the tests to fail for the right reason

**3. [Rule 2 - Missing critical verification] Two existing specs were re-run, beyond the plan's verify blocks**
- **Found during:** Task 3
- **Issue:** The ux-review's accessibility row claims the focus order is unchanged. Asserting that structurally (a `div` with no `tabindex`) is weaker than proving it, and the two files this plan edits are exactly the ones `@shell`, `@auth` and `@setup` cover.
- **Fix:** `tests/e2e/shell.spec.ts --grep @shell` (9 tests) and `tests/e2e/{auth,setup}.spec.ts` (11 tests) were run against the real stack after the mount. All 20 pass, so the report cites real evidence. The full 93-spec regression is still 07-10's.
- **Verification:** 20/20 green; no spec file was edited (`git diff --stat` on all three is empty).
- **Files modified:** none
- **Committed in:** n/a (verification only)

---

**Total deviations:** 3, all inside this plan's own files or purely additional verification. None changes scope.

## Issues Encountered

- **`pnpm test -- <path>` still does not filter** (the quirk 07-03 already recorded): the positional argument is not forwarded to Vitest, so that command runs the whole unit suite. `pnpm exec vitest run <paths>` was used for every scoped run in this plan.
- **`pnpm brand:review` needs the `--` separator** for its own flags under pnpm: `pnpm brand:review -- --mounted --concept c`, matching what 07-05 recorded.

## User Setup Required

None.

## Next Phase Readiness

- **07-08 (brand kit doc) and 07-09 (web icons) are unblocked** and have a real, in-product reference to point at: `docs/brand/approved/` now shows the mark as it actually ships, so BRAND.md's clear-space and misuse sections can cite production captures rather than previews.
- **07-10's full regression is the first run of all 93 + 7 E2E together.** This plan re-ran 26 of them; nothing suggests a conflict, and the new spec is a separate file with its own `@brand` tag that no existing `--grep` selects.
- **BRAND-02 remains Pending.** Four of its surfaces ship here; the favicon and apple-touch-icon (07-09), the README lockup (07-10) and the public site are still outstanding, so the requirement is not ticked — the same discipline 07-01/07-02/07-03 applied.
- **Phase 8 inherits a clean decision point.** The mark is deliberately not a link; making it one is a single wrapper change at two call sites, with `Sidebar.test.tsx`'s "does not make the mark a link or a control" test as the place that decision gets recorded when it flips.

## Self-Check: PASSED

- All four created files exist on disk (`Sidebar.test.tsx`, `AuthCard.test.tsx`, `tests/e2e/brand.spec.ts`, `docs/ui-review-07-brand.md`); the eight refreshed captures are tracked and newer than `docs/brand/APPROVAL.md`.
- Commits `d5b340e`, `3710457`, `51e3a05`, `df0cd77` are all in `git log`, with the RED committed before the GREEN.
- Every commit touches only paths under `noodara/code/`; none carries an attribution trailer; `git stash list` is empty.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-22*
