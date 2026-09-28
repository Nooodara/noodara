---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 09
subsystem: ui
tags: [site-facts, landing, svg-diagram, screenshot-frame, brand-geometry, react, next-static-export]

requires:
  - phase: 10-02
    provides: build-info.ts (assetPath/readBuildInfo), site theme classes (.site-shot-light/.site-shot-dark)
  - phase: 10-06
    provides: scope.ts (DELIVERED_CAPABILITIES claims)
  - phase: 10-08
    provides: apps/site/content/docs/getting-started/install.mdx (single source of the install command text)
provides:
  - apps/site/src/lib/site-facts.ts (INSTALL_COMMAND, INSTALL_SCRIPT_URL, GITHUB_URL, APPROVED_SCREENS)
  - InstallCommand, ScreenshotFrame, PillarCard, HowItWorksDiagram landing components
affects: [10-11 (landing composition), 10-12 (human screenshot checkpoint)]

tech-stack:
  added: []
  patterns:
    - "site-facts.ts derives the install command/GitHub URL from install.sh's own NOODARA_REPO_OWNER/NOODARA_REPO_NAME defaults, never hand-typed"
    - "ScreenshotFrame renders both light and dark <img> always; global.css's [data-theme] rules pick the visible one, not prefers-color-scheme"
    - "HowItWorksDiagram draws on the brand kit's 24-unit grid / 3-unit stroke (geometry.ts constants mirrored, not imported) and reuses <Logo/> for the third node; captions are HTML text, never SVG <text>"

key-files:
  created:
    - apps/site/src/lib/site-facts.ts
    - tests/unit/site/site-facts.test.ts
    - apps/site/src/components/landing/InstallCommand.tsx
    - apps/site/src/components/landing/ScreenshotFrame.tsx
    - apps/site/src/components/landing/PillarCard.tsx
    - apps/site/src/components/landing/HowItWorksDiagram.tsx
    - apps/site/src/components/landing/landing-parts.test.tsx
  modified: []

key-decisions:
  - "INSTALL_SCRIPT_URL/GITHUB_URL are built from two small constants (REPO_OWNER/REPO_NAME) rather than parsing install.sh at runtime, keeping site-facts.ts a pure, zero-I/O module; the test file does the parsing/diffing against install.sh so the two can never silently drift"
  - "InstallCommand mounts its own local TooltipProvider (apps/site has no app-wide one, unlike apps/web) so CopyButton's confirmation tooltip has an ancestor"
  - "HowItWorksDiagram's captions render as ordinary <p> text below the SVG, not as SVG <text>, so they inherit the site's own type system instead of a fixed SVG font size"

requirements-completed: [SITE-01, SITE-03]

duration: 55min
completed: 2026-09-28
---

# Phase 10 Plan 09: Landing building blocks (install command, screenshot frame, pillar card, how-it-works diagram) Summary

Built the four presentational landing components (InstallCommand, ScreenshotFrame, PillarCard, HowItWorksDiagram) plus the `site-facts.ts` module that ties the install command and GitHub URL to `install.sh`'s own owner/repo defaults, so plan 10-11 only has to compose them.

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-09-28
- **Tasks:** 2/2 completed
- **Files modified:** 7 created

## Accomplishments

- `site-facts.ts` exports `INSTALL_COMMAND`, `INSTALL_SCRIPT_URL`, `GITHUB_URL` and `APPROVED_SCREENS`, tested against `install.sh`'s `NOODARA_REPO_OWNER`/`NOODARA_REPO_NAME` defaults, `README.md` and the Install docs MDX page (D-01, T-10-12).
- `InstallCommand` renders the exact install string in a `<code>` with an accessible "Copy install command" button and a "Download, read, run" link into the no-pipe install instructions.
- `ScreenshotFrame` renders theme-following light/dark captures from the approved set only, flat (hairline border, `--r-lg`, no shadow), matching D-17.
- `PillarCard` reads its claim text straight from `DELIVERED_CAPABILITIES` by id (D-02) and composes a `ScreenshotFrame`.
- `HowItWorksDiagram` is a hand-drawn inline SVG (brand-kit 24-unit grid / 3-unit stroke, `currentColor` only) with the three D-05 captions as HTML text, reusing `<Logo />` for the "discovers" step.

