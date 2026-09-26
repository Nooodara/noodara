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

- [ ] **Sheet drag at real speed**: on `/servers`, open the add-server `Sheet` and drag its panel
      by touch or pointer. Confirm 1:1 tracking with the pointer, progressive resistance once
      dragged past its resting edge, a short fast flick closes it outright, and re-grabbing the
      panel mid-close resumes the drag from wherever it currently sits on screen (never snapping
      back to the fully-open position first).
- [ ] **Sheet drag in slow motion**: Chrome DevTools → More tools → Animations → set playback
      speed to 5% (or the slowest available), repeat the same drag/flick sequence, and confirm the
      spring settles smoothly with no visible stutter or overshoot past the panel's edge.
- [ ] **Sheet drag on real touch hardware**: if an iPad or phone is available on the LAN, open the
      dev server's LAN URL on that device and repeat the drag-to-dismiss gesture with an actual
      finger, not a mouse — confirm the same tracking/resistance/flick/resume behavior holds.
- [ ] **Viewfinder ring against a real discovery run**: connect a real server (via the disposable
      sshd above) and watch the monogram's central ring go from open/unfocused to sharp/closed as
      the six discovery steps complete on `/servers/:id`. Then force a partial/failed run (wrong
      credential, or stop the sshd container mid-run) and confirm the ring stops exactly where the
      run stopped — it must never complete by itself once the run has failed.
- [ ] **Brand-swap test on the discovery narration**: with a completed discovery run visible,
      mentally (or literally, via DevTools) swap the Viewfinder mark for a generic icon and confirm
      the discovery timeline and its copy still read clearly as *the product's own* narration, not
      generic loading text — the mark should be additive, not load-bearing for comprehension.
- [ ] **Brand-swap test on the TOFU block**: same swap test on `FirstTrustNotice`'s `Fingerprint`
      block (`/servers/:id` on first connect) — the fingerprint's own layout (blocks of 4, mono,
      copy button) must read clearly as a trust decision on its own, independent of the mark.
- [ ] **Full motion table spot-check**: walk `/login`, `/setup`, `/servers`, `/activity` and
      `/settings` once each and confirm each screen's "one discrete moment" (08-CONTEXT.md D-11) is
      the only entrance animation on that screen — never the same animation repeated across
      sections.
