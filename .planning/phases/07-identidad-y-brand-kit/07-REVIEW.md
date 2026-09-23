---
phase: 07-identidad-y-brand-kit
reviewed: 2026-09-22T00:00:00Z
depth: standard
files_reviewed: 47
files_reviewed_list:
  - .github/workflows/ci.yml
  - apps/web/package.json
  - apps/web/scripts/sync-brand-assets.mjs
  - apps/web/src/app/brand-colors.json
  - apps/web/src/app/layout.tsx
  - apps/web/src/app/manifest.ts
  - apps/web/src/components/AuthCard.test.tsx
  - apps/web/src/components/AuthCard.tsx
  - apps/web/src/components/Sidebar.test.tsx
  - apps/web/src/components/Sidebar.tsx
  - apps/web/src/proxy.ts
  - docs/adr/0000-package-legitimacy-approvals.md
  - docs/brand/APPROVAL.md
  - docs/brand/BRAND.md
  - docs/brand/approved/README.md
  - docs/brand/review/README.md
  - docs/ui-review-07-brand.md
  - packages/ui/brand/brand-colors.json
  - packages/ui/package.json
  - packages/ui/src/brand/Lockup.test.tsx
  - packages/ui/src/brand/Lockup.tsx
  - packages/ui/src/brand/Logo.test.tsx
  - packages/ui/src/brand/Logo.tsx
  - packages/ui/src/brand/Wordmark.test.tsx
  - packages/ui/src/brand/Wordmark.tsx
  - packages/ui/src/brand/concepts/a.ts
  - packages/ui/src/brand/concepts/b.ts
  - packages/ui/src/brand/concepts/c.ts
  - packages/ui/src/brand/geometry.test.ts
  - packages/ui/src/brand/geometry.ts
  - packages/ui/src/brand/glyphs.ts
  - packages/ui/src/brand/static-svg.test.ts
  - packages/ui/src/brand/static-svg.ts
  - packages/ui/src/index.ts
  - scripts/brand/asset-manifest.ts
  - scripts/brand/board-html.ts
  - scripts/brand/capture-brand-review.ts
  - scripts/brand/construction-sheet.ts
  - scripts/brand/generate-brand-assets.ts
  - scripts/brand/raster.ts
  - scripts/brand/render-boards.ts
  - scripts/brand/review-paths.ts
  - scripts/brand/tsconfig.json
  - scripts/brand/write-if-changed.ts
  - scripts/check-package-provenance.mjs
  - tests/e2e/brand.spec.ts
  - tests/unit/brand/approval-record.test.ts
  - tests/unit/brand/asset-manifest.test.ts
  - tests/unit/brand/board-html.test.ts
  - tests/unit/brand/brand-assets-accuracy.test.ts
  - tests/unit/brand/construction-sheet.test.ts
  - tests/unit/brand/favicon-files-present.test.ts
  - tests/unit/brand/package-exports-resolvable.test.ts
  - tests/unit/brand/raster.test.ts
  - tests/unit/brand/review-paths.test.ts
  - tests/unit/brand/sync-brand-assets.test.ts
  - tests/unit/docs/brand-kit-structure.test.ts
  - tests/unit/docs/install-docs-accuracy.test.ts
  - tests/unit/scripts/vitest-gate-config.test.ts
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 07: Code Review Report

**Reviewed:** 2026-09-22
**Depth:** standard
**Files Reviewed:** 47 (plus the generated binaries/SVGs excluded per the review config, which are
byte-locked by `tests/unit/brand/brand-assets-accuracy.test.ts` and were not separately inspected)
**Status:** issues_found

## Summary

This phase adds the Noodara brand geometry, the React/static-export render paths, the raster/SVG
generation pipeline, the review/board tooling, and the mount points on `Sidebar`/`AuthCard`,
`manifest.ts` and `layout.tsx`. The core geometry module (`geometry.ts`, `glyphs.ts`,
`concepts/*.ts`) and its test suite (`geometry.test.ts`) are unusually rigorous — the tests parse
real SVG path commands into points/arcs/scanlines and assert against measured geometry rather than
restating the implementation, which is exactly the kind of test that pins real behaviour. The
asset pipeline (`asset-manifest.ts`, `raster.ts`, `write-if-changed.ts`, `generate-brand-assets.ts`,
`sync-brand-assets.mjs`) is disciplined about idempotence, allowlisting and never deleting, and this
holds up under direct reading. No critical/blocker-level defect (injection, secret leak, auth
bypass with a currently-reachable route, crash, data loss) was found.

