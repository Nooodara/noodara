---
phase: 07-identidad-y-brand-kit
plan: 04
subsystem: infra
tags: [brand, playwright, screenshots, review, dom-injection, tokens, vitest, tdd]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-01's geometry.ts constants (GRID/MARGIN/STROKE/APERTURE_RADIUS/BASELINE, CONCEPT_META, monogramParts) that the construction sheet annotates"
  - phase: 07-identidad-y-brand-kit
    provides: "07-03's static-svg.ts (renderStaticSvg/tileSvg) -- every mark on a board or injected into the app is that module's output, never a second drawing"
  - phase: 07-identidad-y-brand-kit
    provides: "07-02's write-if-changed.ts (writeIfChanged/changedFiles) and scripts/brand/tsconfig.json"
  - phase: 05-ui-web
    provides: "tests/e2e/fixtures/stack.ts (startStack/stopStack), shell.spec.ts's login helper and testids, packages/ui/tokens.css + contrast.ts's parseTokensCss"
provides:
  - "scripts/brand/review-paths.ts: REVIEW_ROOT, REVIEW_SURFACES, THEMES, reviewPngPath(concept, surface, theme, variant?) -- one agreed layout for every review artifact"
  - "scripts/brand/board-html.ts: buildBoardHtml({concept, theme, tokensCss, tile, og}) and BOARD_SCALES -- a pure, unit-tested brand board carrying every D-14 element plus the D-12 OG preview and the labelled tab simulation"
  - "scripts/brand/render-boards.ts + `pnpm brand:boards`: six board PNGs (3 concepts x 2 themes)"
  - "scripts/brand/capture-brand-review.ts + `pnpm brand:review`: 24 full in-app captures + 12 sidebar crops, produced by DOM injection at capture time with zero production-code change; --mounted re-runs the same matrix once 07-07 mounts the real components"
  - "docs/brand/review/README.md and the .gitignore block that keeps every capture out of git except that README"
  - "31 new unit tests pinning the board's contents, its four-colour-literal budget, its markup safety and the review path layout"
