---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 06
subsystem: site-honesty-guards
tags: [content-rules, scope-of-record, mdx-components, d-10, site-01]

requires:
  - phase: 10-05
    provides: "apps/site/src/mdx-components.tsx (getMDXComponents merge point); Fumadocs docs route and content tree apps/site/content/docs can extend"
  - phase: 10-02
    provides: "apps/site global.css token mapping (--hairline, --r-lg, --status-* etc.) ScopeTable's cell/border styles reuse"
provides:
  - "apps/site/src/lib/content-rules.ts: findForbiddenWording (coming-soon/soon/roadmap/dates/planning-ids) and findUnsafeMarkup (script/iframe/javascript:/dangerouslySetInnerHTML), pure, no I/O"
  - "apps/site/src/content/scope.ts: DELIVERED_CAPABILITIES and SCOPE_EXCLUSIONS, the single typed source of what the site may claim and what it must state as a limit, plus findExcludedTerms"
  - "apps/site/src/components/mdx/ScopeNote.tsx and ScopeTable.tsx, registered in mdx-components.tsx: render limits/claims from scope.ts inside MDX pages"
affects: [10-08, 10-09, 10-10, 10-11]

tech-stack:
  added: []
  patterns:
    - "scope.ts is the ONLY place the site's claims (DELIVERED_CAPABILITIES) and limits (SCOPE_EXCLUSIONS) are written; every consumer (ScopeNote, ScopeTable, and the future landing/Scope page in 10-08/10-10/10-11) imports from it instead of hand-typing copy, so tests/unit/site/landing-claims.test.ts is the only place that needs to re-verify PROJECT.md alignment"
    - "content-rules.ts is pure and I/O-free; the repo-wide scan (tests/unit/site/forbidden-words.test.ts) owns reading files from disk and applying the rules, mirroring scripts/check-ui-safety.mjs's own 'scan function separate from the CLI/test caller' shape"
    - "findExcludedTerms's case rule: a term counts as 'short all-caps' (case-sensitive whole-word match) only when it is <=5 chars and entirely A-Z (AI, TLS, SSO, RBAC, HTTPS); every other term matches case-insensitively as a whole word -- this is what keeps 'AI' from false-positiving on 'AIX'"

key-files:
  created:
    - apps/site/src/lib/content-rules.ts
    - apps/site/src/lib/content-rules.test.ts
    - tests/unit/site/forbidden-words.test.ts
    - apps/site/src/content/scope.ts
    - tests/unit/site/landing-claims.test.ts
    - apps/site/src/components/mdx/ScopeNote.tsx
    - apps/site/src/components/mdx/ScopeTable.tsx
    - apps/site/src/components/mdx/ScopeTable.test.tsx
  modified:
    - apps/site/src/mdx-components.tsx
    - scripts/check-ui-safety.mjs
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/deferred-items.md

key-decisions:
  - "scripts/check-ui-safety.mjs's dangerouslySetInnerHTML gate now excludes apps/site/src/lib/content-rules.ts and its test file from the scan by relative path (DANGEROUSLY_SET_INNER_HTML_SCAN_EXCLUDE), rather than adding them to the render-site allowlist: findUnsafeMarkup's own detection rule and its fixture test both contain the literal string 'dangerouslySetInnerHTML' as *data* (the pattern to detect), never as a rendered prop, and the existing allowlist gate asserts an exact total of 2 with one occurrence per app root layout -- adding these files there would have broken that invariant instead of fixing the false positive."
  - "SCOPE_EXCLUSIONS' domains-tls and app-config entries deliberately share one PROJECT.md projectAnchor ('Dominios, reverse proxy (Traefik), TLS, env vars y secrets de aplicación'): PROJECT.md's own Out of Scope bullet bundles both concerns in one line, and the plan's own <interfaces> block lists exactly 7 anchors for 8 exclusions, so reuse was expected rather than a gap."
  - "DELIVERED_CAPABILITIES has 9 entries, one per plan-specified id (install, connect-ssh, fingerprint-trust, discovery, server-detail, activity-log, appearance, account, upgrade-rollback), each evidence path read straight off the plan's own <read_first>/<action> evidence list -- no capability or evidence path was invented beyond what the plan named."

requirements-completed: []

duration: 10min
completed: 2026-09-28
---

# Phase 10 Plan 06: Content honesty guards -- wording rules, claims/limits source of truth, ScopeNote/ScopeTable Summary

**D-10's forbidden-wording/unsafe-markup scanner, SITE-01's single typed source of claimed capabilities and stated limits anchored to PROJECT.md's own Out of Scope text, and the ScopeNote/ScopeTable MDX components that render limits from it -- all built and tested before any bulk landing/docs content exists.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-09-27T23:49:00-06:00
- **Completed:** 2026-09-27T23:55:07-06:00
- **Tasks:** 3 completed
- **Files modified:** 11 (8 created, 3 modified)

