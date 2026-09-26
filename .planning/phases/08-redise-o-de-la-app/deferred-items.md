# Deferred items

Out-of-scope discoveries logged per the executor's scope-boundary rule -- not fixed here, surfaced
at the G2 checkpoint (08-11-PLAN.md Task 2) for the user to judge.

## 08-11: `Toolbar.tsx`'s translucent background renders far lighter than intended in dark theme, intermittently

- **Found during:** 08-11's G2 pre-gate audit, comparing `pnpm ui:review`'s dark-theme captures
  pixel-by-pixel (`docs/ui/review/*-dark-1280.png`).
- **Symptom:** `Toolbar.tsx` (used on `/servers`, `/activity`, `/settings`) declares
  `bg-surface-1/90 backdrop-blur`, the same class list `ServerDetailToolbar.tsx` uses. In
  `ServerDetailToolbar.tsx`'s own dark capture the toolbar band measures `rgb(28,28,30)` against a
  `rgb(29,29,31)` canvas -- correctly near-invisible, as the design intends (D-03: "el toolbar
  sigue translúcido sobre canvas"). But in `Toolbar.tsx`'s dark captures the same band measures
  `rgb(156,156,156)` (`servers-dark-1280.png`, `activity-dark-1280.png`,
  `account-menu-open-dark-1280.png`) or even `rgb(232,231,232)` (`settings-dark-1280.png`) against
  the same `rgb(22,22,24)` canvas -- a stray near-white/mid-grey band across the full toolbar
  width, unmistakable at a glance and inconsistent between screens using the identical component.
  The same `/servers` route's `row-menu-open-dark-1280.png` and `sheet-open-dark-1280.png`
  captures (taken moments later in the same script run) do **not** show the band -- same page,
  same theme, same component, different result. Also reproduces at 375px
  (`servers-dark-375.png`).
- **Why not fixed here:** 08-11's own `files_modified` is `docs/ui/APPROVAL.md` and
  `08-HUMAN-UAT.md` only; `Toolbar.tsx` was last touched by 08-10 and this defect is not caused by
  anything in this plan's own changes (this plan wrote no code). The intermittent, page-load-order
  -dependent pattern points at a theme-paint race (the `--surface-1` dark value not yet resolved
  when the sticky `backdrop-blur` toolbar composites against whatever the page background was at
  that exact frame -- P17 in `.planning/research/PITFALLS.md`, "flicker de tema") rather than a
  single deterministic CSS bug, which needs its own investigation, not a guess fixed under this
  plan's checkpoint-only scope.
- **Suggested follow-up:** whichever plan next touches `Toolbar.tsx`, `theme-script.ts` or the
  capture pipeline should reproduce this with `pnpm ui:review` a few times in a row, capture
  whether it is truly non-deterministic or triggered by a specific navigation path (fresh `goto`
  immediately followed by a screenshot vs. an already-settled page), and fix the underlying race
  rather than the appearance.

## 08-11: `server-detail-light-900.png` captured the loading skeleton instead of the settled page

- **Found during:** the same pixel-level pass above.
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

## 08-11: `ServerDetailToolbar`'s server-name title truncates to almost nothing at 375px

- **Found during:** the same pixel-level pass above (`server-detail-light-375.png`).
- **Symptom:** the 19-character seeded name `ui-review-connected` renders as literally `u.` in the
  sticky detail toolbar at 375px, immediately followed by the `StatusPill` and the primary action
  button -- unreadable, not merely tightly truncated. `ServerDetailToolbar.tsx`'s title (`<h1
  className="truncate ...">`) sits inside a `flex flex-1 ... truncate` wrapper alongside the pill;
  neither the wrapper nor the `h1` itself carries `min-w-0`, so the flex item's intrinsic content
  width wins over the available space calculation before `truncate`'s `overflow:hidden` can act,
  starving the title down to almost nothing once the pill and back-link claim their own space.
- **Why not fixed here:** `ServerDetailToolbar.tsx` predates this phase (05-UI-SPEC.md) and was
  deliberately left untouched by every 08-* plan to date (08-10-SUMMARY.md names it explicitly as
  out of that plan's own scope); fixing its flex layout is a one-line-but-real code change outside
  this checkpoint-only plan's file scope.
- **Suggested follow-up:** add `min-w-0` to the truncating flex item (or the `h1` itself) the next
  time `ServerDetailToolbar.tsx` is touched -- likely alongside the already-flagged missing
  scroll-edge/accessibility-fallback parity with `Toolbar.tsx`.