The issues below are all quality/robustness findings: a latent authorization-adjacent regex flaw in
`apps/web/src/proxy.ts` that has no currently-exploitable route but is architecturally fragile,
duplicated fragile regex-extraction logic across three files in the static-export pipeline, a
missing HTTP timeout in an existing supply-chain script that is part of this review's file list, and
a few minor DRY/consistency nits.

## Warnings

### WR-01: `proxy.ts` matcher exclusion list is unanchored and contains an unescaped regex metacharacter

**File:** `apps/web/src/proxy.ts:68-70`

**Issue:** The middleware matcher is:

```ts
matcher: [
  '/((?!api|_next/static|_next/image|favicon.ico|icon.svg|icon1.png|icon2.png|apple-icon.png|opengraph-image.png|manifest.webmanifest|login|setup).*)',
],
```

Two problems compound here:

1. **Prefix matching, not path-segment matching.** The negative lookahead only checks that the
   remaining path does not *start with* one of the listed literals — it never requires the next
   character to be `/`, `?`, or end-of-string. Any future route whose name merely shares a prefix
   with an excluded entry silently skips `proxy()` entirely (no session check, no redirect), e.g. a
   future `/apikeys` page (shares the `api` prefix), `/setup-wizard`, `/login-history`, or
   `/icon1.png-download`. Today no such route exists, so there is no live exploit — but the very
   next page added under one of these prefixes bypasses the auth redirect with no test or lint that
   would catch it, and the failure mode is silent (the page renders instead of erroring).
2. **Unescaped `.` in `favicon.ico`, `icon.svg`, `apple-icon.png`, `opengraph-image.png`, and
   `manifest.webmanifest`.** In a regex, `.` matches any character, so e.g. `faviconXico` would also
   satisfy the exclusion. Low practical risk today (no such route exists), but it is exactly the
   kind of copy-pasted-from-the-docs pattern that silently drifts wrong.

The code comment above this block correctly notes the real authorization boundary is
`requireSession` on the control plane, so this is UX-only — but that is precisely why it is easy for
this matcher to bit-rot unnoticed: nothing except a human reading the regex will catch a bypass here
before it results in an authenticated-looking page flashing content behind an unauthenticated
request (the API calls the page makes will still 401, but the shell/layout renders).

**Fix:** Anchor every literal to a path boundary and escape the dots, e.g.:

```ts
matcher: [
  '/((?!api(?:/|$)|_next/static|_next/image|favicon\\.ico$|icon\\.svg$|icon1\\.png$|icon2\\.png$|apple-icon\\.png$|opengraph-image\\.png$|manifest\\.webmanifest$|login(?:/|$)|setup(?:/|$)).*)',
],
```

or, more robustly, list the exact reserved filenames in a small array and build the exclusion
pattern from it with `RegExp.escape`-style quoting, so a future addition can't reintroduce the same
class of bug.

### WR-02: Monogram-group extraction regex is duplicated three times with the same fragility

**Files:**
`packages/ui/src/brand/static-svg.ts:75` (`MONOGRAM_GROUP_RE`),
`scripts/brand/asset-manifest.ts:198-209` (`extractLockupGroup`),
`scripts/brand/construction-sheet.ts:158` (`MONOGRAM_GROUP_RE`)

**Issue:** All three independently implement "pull `<g data-part="monogram">...</g>` (or
`wordmark`) out of a rendered string with a non-greedy regex, on the documented assumption that
`Logo`/`Lockup` never nests a `<g>` inside that group." That assumption is currently true, but it is
now encoded in three separate places instead of one. If a future change to `Logo.tsx`/`Lockup.tsx`
(e.g. Phase 8's animation work, explicitly referenced in these files' own comments) ever nests a
`<g>` inside the monogram group, all three call sites break simultaneously and silently — each
would extract only up to the *first* inner closing tag, producing a truncated group with no error
(the `if (match === null)` guard only catches a *missing* match, not a *wrong* one). A fix or a new
invariant must then be applied and re-verified in three files rather than one.

**Fix:** Extract one shared helper (e.g. `extractPartGroup(markup: string, part: string): string`)
in `static-svg.ts` — the module that already owns the render path and the "no nested group" contract
— and have `asset-manifest.ts` and `construction-sheet.ts` import it instead of re-declaring the
regex.