## Accomplishments

- `apps/site/src/lib/content-rules.ts` exports `findForbiddenWording` (7 rules: coming-soon, soon, roadmap, date-year, date-iso, date-month-day, planning-id x3 sub-patterns) and `findUnsafeMarkup` (script/iframe/javascript:/dangerouslySetInnerHTML, fenced-code-block-aware) -- both pure, both proven against 17 fixture tests plus a real repo-wide scan (`tests/unit/site/forbidden-words.test.ts`) over every file under `apps/site/content`, `apps/site/src/content`, and non-test `.tsx` under `apps/site/src/components`/`apps/site/src/app`.
- `apps/site/src/content/scope.ts` is now the one typed source of the site's claims (`DELIVERED_CAPABILITIES`, 9 entries, each with real on-disk evidence) and limits (`SCOPE_EXCLUSIONS`, 8 entries, 5 `showOnLanding`), anchored to `.planning/PROJECT.md`'s own "Out of Scope" section/"Fuera de v0.2" line by `tests/unit/site/landing-claims.test.ts` -- 8 tests covering anchor verbatim-substring checks, evidence-exists-on-disk checks, statement wording checks (starts with "Noodara", present tense, zero forbidden wording), `findExcludedTerms` whole-word/case-aware matching, and id uniqueness.
- `apps/site/src/components/mdx/ScopeTable.tsx` (semantic `<table>`, `Included`/`Not included` columns, token-only styling) and `ScopeNote.tsx` (Fumadocs `Callout` wrapping one exclusion's statement plus a link to `/docs/reference/scope`) both render directly from `scope.ts` and are registered in `getMDXComponents`, so an MDX page can drop `<ScopeNote id="domains-tls" />` or `<ScopeTable />` without hand-typing any claim or limit.
- Real `pnpm --filter @noodara/site build`, `typecheck`, `lint`, `pnpm check:ui-safety`, `pnpm boundaries`, and the full repo `pnpm vitest run` (3150/3150) all pass after this plan.

## Task Commits

1. **Task 1: Content wording and markup rules (D-10) with a repo-wide scan** -- `b983cdd` (test, RED) -> `e38674e` (feat, GREEN)
2. **Task 2: Single source of truth for claims and limits, anchored to PROJECT.md** -- `c6cc220` (test, RED) -> `414e5f0` (feat, GREEN)
3. **Task 3: ScopeNote and ScopeTable MDX components** -- `d4380f1` (test, RED) -> `bc67ae7` (feat, GREEN, includes the ui-safety gate fix and the lint fixes discovered while verifying)

## Files Created/Modified

- `apps/site/src/lib/content-rules.ts` -- `findForbiddenWording`, `findUnsafeMarkup`
- `apps/site/src/lib/content-rules.test.ts` -- 17 fixture tests
- `tests/unit/site/forbidden-words.test.ts` -- repo-wide scan, 2 tests
- `apps/site/src/content/scope.ts` -- `DELIVERED_CAPABILITIES`, `SCOPE_EXCLUSIONS`, `findExcludedTerms`, `CapabilityId`/`ExclusionId`
- `tests/unit/site/landing-claims.test.ts` -- 8 tests anchoring scope.ts to PROJECT.md
- `apps/site/src/components/mdx/ScopeNote.tsx`, `ScopeTable.tsx`, `ScopeTable.test.tsx` -- 5 tests
- `apps/site/src/mdx-components.tsx` -- registers `ScopeNote`/`ScopeTable`
- `scripts/check-ui-safety.mjs` -- `DANGEROUSLY_SET_INNER_HTML_SCAN_EXCLUDE` (see Deviations)
- `.planning/phases/10-sitio-de-docs-y-landing-p-blica/deferred-items.md` -- logged one pre-existing, out-of-scope lint issue found while verifying

## Decisions Made

See `key-decisions` in frontmatter: the `check-ui-safety.mjs` scan-exclude fix, the shared `domains-tls`/`app-config` `projectAnchor`, and the 9-entry `DELIVERED_CAPABILITIES` list taken verbatim from the plan's own text.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] `pnpm check:ui-safety`'s `dangerouslySetInnerHTML` gate false-positived on `content-rules.ts`/`content-rules.test.ts`**
- **Found during:** Task 3's verify step, `pnpm check:ui-safety` after all three tasks' code existed
- **Issue:** `findUnsafeMarkup`'s own rule table contains the literal regex `/dangerouslySetInnerHTML/g` (real code, needed to detect that pattern in MDX content), and its fixture test contains the same literal as test data. `scripts/check-ui-safety.mjs`'s existing gate (added in phase 10-02) counts every occurrence of that literal string repo-wide and asserts the total is exactly 2, one per app root layout -- these two new files pushed the total to 5 and both were flagged as unlisted offenders.
- **Fix:** Added `DANGEROUSLY_SET_INNER_HTML_SCAN_EXCLUDE`, a small path set the scanner skips before counting, holding only `apps/site/src/lib/content-rules.ts` and its test file, with a comment explaining these are detection data, never a rendered prop. Left the existing `DANGEROUSLY_SET_INNER_HTML_ALLOWLIST` (which asserts exactly 2, one per layout) untouched, since adding these files there would have broken that exact-count invariant instead of fixing the false positive.
- **Files modified:** `scripts/check-ui-safety.mjs`
- **Verification:** `pnpm check:ui-safety` passes (`count=2`, unchanged from before this plan); `pnpm vitest run tests/unit/scripts/check-ui-safety.test.ts` still 19/19 (those tests construct their own in-memory file maps and were unaffected).
- **Committed in:** `bc67ae7` (Task 3 commit)

**2. [Rule 1 - Bug] Four ESLint errors in `content-rules.ts` and one in `ScopeTable.test.tsx`, surfaced by `pnpm --filter @noodara/site lint`**
- **Found during:** Task 3's verify step
- **Issue:** `@typescript-eslint/array-type` rejected `ReadonlyArray<T>` (repo convention: `readonly T[]`); `@typescript-eslint/no-unnecessary-condition` flagged `match.index ?? 0` (the resolved type of `RegExpMatchArray['index']` in this repo's lib/tsconfig is never `undefined` for a `matchAll` result) in two places in `content-rules.ts`, and `document.body.textContent ?? ''` in `ScopeTable.test.tsx` for the same reason.
- **Fix:** `ReadonlyArray<{...}>` -> `readonly {...}[]` (both rule tables); `match.index ?? 0` -> `match.index` (both call sites); `document.body.textContent ?? ''` -> `document.body.textContent` (the `text` variable stays typed `string` under this tsconfig).
- **Files modified:** `apps/site/src/lib/content-rules.ts`, `apps/site/src/components/mdx/ScopeTable.test.tsx`
- **Verification:** `pnpm --filter @noodara/site lint` and `pnpm --filter @noodara/site typecheck` both exit 0; `pnpm vitest run apps/site/src/lib/content-rules.test.ts apps/site/src/components/mdx` still 22/22 pass after the rewrite.
- **Committed in:** `bc67ae7` (Task 3 commit, alongside the Task 3 files it was discovered while verifying)

**3. [Rule 1 - Bug] Self-defeating comment in `ScopeTable.tsx`'s own file header tripped its own acceptance-criteria grep**
- **Found during:** Running the Task 3 acceptance-criteria grep for hex colors / `shadow`
- **Issue:** The header comment originally read "...no shadow, no hex (checked by an acceptance-criteria grep)" -- the word "shadow" in that sentence is itself a match for the literal grep meant to prove the file has none, the same class of self-defeating-comment bug 10-02's and 10-05's own SUMMARYs already logged.
- **Fix:** Reworded to "...flat surface, no raw color literal..." -- same meaning, no longer self-matching.
- **Files modified:** `apps/site/src/components/mdx/ScopeTable.tsx`
- **Verification:** `grep -cE "#[0-9a-fA-F]{3,8}\b|shadow" apps/site/src/components/mdx/ScopeTable.tsx apps/site/src/components/mdx/ScopeNote.tsx` returns 0 for both files.
- **Committed in:** `bc67ae7` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bugs). No deviation touched anything outside this plan's own file list plus the one pre-existing `check-ui-safety.mjs` gate it had to extend; none broke an intermediate committed state (all found and fixed before Task 3's own commit).

