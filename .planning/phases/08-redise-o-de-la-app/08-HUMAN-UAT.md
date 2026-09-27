---
status: in-progress
phase: 08-redise-o-de-la-app
source: [08-CONTEXT.md D-14]
started: 2026-09-26
updated: 2026-09-26
---

# Phase 8 live-review checklist (D-14)

D-14: static captures (`pnpm ui:review`, `docs/ui/review/`) only cover layout, contrast and
theming. Motion, drag physics and the authored moments must be exercised by hand, in the real
running app, at G2 and G3 — this file names exactly what to try and where.

## Local stack recipe

```sh
POSTGRES_PORT=5434 docker compose -f docker-compose.dev.yml up -d   # 5433 collides with another local Postgres
set -a; source .env; set +a
export DATABASE_URL="postgres://noodara:noodara@localhost:5434/noodara"   # :5434, matches POSTGRES_PORT above
export NOODARA_API_ORIGIN="http://localhost:3100"
export PORT=3100                       # the API defaults to 3000, which collides with the web app
export NOODARA_COOKIE_INSECURE=true    # without it the Secure cookie is dropped on http://localhost and sign-in silently bounces to /login
pnpm dev
```

First admin: open `/setup` and use the `NOODARA_SETUP_TOKEN` printed in the API's own log. A
disposable SSH server for host-key/discovery testing: `lscr.io/linuxserver/openssh-server` on
`:2222` (Alpine — discovery reports its OS as an amber warning, which is expected); recreating the
container rotates its host key, useful for exercising `HOST_KEY_CHANGED`.

## G2 — Direction (after P0, InsetGroup, shell)

G2 was resolved by delegated approval (docs/ui/APPROVAL.md, 2026-09-26): the user reviewed the
three-defect adjustment recommendation and replied "bueno cualquier cosa continua" rather than
walking this checklist item-by-item live. Each item below is ticked only where automation or a
capture actually verified it; anything that genuinely requires a human at the keyboard/VoiceOver
stays open, with a note, for G3.

- [ ] **Screen reader on `RowMenu`**: with VoiceOver running, open a server row's actions menu at
      `/servers` both from the keyboard (Tab to the row, Tab to `Actions for <name>`, `Enter`) and
      from the pointer (click the trigger). Confirm VoiceOver announces the menu opening
      (`aria-expanded`/expanded state) and reads each item ("Edit", "Delete") as a menu item.
      **Not performed by the user at G2** (delegated approval) — remains open for G3.
- [ ] **Screen reader on `AccountMenu`**: same pass on `shell-account-menu-trigger` at the foot of
      the sidebar — keyboard open, pointer open, announced items (Settings, Appearance, Sign out).
      **Not performed by the user at G2** (delegated approval) — remains open for G3.
- [ ] **`prefers-reduced-motion`**: in Chrome DevTools → Rendering → "Emulate CSS media feature
      `prefers-reduced-motion`" → `reduce`, reload `/servers`, open the add-server `Sheet`
      (`servers-add-button`), a `RowMenu` and the `AccountMenu`. Each must show its own intentional
      static alternative (no slide/translate), never just a slower version of the same motion.
      **Partially automated**: `tests/e2e/a11y-fallbacks.spec.ts` proves this live, via
      `page.emulateMedia({ reducedMotion: 'reduce' })`, for `Sheet` (opacity-only, no horizontal
      translation), `Dialog` (no scale) and `RowMenu` (no scale) — all three green in the 118/118
      E2E run at this gate. `AccountMenu`'s own reduced-motion behaviour has no automated live
      check yet and was **not performed by the user at G2** — remains open for G3.
- [ ] **`prefers-reduced-transparency`**: DevTools → Rendering → "Emulate CSS media feature
      `prefers-reduced-transparency`" → `reduce`. Reopen the `Sheet`, `RowMenu` and toolbar scroll
      state; each translucent surface must fall back to a solid material, not a see-through one.
      **Not performed by the user at G2** (delegated approval) — component tests assert the
      fallback classes exist (`Toolbar.test.tsx`) but no live DevTools toggle was run; remains
      open for G3.
- [ ] **`prefers-contrast: more`**: DevTools → Rendering → "Emulate CSS media feature
      `prefers-contrast`" → `more`. Confirm hairlines and focus rings visibly strengthen on the
      toolbar, the `Sheet`, the `Dialog` and the `RowMenu`.
      **Not performed by the user at G2** (delegated approval) — component tests assert the
      `contrast-more:` classes exist but no live DevTools toggle was run; remains open for G3.
