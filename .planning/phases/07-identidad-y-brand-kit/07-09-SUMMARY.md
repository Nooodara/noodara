---
phase: 07-identidad-y-brand-kit
plan: 09
subsystem: ui
tags: [brand, nextjs, manifest, favicon, opengraph, e2e, playwright, vitest, tdd, BRAND-02]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-06's packages/ui/brand/* (13 generated, byte-locked files) and brand-colors.json ({ themeColor: '#0071e3', backgroundColor: '#161618' })"
  - phase: 07-identidad-y-brand-kit
    provides: "07-07's tests/e2e/brand.spec.ts (7 @brand tests, local login helper, real stack fixture)"
provides:
  - "apps/web/scripts/sync-brand-assets.mjs: BRAND_SYNC_FILES allowlist (7 dest:src entries) + syncBrandAssets(), isMainModule-guarded, run by both dev and build before next starts"
  - "apps/web/src/app/{favicon.ico,icon.svg,icon1.png,icon2.png,apple-icon.png,opengraph-image.png,brand-colors.json}: synced, byte-identical to packages/ui/brand/*, committed, no apps/web/public/"
  - "apps/web/src/app/manifest.ts: MetadataRoute.Manifest reading colours from ./brand-colors.json (import attribute JSON import worked directly, no tsconfig change needed), icons 192/512 image/png"
  - "apps/web/src/app/layout.tsx: description + openGraph (title/description/siteName/type) + conditional metadataBase from NOODARA_PUBLIC_URL, no icons key, theme bootstrap script untouched"
  - "apps/web/src/proxy.ts: matcher now excludes the 6 public brand routes (favicon.ico was already excluded) from the session-redirect -- a real bug found and fixed by this plan's own E2E RED run"
  - "tests/unit/brand/{sync-brand-assets,favicon-files-present}.test.ts (22 new unit tests) and tests/e2e/brand.spec.ts's new 'brand icons' describe block (4 new E2E tests, 11 total in the file)"
