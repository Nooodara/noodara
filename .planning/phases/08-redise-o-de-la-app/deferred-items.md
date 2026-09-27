# Deferred items

Out-of-scope discoveries logged per the executor's scope-boundary rule -- not fixed here, surfaced
at the G2 checkpoint (08-11-PLAN.md Task 2) for the user to judge.

## Fixed in G2 round 1 (docs/ui/APPROVAL.md)

The user's "G2 adjust" reply approved one recommended round covering the two items below (plus
the `ServerFacts.tsx` stat-tile wrap found in the same pixel audit, added directly as a Task 3
round-1 fix rather than deferred). RED `f4c06fc`, GREEN `b5c26f6`.

### `Toolbar.tsx`'s translucent background rendered far lighter than intended in dark theme, intermittently -- FIXED

- **Was:** `bg-surface-1/90 backdrop-blur` combined with `motion-safe:transition-colors`, which
  bundles `background-color` into the animated property set. A theme switch faded the toolbar's
  own background in over `--duration-panel` while every other surface on the page snapped
  instantly -- a stray near-white/mid-grey band across the full toolbar width in
  `servers-dark-1280.png`, `activity-dark-1280.png`, `settings-dark-1280.png` and
  `account-menu-open-dark-1280.png` (P17, theme-paint race).
- **Fix:** scoped the transition to `motion-safe:transition-[border-color]` -- only the
  scroll-edge hairline animates now, matching the single-property arbitrary form
  `Input.tsx`/`Textarea.tsx` already use elsewhere in this codebase. `Toolbar.test.tsx` gained an
  explicit assertion that the class list never bundles `background-color` into any transition.
- **Verified:** re-ran `pnpm ui:review`; the band is gone in `servers-dark-1280.png`,
  `activity-dark-1280.png`, `settings-dark-1280.png` and `account-menu-open-dark-1280.png`,
  confirmed by direct visual inspection of the regenerated captures.

### `ServerDetailToolbar`'s server-name title truncates to almost nothing at 375px -- PARTIALLY FIXED, residual gap noted

- **Was/fix:** `ServerDetailToolbar.tsx`'s title wrapper and its `h1` gained `min-w-0`, the
  documented minimal fix, matching the flex/truncate discipline used elsewhere in this codebase.
  `ServerDetailToolbar.test.tsx` (new) asserts both carry `min-w-0` and `truncate`.
- **Verified, and here is the honest residual finding:** re-capturing `server-detail-light-375.png`
  after the fix shows the same truncation depth as before ("u." for the 19-character seeded name
  `ui-review-connected`). Investigating why: both the wrapper and the `h1` already carried
  `truncate` (which sets `overflow: hidden`) before this fix, and per the CSS Flexbox spec a flex
  item's automatic minimum size is already `0` once its own `overflow` is non-`visible` --
  `min-w-0` does not change behaviour here, it only makes the existing contract explicit and
  matches the codebase's own established convention (`Toolbar.test.tsx`, `AccountMenu.tsx`'s
  `min-[900px]:hidden` idiom) for future readers. The real limiting factor at 375px is that the
  back link, `StatusPill` and the primary action button (all rendered inline in the same 52px row)
  already consume nearly all of the available 343px (viewport minus padding), leaving roughly
  30-50px for the title + pill combined -- not enough for more than 1-2 characters of a
  --text-display (28px) server name, regardless of the flex-shrink mechanics.
- **Why not fixed further here:** giving the title materially more room at 375px requires changing
  the back link, `StatusPill` or the primary action button's own rendering at that width (e.g. an
  icon-only back link below a breakpoint) -- real layout surface beyond this round's single
  recommended fix, and beyond G2's one-round ceiling for this delegated approval.
- **Suggested follow-up:** whichever plan next touches `ServerDetailToolbar.tsx` should decide
  whether the back link collapses to an icon-only affordance below ~480px (freeing real room for
  the title) or whether a long server name at 375px is an accepted trade-off -- alongside the
  already-flagged missing scroll-edge/accessibility-fallback parity with `Toolbar.tsx` (see below).

## Still open (not this plan's scope; surfaced for later plans)

### `server-detail-light-900.png` captured the loading skeleton instead of the settled page

- **Found during:** 08-11's G2 pre-gate audit, comparing `pnpm ui:review`'s captures
  pixel-by-pixel.
- **Symptom:** every other `server-detail-*` capture (`-light-1280`, `-dark-900`, `-light-375`,
  etc.) shows the fully loaded detail screen (stat tiles with real values, the three `InsetGroup`
  blocks). `server-detail-light-900.png` alone shows the ten-skeleton loading state frozen
  mid-fetch.