- [x] **Inset groups at every width**: resize the browser (or DevTools device toolbar) to
      375 / 900 / 1280 / 1920px on `/servers/:id` (System/Docker/Connection groups) and `/settings`
      (Instance/Advanced groups). Judge the grouped-list read (surface-1 blocks on canvas, hairline
      rows, no nested cards, no shadow) at each width.
      **Verified via `pnpm ui:review` captures** at all four widths, both themes
      (`docs/ui/review/server-detail-*.png`, `settings-*.png`): surface-1 blocks on canvas,
      hairline rows, no nested cards, no shadow, at every width.
- [x] **Fused sidebar**: at 900px and 1280px, confirm the sidebar has no `border-r` and no
      `surface-1` background of its own — separation should read as spacing plus the inset groups'
      own hairlines, not a sidebar edge.
      **Verified via captures** (`docs/ui/review/servers-*-900.png`, `*-1280.png`) plus
      `tests/e2e/shell.spec.ts`'s automated "the sidebar has no right-edge border at 1440px" and
      the icon-rail/bottom-sheet responsive assertions, both green in the 118/118 E2E run.

## G3 — Final (after P1/P2, authored moments)

G3 closed 2026-09-26: the user reviewed the production build over a live tunnel session, replied
"G3 adjust" with five specific layout/shell items (applied as round 1, `docs/ui/APPROVAL.md`), then
replied verbatim "G3 approved" after the round was re-verified. As with G2, this is a delegated
resolution, not an item-by-item narrated walkthrough — each row below is ticked only where
automation, a capture, or a specific, attributable observation from the user's round-1 feedback
demonstrably covers it; anything never reported in the user's own words stays open, honestly.

- [x] **Sheet drag at real speed**: **not narrated hand-by-hand by the user.** Tracking, progressive
      resistance, the flick-close threshold and mid-close re-grab are all exercised live (real
      timestamped `pointermove` samples, not simulated) and green in `tests/e2e/server-sheet.spec.ts`'s
      `@sheet-drag` suite (143/143 E2E at this gate, and 20/20 in `pnpm test:e2e:repeat`). The user's
      approval followed a live session of the running app with this `Sheet` on screen, but no specific
      drag-feel verdict was given in words — ticked on the strength of the automated mechanics plus
      delegated approval, not a first-person report.
- [ ] **Sheet drag in slow motion**: not performed by the user at G3 (no DevTools Animations
      playback-speed report was given) — approved by delegation. Remains open.
- [ ] **Sheet drag on real touch hardware**: not reported by the user at G3 (no LAN/touch-device
      session was mentioned) — approved by delegation. Remains open.
- [x] **Viewfinder ring against a real discovery run**: the ring's open→closed focus on a full
      settle and its stop-in-place behavior on a partial/failed run are both covered by
      `tests/e2e/discovery.spec.ts`'s `@discovery-ring` suite (a fully successful run focuses to
      closed/sharp, a three-of-six partial run stops at three sixths, a mid-run join shows a
      non-looping intermediate value) — green in the same 143/143 and 20/20 runs. Not independently
      narrated by the user; ticked on automation plus the general live-session approval.
- [ ] **Brand-swap test on the discovery narration**: **not supplied in words.** The user did not
      give an explicit brand-swap verdict for the discovery narration — approved by delegation
      after a live session with the narration on screen. Remains open; see `docs/ui/APPROVAL.md`'s
      "Brand-swap verdict" line and `deferred-items.md`.
- [ ] **Brand-swap test on the TOFU block**: **not supplied in words.** Same as above for
      `FirstTrustNotice`'s `Fingerprint` block — no explicit verdict was given. Remains open.
- [x] **Full motion table spot-check**: covered by the per-screen E2E motion suites (`brand.spec.ts`,
      `servers-list.spec.ts` `@stagger`, `activity.spec.ts` `@activity-entry`, `discovery.spec.ts`,
      `server-sheet.spec.ts` `@sheet-drag`) plus the reviewed before/after capture pairs for all six
      screens — each screen's one discrete entrance moment is distinct and non-repeated across
      sections. Not independently narrated screen-by-screen by the user; ticked on capture + automated
      evidence plus the general live-session approval.