affects: [07-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Next.js 16's numbered icon file convention (app/icon1.png=192, app/icon2.png=512) used instead of public/icon-*.png, since apps/web/Dockerfile deliberately ships no public/ copy step -- manifest.ts's icon src values (/icon1.png, /icon2.png) matched what Next actually served on the first E2E run, no correction needed"
    - "A Web App Manifest's required hex theme_color/background_color are read from a synced JSON file (./brand-colors.json) rather than typed as a TS literal, keeping manifest.ts inside check-ui-safety.mjs's hex-literal gate at zero without any gate allowlist edit (T-07-28, accepted per the threat register)"
    - "syncBrandAssets compares destination bytes before writing (writeIfChanged discipline, mirrors scripts/capture-discovery-fixtures.mjs) and never deletes -- a foreign file already present in apps/web/src/app is left untouched by design"
    - "An E2E assertion for 'is this route served' must check content-type, never status alone: a redirect-then-200-HTML page passes a status-only check identically to a real 200 image response, which is exactly the bug this plan's own test caught in proxy.ts"

key-files:
  created:
    - apps/web/scripts/sync-brand-assets.mjs
    - apps/web/src/app/manifest.ts
    - tests/unit/brand/sync-brand-assets.test.ts
    - tests/unit/brand/favicon-files-present.test.ts
  modified:
    - apps/web/package.json
    - apps/web/src/app/layout.tsx
    - apps/web/src/proxy.ts
    - tests/e2e/brand.spec.ts
    - apps/web/src/app/favicon.ico
    - apps/web/src/app/icon.svg
    - apps/web/src/app/icon1.png
    - apps/web/src/app/icon2.png
    - apps/web/src/app/apple-icon.png
    - apps/web/src/app/opengraph-image.png
    - apps/web/src/app/brand-colors.json

key-decisions:
  - "apps/web/src/proxy.ts's matcher regex gained 5 new exclusions (icon.svg, icon1.png, icon2.png, apple-icon.png, opengraph-image.png, manifest.webmanifest) beyond the plan's own file list -- favicon.ico was already excluded, but every other brand route was silently redirecting an unauthenticated visitor to /login (200 text/html, not the image/manifest). This is the real reason D-14's 'favicon in the tab' review matters: without this fix, Chrome would have shown its default globe icon on /login and /setup forever, since the tab favicon request carries no session cookie."
  - "The 07-09-PLAN.md behavior spec's literal '> 100 bytes' floor for every BRAND_SYNC_FILES dest was applied only to the 6 non-JSON assets: packages/ui/brand/brand-colors.json is a genuinely correct 62-byte two-key JSON file, and a blanket >100-byte assertion would have been a false failure against real, correct data (Rule 1 -- the test's own literal spec, not the implementation, was the bug)."
  - "The manifest icon `src` values from the plan's own interface sketch (/icon1.png, /icon2.png) needed zero correction: the first E2E run against the built app resolved both to 200 image/png with the correct decoded IHDR width, so Task 3's anticipated 'read the served head and fix manifest.ts' branch was not needed."

patterns-established:
  - "A middleware/proxy matcher exclusion list is exercised by an E2E test that checks response CONTENT-TYPE, not just status -- a redirect-to-login always 200s, so a status-only check for 'is this a public route' is a false-safe test that would never have caught this bug"

requirements-completed: []

# Metrics
duration: ~55min
completed: 2026-09-22
---

# Phase 7 Plan 09: Web icons, manifest and Open Graph metadata Summary

**`apps/web` now serves the whole generated icon family (favicon, apple-touch-icon, two PWA icon sizes, an Open Graph image and a Web App Manifest) through an allowlisted, idempotent sync script run on every dev/build, a `manifest.ts` with zero colour literal, and Open Graph metadata on the root layout — and a real pre-existing bug (the session-redirect proxy blocking every one of these routes for an unauthenticated visitor) was found and fixed by this plan's own E2E test before it ever shipped.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3 (all three TDD, RED committed before GREEN on Tasks 1-2; Task 3's RED evidence is a real E2E failure that led to a `fix` commit rather than a same-file GREEN)
- **Files created:** 4 (1 script, 1 route file, 2 test files); modified: 10 (1 package.json, 1 layout, 1 proxy, 1 E2E spec, 6 synced binary/json assets)
- **Tests:** 22 new unit (5 sync-brand-assets + 17 favicon-files-present) + 4 new E2E (`brand icons` describe block, 11 total in `tests/e2e/brand.spec.ts`); full unit suite is 151 files / 2542 tests, all green (was 149/2520 after 07-08)

## Accomplishments