- **Why not fixed here:** a one-off capture-script timing flake (the settle-wait race is between
  the script's own `SETTLE_TIMEOUT_MS`/`POLL_INTERVAL_MS` and the real fixture stack's SSE
  delivery), not a product bug and not something this plan's own file scope touches
  (`scripts/ui/capture-ui-review.ts` is out of `08-11-PLAN.md`'s `files_modified`).
- **Suggested follow-up:** re-run `pnpm ui:review` before relying on this specific file, or harden
  the script's settle-wait for the 900px server-detail screen specifically.

### `ServerDetailToolbar` still has no scroll-edge effect or any of the three accessibility fallbacks

- **Found during:** 08-10-SUMMARY.md's own explicit flag, re-confirmed during 08-11's G2 pixel
  audit -- `ServerDetailToolbar.tsx` still carries a permanent `border-b border-hairline` and its
  own `backdrop-blur`, with zero `prefers-reduced-transparency`/`contrast-more`/reduced-motion
  fallbacks, unlike `Toolbar.tsx` (08-10).
- **Why not fixed here:** out of this round's single-fix scope (`min-w-0` only, per the
  delegated G2 resolution); a real, separate piece of parity work.
- **Suggested follow-up:** whichever plan next touches `ServerDetailToolbar.tsx` should give it the
  same scroll-edge effect and three fallbacks `Toolbar.tsx` already has.

### Two ungated hover utilities noted during the shell/menu work (08-06)

- **Found during:** 08-06's own hover-gating sweep (`[@media(hover:hover)_and_(pointer:fine)]:`
  extended to `RowMenu`'s item/trigger classes and `ListRow`'s row classes); re-flagged here as
  still worth a final repo-wide grep before G3, since new hover-bearing utilities can land in any
  later plan (08-13 through 08-19) without automatically inheriting the gate.
- **Suggested follow-up:** re-run `check-ui-safety`'s hover-gate convention check (or a manual
  grep for ungated `hover:`) once P1/P2 land, before G3.

### `@inspector` slot's below-1280px presentation is a solid fixed panel, not `Sheet` -- confirm this reads as intentional, not a downgrade

- **Found during:** 08-09-SUMMARY.md's own documented decision (backdrop-filter budget already at
  the "at most three" ceiling; `Sheet`'s scrim would also violate the brief's "no scrim on a
  non-blocking parallel panel" rule).
- **Suggested follow-up:** G3's live review should judge whether the solid `bg-surface-elevated`
  panel reads as a deliberate material choice once the inspector actually has content (13+),
  rather than a missed floating-elevation treatment.

### Sheet's exit animation has no observable mid-flight transform frame; the real `forceMount`/`Presence`-based exit animation is 08-14's to build

- **Found during:** 08-06-SUMMARY.md's own investigation (Radix mounts `Sheet`'s content already
  at its final state and unmounts synchronously on close -- no exit transition exists yet to
  gate).
- **Suggested follow-up:** 08-14's motion-contract sweep builds the real exit animation; G3's live
  review (Sheet drag-to-dismiss checklist items) is where this becomes observable and testable.

### An Esc-close of `Sheet` never returns focus to the "Add server" trigger button