## Acceptance-Criteria Demonstrations (recorded, then reverted)

- **Task 1:** Temporarily appended `Domains are coming soon.` to `apps/site/content/docs/index.mdx` and re-ran `pnpm vitest run tests/unit/site/forbidden-words.test.ts`: failed with two findings (`coming-soon` at index 1030, `soon` at index 1037) on that exact file, as required. Reverted with `git checkout -- apps/site/content/docs/index.mdx`; `git status --short` confirmed the file was clean again before continuing.
- **Task 2:** Temporarily changed the `domains-tls` exclusion's `projectAnchor` to `'this text does not exist in PROJECT.md'` and re-ran `pnpm vitest run tests/unit/site/landing-claims.test.ts`: failed with `"domains-tls".projectAnchor "this text does not exist in PROJECT.md" not found in PROJECT.md: expected false to be true`, as required. Reverted the line back to `'Dominios, reverse proxy (Traefik), TLS, env vars y secrets de aplicación'`; the full 8/8 landing-claims suite passed again afterward.

## Self-Check: PASSED

All 11 created/modified files listed in `key-files` confirmed present on disk; all 6 task commit hashes (`b983cdd`, `e38674e`, `c6cc220`, `414e5f0`, `d4380f1`, `bc67ae7`) confirmed present in `git log`.