## Task Commits

1. **Task 1: Site facts tied to install.sh and README** — RED `fbe2a7c`, GREEN `ab11f3b`
2. **Task 2: InstallCommand, ScreenshotFrame, PillarCard and HowItWorksDiagram** — RED `6908080`, GREEN `26792b5`

_TDD: each task followed RED (failing test committed first) → GREEN (implementation committed second)._

## Files Created/Modified

- `apps/site/src/lib/site-facts.ts` — INSTALL_COMMAND/INSTALL_SCRIPT_URL/GITHUB_URL/APPROVED_SCREENS, `ApprovedScreen` type
- `tests/unit/site/site-facts.test.ts` — asserts the constants against install.sh, README.md and install.mdx, and that every approved screen has both theme PNGs on disk
- `apps/site/src/components/landing/InstallCommand.tsx` — copyable install command block
- `apps/site/src/components/landing/ScreenshotFrame.tsx` — flat theme-following capture `<figure>`
- `apps/site/src/components/landing/PillarCard.tsx` — heading + scope.ts claim + ScreenshotFrame
- `apps/site/src/components/landing/HowItWorksDiagram.tsx` — three-step inline SVG diagram
- `apps/site/src/components/landing/landing-parts.test.tsx` — 10 tests covering all four components' `must_haves.truths`

## Deviations from Plan

None — plan executed exactly as written. One phrasing adjustment: `ScreenshotFrame.tsx`'s header comment originally used the literal substrings "shadow" and "next/image" in prose, which the plan's own acceptance-criteria grep (`grep -rnE "shadow|...|font-bold|..."` and `grep -rc "next/image"`) would have flagged as a false positive; reworded to "no drop elevation" / "Next.js image optimisation component" with identical meaning (Rule 1 — the grep is a mechanical proxy for the real rule "no shadow utility class, no next/image import", and a comment mentioning the word is not an occurrence of either).

## Known Stubs

None — every component renders real data (site-facts constants, scope.ts claims, the approved screenshot set) with no hardcoded empty/placeholder values. None of these components are yet mounted on a page; that composition is plan 10-11's job, noted in the plan's own objective.

## Threat Flags

None — all three threat register entries (T-10-12, T-10-05, T-10-04) are mitigated exactly as planned: `INSTALL_COMMAND` is asserted against install.sh/README by test, screenshots only ever come from `assetPath('/screenshots/...')` against the approved set, and `PillarCard`'s claim text is read from `DELIVERED_CAPABILITIES` by id.

## Verification

- `pnpm vitest run tests/unit/site/site-facts.test.ts` — 7 passed
- `pnpm vitest run apps/site/src/components/landing/landing-parts.test.tsx` — 10 passed
- `pnpm vitest run apps/site tests/unit/site` — 164 passed
- `pnpm vitest run` (full repo) — 3194 passed
- `pnpm --filter @noodara/site typecheck` — clean
- `pnpm --filter @noodara/site lint` — clean
- `pnpm typecheck` / `pnpm lint` (full repo) — clean
- `pnpm check:ui-safety` — all gates OK
- `pnpm boundaries` — no issues
- `pnpm --filter @noodara/site build` — succeeded (sync-site-assets idempotent, Next.js build, check-export: 13 files, zero third-party assets)
- Acceptance-criteria greps: `grep -c "nooodara/noodara" site-facts.ts` = 1; shadow/hex/font-weight scan across `landing/*.tsx` = 0; `next/image` scan = 0; `<image` in HowItWorksDiagram.tsx = 0

## Self-Check: PASSED

- FOUND: apps/site/src/lib/site-facts.ts
- FOUND: tests/unit/site/site-facts.test.ts
- FOUND: apps/site/src/components/landing/InstallCommand.tsx
- FOUND: apps/site/src/components/landing/ScreenshotFrame.tsx
- FOUND: apps/site/src/components/landing/PillarCard.tsx
- FOUND: apps/site/src/components/landing/HowItWorksDiagram.tsx
- FOUND: apps/site/src/components/landing/landing-parts.test.tsx
- FOUND commit fbe2a7c, ab11f3b, 6908080, 26792b5 in `git log --oneline --all`