- **The icon family is synced, never hand-copied.** `apps/web/scripts/sync-brand-assets.mjs` exports a frozen `BRAND_SYNC_FILES` allowlist (7 entries) and `syncBrandAssets()`, which compares destination bytes before writing (idempotent, mirrors `capture-discovery-fixtures.mjs`'s own `writeIfChanged` discipline) and never deletes a foreign file. `dev`/`build` in `apps/web/package.json` both now run `node scripts/sync-brand-assets.mjs &&` first. Running it synced all 7 files; a second run reports "no files changed". `test ! -d apps/web/public` holds — the PWA icons use Next's numbered convention (`icon1.png`=192, `icon2.png`=512) instead, since `apps/web/Dockerfile`'s runner stage deliberately has no `public/` copy step.
- **Docker prune context proven to contain the script and its sources, without building the image.** `pnpm exec turbo prune @noodara/web --docker --out-dir <scratchpad>` was run into the session scratchpad (never inside the repo), and all 8 required files (`apps/web/scripts/sync-brand-assets.mjs` plus the 7 `packages/ui/brand/*` sources) were confirmed present under `out/full/` before the scratchpad output was deleted.
- **`manifest.ts` carries zero colour literal.** `import brandColors from './brand-colors.json' with { type: 'json' }` — the import-attribute form worked on the first try; no `apps/web/tsconfig.json` edit, no plain-import fallback, no `readFileSync` fallback was needed. `pnpm check:ui-safety` stayed green with no gate edit (T-07-28, accepted: a JSON value is not a colour literal in `.ts`/`.tsx`/`.css` source, which is what the gate protects).
- **`layout.tsx` gained Open Graph metadata with no `icons` key and the theme bootstrap script untouched.** `description`, `openGraph: { title, description, siteName, type: 'website' }`, and a conditional `metadataBase` spread in only when `NOODARA_PUBLIC_URL` is set (no `??`/`||` literal fallback — this repo's eslint config bans that pattern outright).
- **A real bug was found and fixed by the E2E test, not assumed away.** Task 3's RED run against the built app showed `apple-icon.png` and the manifest both returning HTTP 200 with `text/html` — because `apps/web/src/proxy.ts`'s matcher only excluded `favicon.ico`, `login` and `setup` from its session-redirect, so every other brand route (icon.svg, icon1.png, icon2.png, apple-icon.png, opengraph-image.png, manifest.webmanifest) silently redirected an unauthenticated visitor to `/login`. Fixed by adding those 5 routes to the matcher's exclusion list. The E2E test that first caught this was also strengthened afterward: the icon-hrefs loop originally only checked `body.length > 0` (which a redirected login page also satisfies), so it was rewritten to assert content-type on every href too — a false-safe test would otherwise have let this exact bug ship.
- **Every emitted icon/manifest URL is proven served from the real built app.** The new `brand icons` describe block (4 tests, zero `waitForTimeout`) asserts: the five head tags are present on `/login`; every `link[rel="icon"]`/`apple-touch-icon`/`manifest` href and the `og:image` content resolve to 200 with the correct content-type; `GET /favicon.ico` serves `image/x-icon`; and the manifest JSON parses with `theme_color` read from the real `packages/ui/brand/brand-colors.json` (never typed), with each `icons[i].src` decoding (via a hand-read PNG IHDR width, bytes 16-19) to exactly its declared size.

## Task Commits

| Task | What | Commit | Type |
|------|------|--------|------|
| 1 | RED: failing sync-brand-assets tests | `38a40ed` | test |
| 1 | GREEN: the allowlisted sync script, dev/build wiring, 7 synced files | `35aa87e` | feat |
| 2 | RED: failing manifest/layout metadata tests | `5a6fe1e` | test |
| 2 | GREEN: manifest.ts + layout.tsx Open Graph metadata | `d44e128` | feat |
| 3 | The brand-icons E2E describe block (RED: 2 of 4 failed against the real proxy bug) | `df02713` | test |
| 3 | The proxy.ts matcher fix that made all 11 brand E2E tests pass | `5c25973` | fix |
| — | This summary and the tracking update | (below) | docs |

## RED evidence

- **Task 1:** `Cannot find module '../../../apps/web/scripts/sync-brand-assets.mjs'` — the whole suite failed to load. After the GREEN: 5/5.
- **Task 2:** `ENOENT: apps/web/src/app/manifest.ts` — the whole suite failed to load (the presence/byte-equality cases for the already-synced files from Task 1 would have passed, but the suite never got that far). After the GREEN: 17/17.
- **Task 3:** `pnpm exec playwright test tests/e2e/brand.spec.ts` ran 11 tests, 2 failed: `apple-icon.png` returned `text/html; charset=utf-8` instead of an `image/*` content-type, and the manifest response body was `<!DOCTYPE ...` (a redirected login page), not JSON. After the `proxy.ts` fix: 11/11.

## Verification

- `pnpm exec vitest run tests/unit/brand/sync-brand-assets.test.ts` — 5/5 green
- `cmp packages/ui/brand/favicon.ico apps/web/src/app/favicon.ico` and `cmp packages/ui/brand/icon-512.png apps/web/src/app/icon2.png` — both exit 0 (byte-identical)
- `test ! -d apps/web/public` — holds
- `pnpm exec vitest run tests/unit/brand/favicon-files-present.test.ts` — 17/17 green
- `pnpm --filter @noodara/web typecheck && pnpm --filter @noodara/web lint` — both exit 0
- `pnpm check:ui-safety` — 9/9 gates OK, including `zero hex colour literals outside packages/ui/tokens.css (count=0)`
- `grep -v '^\s*//' apps/web/src/app/manifest.ts | grep -v '^\s*\*' | grep -cE "#[0-9a-fA-F]{3,8}\b"` → 0; `grep -c "brand-colors.json" apps/web/src/app/manifest.ts` → 2
- `grep -c "openGraph" apps/web/src/app/layout.tsx` → 1; `grep -c "icons:" apps/web/src/app/layout.tsx` → 0; `grep -cE "process\.env\.[A-Z_]+ (\?\?|\|\|) '" apps/web/src/app/layout.tsx` → 0
- `NOODARA_API_ORIGIN=http://localhost:3100 pnpm build` — 5/5 tasks successful, `/apple-icon.png`, `/icon.svg`, `/icon1.png`, `/icon2.png`, `/opengraph-image.png`, `/manifest.webmanifest` all listed as generated routes
- `pnpm exec playwright test tests/e2e/brand.spec.ts` — 11/11 green (07-07's original 7 + this plan's 4 new)
- `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` — exits 0
- `pnpm brand:check` — "OK, no drift" (packages/ui/brand/* untouched by this plan)
- `pnpm test` — 151 files / 2542 tests green (was 149/2520 after 07-08); `pnpm typecheck`, `pnpm lint` — both exit 0
- Docker prune-context proof: `pnpm exec turbo prune @noodara/web --docker --out-dir <session scratchpad, never inside the repo>` — all 8 required files (the sync script + its 7 `packages/ui/brand/*` sources) present under `out/full/`; scratchpad deleted afterward, nothing written inside the repo
- `docker ps` shows no Noodara container before and after this plan; ports 3000/3100 free; the E2E stack fixture tore itself down after every run
- `git stash list` empty throughout; every commit staged only explicit files under `noodara/code`

## Manifest icon `src` values (final, verified against the served `<head>`)

No correction was needed — the plan's own interface sketch matched what Next actually serves:

| `icon.sizes` | `icon.src` | Verified |
|---|---|---|
| `192x192` | `/icon1.png` | `GET` → 200, `image/png`, decoded PNG width 192 |
| `512x512` | `/icon2.png` | `GET` → 200, `image/png`, decoded PNG width 512 |

The rendered `<head>` on `/login` (captured during this plan's own verification run, cache-busting hash suffixes included) shows:

```json
{
  "icon": [
    "/favicon.ico?favicon.05_m4y3814vr0.ico",
    "/icon.svg?icon.1ofi6r8_o4rxk.svg",
    "/icon1.png?icon1.22ru4rm9sxtmr.png",
    "/icon2.png?icon2.1jwc28g24nbco.png"
  ],
  "apple-touch-icon": ["/apple-icon.png?apple-icon.19uo0cfqo7i6q.png"],
  "manifest": ["/manifest.webmanifest"],
  "og:image": ["http://localhost:3000/opengraph-image.png?opengraph-image.13kbo8s3z135s.png"]
}
```

## Manual verification required (D-14, Pitfall 2 — cannot be scripted)

Playwright's screenshot API never captures browser/OS chrome (tab strip, favicon rendering) — this is a hard platform limitation, not a configuration gap. A human must open the real app in a real browser and look at the tab directly:

> Open http://localhost:3000/login in **Chrome** and **Safari**, once with the OS appearance set to **light** and once to **dark**. Confirm the Noodara tile favicon (the blue rounded tile with the white monogram) is legible at 16 px on both browsers' tab strips, in both appearances.

This is the one item `/gsd-verify-work` must surface to the user; it closes D-14's "favicon en la pestaña del navegador" review item and is verified by the user, never by a script.

## Decisions Made

Recorded in frontmatter `key-decisions`. The one worth repeating in full: **`apps/web/src/proxy.ts`'s matcher was missing 5 exclusions** (only `favicon.ico`/`login`/`setup` were excluded from the session-redirect before this plan) — every other brand route was silently redirecting an unauthenticated visitor to `/login`, which is exactly the surface D-14's browser-tab review and D-12's Open Graph image both depend on being reachable with zero session. This was found by the plan's own E2E test, not assumed, and the test itself was strengthened afterward (content-type, not status alone) so the same bug class cannot silently pass again.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] apps/web/src/proxy.ts redirected every public brand route to /login for an unauthenticated visitor**
- **Found during:** Task 3, the E2E RED run
- **Issue:** `apple-icon.png` and the manifest route both returned HTTP 200 with `text/html` (a redirected `/login` page) instead of their real content — `proxy.ts`'s matcher only excluded `api`, `_next/static`, `_next/image`, `favicon.ico`, `login` and `setup`; every other brand-icon/manifest/OG route fell through to the session check and redirected.
- **Fix:** Added `icon.svg`, `icon1.png`, `icon2.png`, `apple-icon.png`, `opengraph-image.png` and `manifest.webmanifest` to the matcher's negative-lookahead exclusion list.
- **Verification:** all 11 tests in `tests/e2e/brand.spec.ts` pass; the icon-hrefs loop that would have false-passed this bug (checking only `body.length > 0`) was also strengthened to assert content-type.
- **Files modified:** `apps/web/src/proxy.ts`, `tests/e2e/brand.spec.ts`
- **Committed in:** `5c25973` (fix), test strengthening included in `df02713` (test)

**2. [Rule 1 - Bug] The plan's own literal ">100 bytes" test spec would have false-failed brand-colors.json**
- **Found during:** Task 2, writing `favicon-files-present.test.ts`
- **Issue:** `packages/ui/brand/brand-colors.json` (07-06's own committed, correct output) is 62 bytes — a blanket ">100 bytes" assertion across every `BRAND_SYNC_FILES` dest, as the plan's behavior spec states literally, would fail against genuinely correct data.
- **Fix:** The size-floor assertion is scoped to the 6 non-JSON dest names only; `brand-colors.json` still gets a non-empty (`> 0` bytes) and byte-equality check, just not the ">100" floor.
- **Verification:** 17/17 green; `brand-colors.json`'s real 62-byte content is unchanged and still exactly asserted byte-equal to its source.
- **Files modified:** `tests/unit/brand/favicon-files-present.test.ts`
- **Committed in:** `5a6fe1e` (test, RED — the file was written this way from the start, so this is a same-commit correction, not a follow-up)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — a real bug and a test-spec correction). No scope, behaviour or coverage was reduced; the proxy fix is strictly additive (widens public reachability of static brand assets only, touches no authenticated route).

## Issues Encountered

- The naive (non-comment-stripping) acceptance grep `grep -c "dangerouslySetInnerHTML" apps/web/src/app/layout.tsx` reports 2, not the plan's stated 1 — this is pre-existing (the explanatory comment above the real occurrence already contained the word before this plan touched the file) and not a regression; the authoritative gate, `scripts/check-ui-safety.mjs`, strips comment lines first and correctly reports `count=1`, confirmed green in this plan's own verification run.
- `pnpm test -- <path>` still does not filter (recorded since 07-02): `pnpm exec vitest run <paths>` was used for every scoped run in this plan.

## User Setup Required

**Manual browser-tab verification required** (D-14, Pitfall 2 — see the dedicated section above). No external service configuration.

## Next Phase Readiness

- **07-10 (README, CI drift gate, full regression)** can rely on `pnpm brand:check` staying the single drift gate for `packages/ui/brand/*` (confirmed unchanged by this plan) and on `apps/web`'s own icon family being fully wired and E2E-proven; the README's `<picture>` snippet work is independent of this plan's files.
- **BRAND-02 is closer to complete but not ticked here**, matching every prior 07-0x plan's own precedent (`requirements-completed: []`): the favicon/apple-touch-icon/manifest/OG surfaces in `apps/web` are now real and E2E-proven, but BRAND-02 also names the README and the public site (07-10's own work).
- **The manual browser-tab check (D-14) is the one remaining human item** for this plan's own scope — the SUMMARY states it verbatim above for `/gsd-verify-work` to surface.

## Self-Check: PASSED

- All 4 created files exist on disk (`apps/web/scripts/sync-brand-assets.mjs`, `apps/web/src/app/manifest.ts`, both test files); all 10 modified files are tracked with the expected changes; the 7 synced files under `apps/web/src/app/` are `cmp`-identical to their `packages/ui/brand/*` sources.
- Commits `38a40ed`, `35aa87e`, `5a6fe1e`, `d44e128`, `df02713`, `5c25973` are all in `git log --oneline`, in that order, with each RED preceding its GREEN/fix.
- Every commit touches only paths under `noodara/code/`; none carries an attribution trailer; `git stash list` is empty; `docker ps` shows no Noodara container.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-22*