affects: [07-05, 07-07, 07-08, 07-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Review-time DOM injection instead of a production feature flag: the mark is put on screen with `insertAdjacentHTML` of `renderStaticSvg` output inside a `color: var(--ink)` wrapper, so the review shows the exact markup 07-07 will mount, inherits the real theme tokens, and leaves no trace in apps/web or packages/ui"
    - "A board that renders the design system rather than copying it: tokens.css is inlined verbatim and every surface/ink/hairline is a var() reference; exactly four literal colours (the tile's two, the OG's two) are allowed in the markup and a test asserts that budget"
    - "Deriving a `[data-theme=\"light\"]` block from the passed tokens' own `:root` body, so a light and a dark simulated tab strip can sit side by side on one board without either palette being retyped"
    - "npm scripts run tsx under `--tsconfig packages/ui/tsconfig.json`: tsx picks a JSX transform from the tsconfig that COVERS the file it transforms, and scripts/brand/tsconfig.json (the typecheck one) does not cover packages/ui/src/**/*.tsx"

key-files:
  created:
    - scripts/brand/review-paths.ts
    - scripts/brand/board-html.ts
    - scripts/brand/render-boards.ts
    - scripts/brand/capture-brand-review.ts
    - tests/unit/brand/review-paths.test.ts
    - tests/unit/brand/board-html.test.ts
    - docs/brand/review/README.md
  modified:
    - package.json
    - .gitignore

key-decisions:
  - "The construction sheet shows the grid, the margin box, the baseline, the constants and the part names -- but NOT a stroke-outlined copy of the mark, which the plan's action sketched. 07-01/07-03 forbid any `stroke` on the mark itself and the orchestrator restated that as a hard upstream fact; an outline overlay would have been exactly that, for an annotation the grid plus the part list already deliver"
  - "`parseTokensCss` returns token names WITHOUT the leading `--` (it captures `--([a-z0-9-]+)`), so the generator reads `tokens.light['accent-fill']`, not the plan interface's `tokens.light['--accent-fill']`"
  - "A fresh browser context per concept: /login and /setup must be genuinely unauthenticated for all three concepts, not just the first, and a fresh context is what guarantees that without a sign-out dance"
  - "`reviewPngPath` takes an optional fourth `variant` argument ('crop'), additive to the plan's three-argument interface, so the tight sidebar shot sorts next to its own full-page capture"
  - "Both scripts fail loud when an injection anchor or a bounding box is missing, rather than writing a capture with no mark on it -- a silently mark-less PNG is the one failure that would waste the user's review round"

patterns-established:
  - "A script's header names the surface it must never touch (production mounting) and the surface it cannot reach (the browser tab), so a future editor does not 'fix' either absence"
  - "A forbidden API a source-level test greps for is named descriptively in prose, never literally, so the gate stays exact (07-03's own precedent, hit again here)"

requirements-completed: []

# Metrics
duration: ~35min
completed: 2026-09-23
---

# Phase 7 Plan 04: Brand boards and in-app review captures Summary

**One command renders a full brand board per concept and theme, a second mounts each concept in the real running app — rail, expanded sidebar, `/login`, `/setup`, both themes — by injecting the components' own markup at capture time, so BRAND-03's approval round has real context and production code has no idea any of it happened.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-23T00:47Z
- **Completed:** 2026-09-23T01:05Z (plus the capture run itself)
- **Tasks:** 2 (Task 1 a TDD cycle, RED committed before GREEN)
- **Files created:** 7; modified: 2
- **Artifacts produced:** 42 PNGs, 2.9 MB, all gitignored

## Execution mode: Docker `startStack`

The capture run used the **Docker `startStack()` path**, not attach mode. `tests/e2e/fixtures/stack.ts` built the workspace and booted Postgres, Redis, the API, the worker and the built web app with its own preseeded fixture admin; `stopStack` ran in a `finally` and `docker ps` afterwards shows no Noodara container and no Testcontainers reaper. `pnpm brand:review` exited 0 and reported 36 changed files.

## Accomplishments

- **The board carries every D-14 element and nothing it cannot honestly claim.** Header (concept name + `CONCEPT_META` meaning verbatim), the three lockups, a construction sheet with the monogram at 480 px over the real 24×24 grid plus the margin box, the baseline, the constants read from `geometry.ts` and the part names in DOM order, the 16/32/64/256 scale ladder, the favicon tile at 16 and 32 px on a light AND a dark simulated tab bar — each bar labelled "Simulated browser tab — verify the real tab manually" (Pitfall 2) — and the D-12 OG preview at 1200×630 shown at half size with the tagline.
- **The board draws nothing.** Every mark on it is `renderStaticSvg`/`tileSvg` output. `grep -c "<path" scripts/brand/board-html.ts` is 0; the only shapes the module assembles are the construction sheet's `<line>`/`<rect>` guides, which are a ruler over the mark, not part of it.
- **Four colour literals, asserted.** Strip the `<style>` elements and the only `#rrggbb` values left in the board's markup are the caller's `tile.background`/`tile.ink` and `og.canvas`/`og.ink` — a test enumerates them for both themes. Everything else is `var(--token)` over the verbatim tokens CSS, so the board is the design system rendering itself.
- **The review mechanism leaves no trace.** `git diff --quiet -- apps/web/src packages/ui/src` holds at the end of this plan. The mark reaches the app through `page.evaluate` + `insertAdjacentHTML` of the components' own output inside a `color: var(--ink)` wrapper; the page is reloaded between surfaces, so nothing persists even within a run.
- **36 in-app captures + 6 boards, reproducible.** `pnpm brand:boards && pnpm brand:review` regenerates the lot; `--concept b` narrows either to one concept for a D-16 adjustment round; `--mounted` skips injection so 07-07 can re-run the identical matrix against the real mount points.
- **No credential is ever printed or captured.** `/login` and `/setup` are shot first, on a fresh context, with every field empty (T-07-09); sign-in happens afterwards and the values go from the stack object straight into Playwright's `fill`. `grep -nE "console\.(log|error)\(.*(password|PASSWORD)"` prints 0, and `grep -cE "process\.env\.[A-Z_]+ (\?\?|\|\|) '"` prints 0 across every script in `scripts/brand/` (no literal env fallbacks, so attach mode can never silently point at a default URL or account).
- **31 new unit tests**, all green; the full unit suite is 141 files / 2391 tests, up from 2360.

## What the captures actually show

Read back with the image viewer, honestly reported — these are observations for the user's own judgement in 07-05, not changes made here:

- **`a/board-light.png`** — every section renders as intended. Concept A's monogram is dense: at 480 px the aperture ring reads clearly as a lens cut into the diagonal, and the grid sits visibly behind the mark.
- **`c/board-dark.png`** — dark theme correct throughout. One cosmetic note: the OG preview's canvas (`#161618`) is the dark board's own canvas, so the preview box reads as a hairline-bordered void rather than a distinct panel. Correct by D-12, just low-contrast against its own board.
- **`a/sidebar-rail-light-crop.png`** — the concept A monogram sits at the top of the 64 px rail, above Servers/Activity/Settings, at its real 24 px. It is unmistakably present and in the right slot. At that size the mark reads as a dense geometric block first and an N second; the aperture counter survives but is small.
- **`b/login-dark.png`** — the concept B lockup sits above the "Sign in" heading on the dark AuthCard, in light ink, with both fields empty. Concept B's monogram is the most delicate of the three at 24 px — noticeably lighter than the wordmark beside it.
- **`c/sidebar-expanded-dark-crop.png`** — the concept C lockup fits comfortably inside the 240 px expanded sidebar above the nav items.
- **Across every lockup and wordmark**, the final "a" of "noodara" sits a visible notch further from the "r" than the other letter pairs ("noodar a"). That is a `glyphs.ts`/advance-width matter from 07-01, not something this plan may touch; it is exactly the kind of thing D-16's adjustment rounds exist for, so it is flagged here for 07-05.

## Task Commits

1. **Task 1 RED: failing board/review-path tests** — `a22d2eb` (test)
2. **Task 1 GREEN: review-paths.ts + board-html.ts** — `a13db56` (feat)
3. **Task 2: the two Playwright scripts, root scripts, gitignore, README** — `d444187` (feat)

## Files Created/Modified

- `scripts/brand/review-paths.ts` — `REVIEW_ROOT` (from `import.meta.dirname`), `REVIEW_SURFACES`, `THEMES`, `ReviewSurface`/`Theme`, `reviewPngPath(concept, surface, theme, variant?)`.
- `scripts/brand/board-html.ts` — `BOARD_SCALES`, `BoardOptions`, `buildBoardHtml`. Pure; no I/O, no working-directory read, no geometry.
- `scripts/brand/render-boards.ts` — reads `tokens.css`, derives the four literal colours with `parseTokensCss`, renders each board in Chromium at `deviceScaleFactor: 2`, writes through `writeIfChanged`, prints the ledger. `--concept a|b|c`.
- `scripts/brand/capture-brand-review.ts` — stack or attach session, fresh context per concept, deterministic `data-theme` set by attribute, injection helpers, full-page and clipped screenshots, `--concept`, `--mounted`, `stopStack` in `finally`.
- `tests/unit/brand/review-paths.test.ts` (6 tests) and `tests/unit/brand/board-html.test.ts` (25 tests).
- `docs/brand/review/README.md` — what the folder is, what is produced, how to regenerate (Docker or attach mode), and the explicit statement that the browser-tab surface is a manual check.
- `package.json` — `brand:boards`, `brand:review`.
- `.gitignore` — `docs/brand/review/*` + `!docs/brand/review/README.md`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The npm scripts must pass `--tsconfig packages/ui/tsconfig.json`**
- **Found during:** Task 2, first real `pnpm brand:boards` run
- **Issue:** The plan specified `"brand:boards": "tsx scripts/brand/render-boards.ts"`. That throws `ReferenceError: React is not defined` inside `Logo.tsx`: tsx resolves a tsconfig from the working directory (the repo root has none) and, when pointed at one explicitly, only applies its `jsx` setting to files that tsconfig actually **covers**. `scripts/brand/tsconfig.json` includes only `scripts/brand/**/*.ts`, so `packages/ui/src/brand/*.tsx` fell through to esbuild's default classic (`React.createElement`) transform. Verified by running with `--tsconfig scripts/brand/tsconfig.json` and with a standalone tsconfig — both still failed — and confirmed against tsx's own docs (it respects `jsx`/`jsxImportSource` from the tsconfig in scope).
- **Fix:** Both scripts run as `tsx --tsconfig packages/ui/tsconfig.json scripts/brand/<script>.ts` — the config those components are genuinely compiled with (`jsx: react-jsx`), so `pnpm brand:boards` transforms them exactly as `pnpm build` does. Typechecking is unchanged: `pnpm typecheck` still runs `tsc -p scripts/brand/tsconfig.json`. Both script headers explain the flag so it is never "cleaned up".
- **Verification:** `pnpm brand:boards` writes six boards; `pnpm brand:review` writes 36 captures; `pnpm typecheck` and `pnpm lint` exit 0.
- **Files modified:** `package.json`, both script headers
- **Committed in:** `d444187`

**2. [Rule 1 - Bug] `parseTokensCss` keys carry no `--` prefix**
- **Found during:** Task 1 (writing the board test's fixture colours)
- **Issue:** The plan's action says to read `tokens.light['--accent-fill']`. `contrast.ts`'s `DECLARATION_RE` captures `--([a-z0-9-]+)`, so the parsed map is keyed `accent-fill`. Following the plan literally would have produced `undefined` colours, i.e. a board with an invisible favicon tile and an unreadable OG preview.
- **Fix:** `render-boards.ts` reads `accent-fill`/`on-accent`/`canvas`/`ink` and throws by name if a token is absent rather than rendering an empty CSS value.
- **Verification:** the six boards show the blue tile and the dark OG panel; the board test derives its own fixture the same way and asserts the exact four values appear.
- **Files modified:** `scripts/brand/render-boards.ts`, `tests/unit/brand/board-html.test.ts`
- **Committed in:** `a13db56`, `d444187`

**3. [Rule 1 - Bug] The construction sheet does not outline the mark with a stroke**
- **Found during:** Task 1
- **Issue:** The plan's action proposed rendering the monogram a second time with `fill="none" stroke="var(--ink-secondary)"` to outline each part. 07-01 and 07-03 both forbid any `stroke` on the mark (its outlines are filled, with the weight baked into the geometry), and the orchestrator restated that as a hard upstream fact.
- **Fix:** The construction sheet annotates instead of overdrawing: the real 24×24 grid, the `MARGIN` box, the `BASELINE` guide, the constants read from `geometry.ts`, and the part names in their real DOM order beside the mark. No stroke touches the monogram.
- **Verification:** `a/board-light.png` and `c/board-dark.png` read as construction sheets; the geometry tests' stroke-absence assertions are untouched.
- **Committed in:** `a13db56`

**4. [Rule 3 - Blocking] The no-`process.cwd` gate is literal, so the header names the API in prose**
- **Found during:** Task 1 GREEN
- **Issue:** `review-paths.ts`'s header explained that paths come from the module's location and never from `process.cwd()`. The acceptance criterion greps for that exact string, so the comment that forbids the construct was itself the file's only occurrence of it — the identical failure mode 07-03 hit with `dangerouslySetInnerHTML` and the barrel's exclusion note.
- **Fix:** The header names the forbidden API descriptively ("never from the process's working directory") and says why, citing the precedent.
- **Verification:** `grep -c "process.cwd" scripts/brand/review-paths.ts scripts/brand/board-html.ts` prints 0 for both.
- **Committed in:** `a13db56`

---

**Total deviations:** 4 (2 blocking, 2 bugs). All are inside this plan's own files; none change scope, and none touch production code.

## Issues Encountered

- **`pnpm test -- <path>` still does not filter** (STATE.md already records this). The plan's `<verify>` block uses that form; it runs the whole unit suite (141 files, 2391 tests, ~13 s) and exits 0. `pnpm exec vitest run tests/unit/brand/board-html.test.ts tests/unit/brand/review-paths.test.ts` was used for scoped iteration.
- **`git status --porcelain docs/brand/review` shows the whole directory as untracked until `README.md` is staged** — git collapses an entirely-untracked directory into one entry. Once the README is tracked, the same command lists only it, which is what the acceptance criterion describes.

## User Setup Required

None. Docker was already running and no new dependency was added — Playwright was already a devDependency and chromium was already installed.

## Next Phase Readiness

- **07-05 (approval) has everything it needs on disk right now:** `docs/brand/review/{a,b,c}/` holds six boards and 36 in-app captures. The one surface the user must check outside these files is the **favicon in the real browser tab** — Playwright cannot capture it, the board says so on both tab strips, and the README repeats it.
- **07-05 must also decide what "approved" copies.** The captures are deliberately ignored by git; the approval plan copies the chosen concept's files into `docs/brand/approved/` and records the choice in `docs/brand/APPROVAL.md` (D-17). `DEFAULT_CONCEPT` stays `'a'` until then.
- **07-07 inherits `--mounted`.** Once `Sidebar.tsx` and `AuthCard.tsx` mount the real components, `pnpm brand:review --mounted` produces the same 36-file matrix from the app's own markup, with no injection — the before/after proof that the mount is faithful.
- **A D-16 adjustment round is two commands and one flag:** retune `geometry.ts`, then `pnpm brand:boards -- --concept X && pnpm brand:review -- --concept X`. The wordmark's final-"a" spacing noted above is the first candidate.
- **BRAND-03 is NOT complete after this plan** (`requirements-completed: []`, matching 07-01/07-02/07-03). This plan builds the review package; the requirement is satisfied only when the user has actually seen it and approved a concept in 07-05.

## Self-Check: PASSED

- All seven created files and both modified files exist on disk; `docs/brand/review/{a,b,c}/board-{light,dark}.png` is 6 files, `docs/brand/review/*/{sidebar-expanded,sidebar-rail,login,setup}-{light,dark}.png` is 24, and `*-crop.png` is 12.
- Commits `a22d2eb`, `a13db56`, `d444187` are all in `git log`, RED before GREEN.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (141 files / 2391 tests), `pnpm exec vitest run tests/unit/brand/{board-html,review-paths}.test.ts`, `pnpm brand:boards` and `pnpm brand:review` all exit 0.
- `git check-ignore -q docs/brand/review/a/board-light.png` succeeds; `git status --porcelain docs/brand/review` lists only `README.md`; `git diff --quiet -- apps/web/src packages/ui/src` succeeds; `docker ps` shows no Noodara container.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-23*