- **Found during:** 08-12's own Task 3 E2E work, while writing the drag-to-dismiss Playwright
  suite. Reproduced against the pristine, pre-08-12 `Sheet.tsx` (checked out from the tip of
  08-11) with the identical assertion, confirming this is not a regression introduced by 08-12's
  drag changes: `Sheet` never renders a `DialogPrimitive.Trigger` (it is opened via an
  externally-controlled `open`/`onOpenChange` prop pair, per its own header comment on why --
  `Sheet`/`Dialog` need to be externally controlled, unlike `RowMenu`'s stateful trigger), so
  Radix's `FocusScope` has no `Trigger` element of its own to remember and restore focus to on
  unmount, and this codebase's own `document.activeElement`-based fallback restoration either
  isn't wired or doesn't fire reliably for this externally-controlled shape.
- **Why not fixed here:** out of 08-12's scope -- caused by a pre-existing architectural choice
  (Task 3's own SCOPE BOUNDARY rule: only auto-fix issues directly caused by the current task's
  changes). 08-12's own Esc-related acceptance criteria only require that Esc still dismisses the
  Sheet with no animation, which still holds; the trigger-focus-return test in
  `tests/e2e/server-sheet.spec.ts`'s `@sheet-drag` suite was narrowed to assert only what this
  plan actually owns.
- **Suggested follow-up:** whichever future plan next revisits `Sheet`'s open/close plumbing
  should either capture the triggering element explicitly (a `lastFocusedElement` ref set at the
  call site before `onOpenChange(true)`) and restore it in an effect on close, or confirm Radix's
  own `document.activeElement` fallback and find why it isn't restoring focus in this app's real
  DOM shape.

### Login fails silently when the request origin is rejected (`INVALID_ORIGIN`, 403)
- **Found during:** the G3 live review (2026-09-26), reaching the dev stack through a public tunnel
  whose origin did not match `NOODARA_PUBLIC_URL`.
- **Symptom:** `POST /api/auth/sign-in/email` returns `403 {"code":"INVALID_ORIGIN"}` (Better
  Auth's CSRF origin check, `baseURL` = `NOODARA_PUBLIC_URL`), and `/login` shows no banner at
  all — the user reads it as "wrong credentials" and resets their password for nothing. Wrong
  credentials do show the banner (401 path verified), so the gap is only the non-401/429 branch.
- **Suggested follow-up:** `apps/web/src/app/login/page.tsx`'s generic-failure branch must always
  render a banner (fall back to a safe generic message when `copyForErrorCode` has no copy for the
  code), and the operator docs should say that `NOODARA_PUBLIC_URL` must be the exact origin the
  browser uses. Candidate for the G3 adjustment round or Phase 9's auth work.

## Decisions changed at G3

### D-05: Appearance leaves the account menu, moves into Settings

- **Found during:** the G3 live review (2026-09-26), "G3 adjust" round 1, item 5.
- **The user's words:** "Creo que es mejor que la apariencia esté en settings y no como sección
  aparte."
- **What changed:** 08-CONTEXT.md's D-05 originally put the theme control inline inside the
  account menu's "Appearance" row (`packages/ui/src/AccountMenu.tsx`). That row (and its inline
  `ThemeToggle`) is removed; the theme control now lives in a new Appearance `InsetGroup` on
  `/settings` (`apps/web/src/components/SettingsGroups.tsx`), consistent with the existing
  Instance group. `ThemeToggle` itself is unchanged -- its `STORAGE_KEY` still has exactly one
  writer, only its mount point moved. This is UI-level only: no server-side theme persistence was
  added (Phase 9's own SET-02..06/D20-D21 own that), matching D-05's original scope note.
- **Why not deferred:** small enough (one component's row moves to another) to apply directly as
  a G3 adjustment round rather than push to a future phase.

## Status at G3 close (2026-09-26)

G3 was approved (`docs/ui/APPROVAL.md`) after one adjustment round. The items below remain open
past the phase's own final gate and are handed to whichever plan next touches their files —
none of them blocked G3 itself, per the delegated-approval resolution recorded above and in
`08-HUMAN-UAT.md` §G3.

- **`ServerDetailToolbar`'s title truncates to almost nothing at 375px.** Root cause investigated
  and documented above (min-w-0 was already a no-op given existing `overflow:hidden`; the real
  constraint is the back link/`StatusPill`/primary action button already claiming the row's width
  at that breakpoint). Suggested follow-up unchanged: decide whether the back link collapses to
  icon-only below ~480px, or accept a long name truncating as a trade-off.
- **`ServerDetailToolbar` still has no scroll-edge effect or the three accessibility fallbacks**
  (`prefers-reduced-transparency`, `contrast-more`, reduced-motion) that `Toolbar.tsx` already has.
  Real parity work, out of every G-gate plan's own file scope so far.
- **Ungated hover utilities**: no fresh repo-wide grep for un-gated `hover:` classes was run as
  part of this plan's own scope (round 1's five fixes did not touch hover-bearing utilities); the
  last confirmed sweep is 08-06's. `check:ui-safety` has no dedicated hover-gate rule, so this is a
  manual grep, not a CI gate — recommend adding one before any future plan lands new hover styles.
- **An Esc-close of `Sheet` never returns focus to the "Add server" trigger button.** Unchanged
  since 08-12; architectural (Sheet has no `DialogPrimitive.Trigger` of its own, being externally
  controlled). Candidate for whichever plan next revisits `Sheet`'s open/close plumbing.
- **Login fails silently when the request origin is rejected (`INVALID_ORIGIN`, 403).** Found
  during the G3 live review over a public tunnel; the generic-failure branch on `/login` renders no
  banner for this specific 403 code. Candidate for Phase 9's auth work.
- **UI-04's screen-reader pass (`RowMenu`, `AccountMenu`) was never performed by the user**, at
  either G2 or G3. Both remain explicitly open in `08-HUMAN-UAT.md`. **UI-04 is NOT marked complete
  in REQUIREMENTS.md.** Whichever plan next does a live accessibility pass over these two
  components should close this out with an actual VoiceOver session, not a delegated approval.
- **The Sheet drag-feel (slow motion, real touch hardware) and both brand-swap verdicts
  (discovery narration, TOFU/Fingerprint block) were never confirmed in the user's own words at
  G3.** The mechanics are covered by automated E2E (`@sheet-drag`, `@discovery-ring` suites,
  143/143 green) and the user did approve after a live session with these surfaces on screen, but
  no first-person drag-feel or brand-swap verdict was ever given. `docs/ui/APPROVAL.md`'s G3 block
  and `08-HUMAN-UAT.md` §G3 record this honestly rather than fabricate a verdict. These are not
  reopened as blockers — G3 is closed by the user's explicit "G3 approved" — but they are real,
  named gaps in the record for anyone auditing this phase's closure later.