### WR-03: `check-package-provenance.mjs`'s registry-API fallback has no timeout

**File:** `scripts/check-package-provenance.mjs:323-326`

**Issue:** Both `execFileSync` calls in this file (`enumerateLockedDependencies`,
`resolvePackageProvenance`'s `npm view` call) set an explicit `timeout: 30_000`, with comments
explicitly citing this as a deliberate "must fail fast, not hang the CI job" design choice. The
registry-API fallback a few lines later does not:

```js
const response = await fetch(
  `https://registry.npmjs.org/${encodedName}`,
);
```

This has no `AbortSignal.timeout(...)` at all. An unresponsive or slow `registry.npmjs.org` (the
exact failure mode the `npm view` timeout exists to guard against) can hang this call indefinitely,
bounded only by the CI `security` job's outer 40-minute `timeout-minutes` backstop — burning the
whole job's budget instead of failing this one dependency check promptly with an actionable message,
the way every other remote call in this file does. CLAUDE.md §2.3 states timeouts are required on
"toda operación remota ... HTTP" without exception.

**Fix:**

```js
const response = await fetch(`https://registry.npmjs.org/${encodedName}`, {
  signal: AbortSignal.timeout(30_000),
});
```

## Info

### IN-01: `ogSvg()` doesn't use the project's own byte-stable number formatter

**File:** `scripts/brand/asset-manifest.ts:240-246`

**Issue:** Every other numeric value emitted anywhere in the brand pipeline (`geometry.ts`'s `fmt`,
`static-svg.ts`'s `tileSvg`, `construction-sheet.ts`, `board-html.ts`'s `sized()`) is passed through
`fmt()`, explicitly documented as existing so "`renderToStaticMarkup` produces identical bytes on
every machine" and output is capped at three decimals. `ogSvg()` instead uses bare `String(...)` for
`OG_LOCKUP_X`, `OG_LOCKUP_Y`, and the computed `scale` value:

```ts
`<g transform="translate(${String(OG_LOCKUP_X)} ${String(OG_LOCKUP_Y)}) scale(${String(scale)})" ...`
```

`scale = OG_LOCKUP_WIDTH / layout.width` is a non-integer (e.g. ~4.698813885...) and `String()` on it
will emit the full double-precision decimal expansion rather than the three-decimal, byte-stable
form every sibling module commits to. This is not a determinism bug (JS `Number#toString` is
spec-deterministic across engines), but it is an inconsistency with a design invariant this codebase
otherwise treats as load-bearing, and it produces a needlessly long, harder-to-diff value in the
committed `og-image.png`'s intermediate SVG.

**Fix:** Route `scale`, `OG_LOCKUP_X`, and `OG_LOCKUP_Y` through `fmt()` like every other coordinate
in this file.

### IN-02: `parseConcepts()` is duplicated verbatim between two CLI scripts

**Files:** `scripts/brand/render-boards.ts:46-54`, `scripts/brand/capture-brand-review.ts:102-110`

**Issue:** Both scripts declare an identical `--concept` argv parser, differing only in the
script-name string used in the thrown error message. This is a straightforward DRY violation between
two files that already share other infrastructure (`review-paths.ts`, `write-if-changed.ts`).

**Fix:** Move `parseConcepts` into `review-paths.ts` (which both already import) parameterised by a
caller name, or into a small shared `cli-args.ts` module under `scripts/brand/`.

### IN-03: `TILE_RADIUS_RATIO = 10 / 44` is independently redeclared in three places

**Files:** `scripts/brand/board-html.ts:52`, `scripts/brand/asset-manifest.ts:109`,
`packages/ui/src/brand/static-svg.test.ts:41`

**Issue:** The same magic ratio (documented as "`--r-md` (10px) on a 44px control") is declared as a
private constant three separate times instead of being exported once from `static-svg.ts` (the
module whose `tileSvg` actually consumes it as a parameter) or from `geometry.ts`. Low risk today
since the value is stable and each occurrence carries the same explanatory comment, but a future
`--r-md` retune has three places to update in lockstep with no test enforcing they stay equal (the
asset-manifest and board-html copies could drift from each other without any committed asset
changing, since both currently produce the same number).

**Fix:** Export a single named constant (e.g. from `static-svg.ts`) and import it everywhere else.

---

_Reviewed: 2026-09-22_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
