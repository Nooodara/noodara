---
phase: 08
reviewed: 2026-09-27T03:46:59Z
depth: standard
files_reviewed: 113
files_reviewed_list:
  - .gitignore
  - apps/web/package.json
  - "apps/web/src/app/(shell)/@inspector/default.tsx"
  - "apps/web/src/app/(shell)/layout.tsx"
  - "apps/web/src/app/(shell)/servers/[id]/page.tsx"
  - apps/web/src/app/globals.css
  - apps/web/src/components/ActivityList.test.tsx
  - apps/web/src/components/ActivityList.tsx
  - apps/web/src/components/ActivityRow.tsx
  - apps/web/src/components/AuthCard.test.tsx
  - apps/web/src/components/AuthCard.tsx
  - apps/web/src/components/DiscoverySection.tsx
  - apps/web/src/components/DiscoveryStep.test.tsx
  - apps/web/src/components/DiscoveryStep.tsx
  - apps/web/src/components/FirstTrustNotice.test.tsx
  - apps/web/src/components/FirstTrustNotice.tsx
  - apps/web/src/components/ServerDetailToolbar.test.tsx
  - apps/web/src/components/ServerFacts.test.tsx
  - apps/web/src/components/ServerFacts.tsx
  - apps/web/src/components/ServerList.test.tsx
  - apps/web/src/components/ServerList.tsx
  - apps/web/src/components/ServerRow.tsx
  - apps/web/src/components/SettingsGroups.test.tsx
  - apps/web/src/components/SettingsGroups.tsx
  - apps/web/src/components/Sidebar.test.tsx
  - apps/web/src/components/Sidebar.tsx
  - apps/web/src/components/SignOutButton.tsx
  - apps/web/src/components/Toolbar.test.tsx
  - apps/web/src/components/Toolbar.tsx
  - apps/web/src/components/TrustFingerprintDialog.test.tsx
  - apps/web/src/components/TrustFingerprintDialog.tsx
  - apps/web/src/lib/discovery-progress.test.ts
  - apps/web/src/lib/discovery-progress.ts
  - apps/web/src/lib/session-user.test.ts
  - apps/web/src/lib/session-user.ts
  - docs/adr/0000-package-legitimacy-approvals.md
  - docs/ui/APPROVAL.md
  - docs/ui/review/README.md
  - package.json
  - packages/ui/aperture.css
  - packages/ui/package.json
  - packages/ui/src/AccountMenu.test.tsx
  - packages/ui/src/AccountMenu.tsx
  - packages/ui/src/Banner.test.tsx
  - packages/ui/src/Banner.tsx
  - packages/ui/src/Button.test.tsx
  - packages/ui/src/Button.tsx
  - packages/ui/src/CopyButton.tsx
  - packages/ui/src/Dialog.test.tsx
  - packages/ui/src/Dialog.tsx
  - packages/ui/src/Disclosure.test.tsx
  - packages/ui/src/Disclosure.tsx
  - packages/ui/src/EmptyState.test.tsx
  - packages/ui/src/EmptyState.tsx
  - packages/ui/src/FileButton.tsx
  - packages/ui/src/Fingerprint.test.tsx
  - packages/ui/src/Fingerprint.tsx
  - packages/ui/src/InsetGroup.test.tsx
  - packages/ui/src/InsetGroup.tsx
  - packages/ui/src/ListRow.test.tsx
  - packages/ui/src/ListRow.tsx
  - packages/ui/src/NavTree.test.tsx
  - packages/ui/src/NavTree.tsx
  - packages/ui/src/Notice.test.tsx
  - packages/ui/src/Notice.tsx
  - packages/ui/src/RowMenu.test.tsx
  - packages/ui/src/RowMenu.tsx
  - packages/ui/src/SegmentedControl.tsx
  - packages/ui/src/Sheet.test.tsx
  - packages/ui/src/Sheet.tsx
  - packages/ui/src/Skeleton.test.tsx
  - packages/ui/src/Skeleton.tsx
  - packages/ui/src/StatTile.test.tsx
  - packages/ui/src/StatTile.tsx
  - packages/ui/src/StatusPill.test.tsx
  - packages/ui/src/StatusPill.tsx
  - packages/ui/src/Tooltip.test.tsx
  - packages/ui/src/Tooltip.tsx
  - packages/ui/src/contrast.test.ts
  - packages/ui/src/contrast.ts
  - packages/ui/src/index.ts
  - packages/ui/src/motion-features.js
  - packages/ui/src/motion-tokens.ts
  - packages/ui/src/press.test.ts
  - packages/ui/src/press.ts
  - packages/ui/src/use-close-source.test.tsx
  - packages/ui/src/use-close-source.ts
  - packages/ui/src/use-floating-menu.test.tsx
  - packages/ui/src/use-floating-menu.ts
  - packages/ui/theme.css
  - packages/ui/tokens.css
  - packages/ui/tsconfig.json
  - scripts/check-package-provenance.mjs
  - scripts/check-ui-safety.mjs
  - scripts/ui/capture-ui-review.ts
  - scripts/ui/fixture-host.ts
  - scripts/ui/review-paths.ts
  - scripts/ui/tsconfig.json
  - tests/e2e/a11y-fallbacks.spec.ts
  - tests/e2e/activity.spec.ts
  - tests/e2e/brand.spec.ts
  - tests/e2e/canary-ui.spec.ts
  - tests/e2e/discovery.spec.ts
  - tests/e2e/host-key.spec.ts
  - tests/e2e/keyboard-motion.spec.ts
  - tests/e2e/server-sheet.spec.ts
  - tests/e2e/servers-list.spec.ts
  - tests/e2e/shell.spec.ts
  - tests/unit/scripts/check-ui-safety.test.ts
  - tests/unit/ui/approval-record.test.ts
  - tests/unit/ui/fixture-host.test.ts
  - tests/unit/ui/review-paths.test.ts
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 08: Code Review Report

**Reviewed:** 2026-09-27T03:46:59Z
**Depth:** standard
**Files Reviewed:** 113
**Status:** issues_found

## Summary

This phase's own SUMMARY/deferred-items.md trail is unusually thorough and already self-reports
several real gaps (`ServerDetailToolbar` truncation/parity, the Esc-close focus-return gap, the
silent-login-failure bug, the un-audited hover utilities). Those are not re-reported here as new
findings; I confirmed they still hold as described and moved on to look for defects the phase's
own record does not already name.

Direct review of the security-sensitive surfaces (`session-user.ts`, `use-close-source.ts`,
`Dialog.tsx`/`RowMenu.tsx`/`AccountMenu.tsx` close-source handling, `Fingerprint.tsx` diff mode,
`capture-ui-review.ts`/`fixture-host.ts` credential handling) turned up no secret leakage, no
injection vector and no correctness bug in the close-source-across-opens logic the task explicitly
asked me to stress. The main defects found are two real gaps in the "gates" the team relies on to
enforce its own design-system rules (`check-ui-safety.mjs`'s colour-literal regex and the
`motion` import restriction having no static enforcement at all), plus a few smaller robustness/
quality issues in `capture-ui-review.ts`'s error path and `Sheet.tsx`'s velocity math. Nothing
found rises to Critical: no secret ever reaches a log/response/capture, no unhandled remote-op
timeout, no injection surface.

## Warnings

### WR-01: `motion`/`motion.*` import restriction is enforced only by convention, not by any gate

**File:** `packages/ui/src/Sheet.tsx:216-221`, `packages/ui/src/motion-features.js`, `scripts/check-ui-safety.mjs` (absence)
**Issue:** The header comments on `Sheet.tsx` and `motion-features.js` both assert "the one place
in this codebase `motion` may be imported," and `<LazyMotion strict>` is cited as what enforces
this. `LazyMotion strict` only throws if the *full* `motion.*` component (not `m.*`) is rendered
**inside** that `LazyMotion` subtree — it does nothing to stop an unrelated file elsewhere in the
app from doing `import { motion } from 'motion/react'` and rendering a `motion.div` in a completely
different component tree that never nests under this `LazyMotion`. I confirmed
`scripts/check-ui-safety.mjs` has no gate at all for `motion` imports (grepped the file: the only
motion-adjacent gates are shadow-allowlist, backdrop-filter budget and built-in-easing), unlike
every other rule this file names ("a rule only checked by review erodes; a rule checked by a
command does not" — the file's own stated design philosophy, contradicted here).
**Failure scenario:** A future plan adds a second animated component (e.g. a toast or a page
transition) and reaches for `import { motion } from 'motion/react'` directly instead of routing
through `motion-features.js`'s lazy `domMax` bundle. Nothing fails CI: `check-ui-safety.mjs` is
silent on this, and `LazyMotion strict` in `Sheet.tsx` is scoped to `Sheet`'s own subtree so it
never sees the new import. The "one bundle, lazily loaded, in one file" invariant this phase spent
real design effort on (T-08-33, the whole point of `motion-features.js` existing as its own module)
silently regresses, and the full `motion` bundle ships in the initial page load again.
**Fix:** Add a `runCountGate`-style check to `check-ui-safety.mjs` mirroring the existing pattern:
```js
runCountGate({
  name: "motion/react imported only from Sheet.tsx/motion-features.js (D19/UI-06)",
  files: NON_TEST_SOURCE_FILES.filter(
    (f) => f !== path.join('packages', 'ui', 'src', 'Sheet.tsx') &&
           f !== path.join('packages', 'ui', 'src', 'motion-features.js'),
  ),
  pattern: /from ['"]motion\/react['"]/g,
  expected: 0,
  comparator: (total, expected) => total === expected,
}),
```

### WR-02: `check-ui-safety.mjs`'s colour-literal gate has a real false-negative gap (non-hex/rgb colour functions)

**File:** `scripts/check-ui-safety.mjs:237-250`
**Issue:** The "zero hex colour literals"/"zero rgb(/rgba(" gates only match `#[0-9a-fA-F]{3,8}` and
`rgba?\(`. Tailwind v4 (and this repo's own toolchain) also accepts `hsl(...)`, `hsla(...)`,
`oklch(...)`, `lab(...)`, `lch(...)` and `color(...)` as valid CSS colour functions in an arbitrary
value (`bg-[oklch(0.7_0.1_200)]`), none of which this gate's regex touches.
**Failure scenario:** A contributor bypasses the "route every colour through a `--token`" rule
(05-UI-SPEC.md's stated intent behind this gate) by writing `className="bg-[oklch(65%_0.2_250)]"`
instead of a hex or rgb literal. `pnpm check:ui-safety` reports OK; the design system's single-
source-of-truth guarantee for colour is silently defeated, and the next accessibility/contrast
audit has no way to know this value exists outside `tokens.css`.
**Fix:** Extend `BUILTIN` colour-literal scanning with an additional pattern, e.g.
`/\b(?:hsla?|oklch|oklab|lab|lch|color)\(/g`, gated the same way (excluding `tokens.css`), and add
a fixture test in `tests/unit/scripts/check-ui-safety.test.ts` proving it catches at least one
example of each function form.

### WR-03: `capture-ui-review.ts`'s top-level `catch` logs the raw, unfiltered error object

**File:** `scripts/ui/capture-ui-review.ts:469-472`
**Issue:**
```js
main().catch((err: unknown) => {
  console.error('capture-ui-review: FATAL', err);
  process.exit(1);
});
```
Every other console statement in this file is a hand-composed, redaction-safe string. This one
line prints whatever `err` happens to be verbatim to stdout/CI logs. Playwright request/response
errors for a failed `page.request.post('/api/servers', { data: body })` call (where `body` carries
`credential.password`, including the real seeded `sshd.password` for the "connected" fixture) can,
depending on the Playwright version and failure mode, embed the serialized request in the thrown
error's `.message` (e.g., a `TypeError` wrapping a `fetch` failure, or an APIRequestContext error
that stringifies its own request options). The file's own header comment makes an explicit,
specific claim ("CREDENTIALS ARE NEVER LOGGED") that this one unguarded catch-all does not
structurally guarantee.
**Failure scenario:** `seedServerFixtures` throws (e.g. the sshd Testcontainer never becomes
reachable, or `createServer` starts throwing instead of returning `{ ok: false }` after a
dependency upgrade changes Playwright's `APIRequestContext` error shape) with an error object whose
`.message`/`.cause` includes the request body. That body is printed straight into whatever picks up
this script's stdout — a CI log, a terminal transcript pasted into an issue/PR — the exact "0 leaked
secrets" failure mode `noodara-security`'s SKILL.md opens with, and this is a code path this file's
own security scan (`pnpm security:scan-leaks`) does not cover (it scans the running app's own
outputs, not this standalone script's console output).
**Fix:** Redact known-sensitive fields before logging, e.g.:
```js
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('capture-ui-review: FATAL', message.replace(FIXTURE_WRONG_PASSWORD, '[REDACTED]'));
  process.exit(1);
});
```
or, more robustly, never let a fixture-creation failure surface the raw response/error at all —
wrap `createServer`'s failure path to throw a message built only from `response.status()`.

### WR-04: `Sheet.tsx`'s momentum handoff can hand a `NaN`-adjacent value from `Math.sign(0)`

**File:** `packages/ui/src/Sheet.tsx:189-191`
**Issue:**
```js
const handoffVelocity = Number.isFinite(info.velocity.x)
  ? Math.sign(info.velocity.x) * Math.min(Math.abs(info.velocity.x), MAX_HANDOFF_VELOCITY_PX_PER_S)
  : DRAG_CLOSE_VELOCITY_PX_PER_S;
```
This branch is only reached when `decidesToClose(info)` is true, i.e. `info.velocity.x >
DRAG_CLOSE_VELOCITY_PX_PER_S` (110) **or** `info.offset.x > PANEL_WIDTH_PX / 2` (240). In the
position-only branch (a slow drag past the midpoint with near-zero release velocity),
`info.velocity.x` can be a small positive **or negative** finite number (e.g. -2, from a tiny
backward jitter at release) even though the drag's net direction was a close. `Math.sign(-2)` is
`-1`, so `handoffVelocity` becomes negative — the closing spring is handed a velocity pointing back
toward the panel's resting position while `animateMotionValue(x, PANEL_WIDTH_PX, ...)` is still
targeting the closed position (x = 480). This isn't caught by the `Number.isFinite` guard (the
value is finite) and only manifests as a momentarily-fighting spring, not a hang like the
already-handled non-finite case.
**Failure scenario:** A user drags the Sheet past the halfway point, then very slightly relaxes
their finger pressure right at release (a real, common gesture) producing a small negative
`velocity.x` reading. The panel's close-with-momentum animation starts with a small counter-velocity
against its own +480 target, producing a visible micro-stutter/overshoot-then-correct at the start
of the close animation instead of the smooth momentum handoff the brief's §7.4 step 8 describes.
**Fix:** Clamp the sign to the close direction when the decision to close came from position, not
velocity — e.g. `const closingVelocity = info.velocity.x < 0 && info.offset.x > PANEL_WIDTH_PX / 2 ? 0 : info.velocity.x` before applying `Math.sign`/`Math.min`, or simpler: floor the handed-off
velocity at 0 when closing (`Math.max(0, info.velocity.x)`) since this Sheet only ever closes
rightward.

## Info

### IN-01: `check-ui-safety.mjs`'s hex/rgb/easing gates never scan `scripts/` or `tests/`

**File:** `scripts/check-ui-safety.mjs:171-179`
**Issue:** `TSX_GLOBS = ['apps/web/src', 'packages/ui/src']` is the sole source of
`ALL_SOURCE_FILES`; nothing under `scripts/ui/*.ts` (including `capture-ui-review.ts`, which does
contain inline `style={{ '--transform-origin': ... }}`-style CSSProperties objects in some sibling
files) or `tests/e2e/*.spec.ts` is ever scanned by the colour-literal or easing gates. This matches
the file's own documented scope note for the easing gate ("scoped to packages/ui specifically"),
but the colour-literal gates have no such documented scope-narrowing rationale — they read as
repo-wide in the gate's own name ("zero hex colour literals outside packages/ui/tokens.css") while
actually only covering two of the repo's several TS/TSX source trees.
**Fix:** Either broaden `TSX_GLOBS` to include `scripts/` (excluding generated docs), or rename the
gate strings to make the narrower scope explicit so a future reader doesn't assume repo-wide
coverage.

### IN-02: `AuthCard.tsx`'s aperture-focus attributes are hardcoded literals, not state

**File:** `apps/web/src/components/AuthCard.tsx:38-41`
**Issue:** `data-entering="true"`, `data-aperture-focus="true"` and `data-aperture-focused="true"`
are all static string literals on the JSX element, never derived from any prop or state. This
matches the documented intent (mount-triggered `@starting-style` transition, "no mount effect, no
interval, no loop") and is not a functional bug given `AuthCard` only ever mounts once per full
page navigation to `/setup`/`/login` — but it does mean nothing in this file itself prevents a
future edit that reuses `AuthCard` in a context where it stays mounted across a state change (e.g.
a client-side tab switch between login/signup panels sharing one `AuthCard` instance) from silently
losing the "exactly once" guarantee, since there's no code-level assertion tying these attributes to
an actual mount event.
**Fix:** No change needed today; if `AuthCard` ever becomes reusable across a client-side view
switch without a full remount, revisit whether these three attributes need a `key`-forced remount
or an explicit one-shot ref instead of relying on "this component only ever mounts once" as an
unenforced invariant.

### IN-03: `capture-ui-review.ts` retains the wrong-password literal in a fixture visible to two servers

**File:** `scripts/ui/capture-ui-review.ts:54, 340, 275, 292`
**Issue:** `FIXTURE_WRONG_PASSWORD` is reused unchanged across the `errored` server and both
attempts inside `createLongNameServer`. This is intentional and documented (obviously-fake,
never-real, matches `server-sheet.spec.ts`'s `FAKE_PASSWORD` precedent) so this is not a security
finding, but it does mean a grep for this exact literal across the fixture matrix will now flag
three servers instead of one if a future canary/leak-scan test asserts "this password appears
exactly once" — worth a one-line comment update if that assumption is ever encoded in a test.
**Fix:** No action required; noted for whoever next touches `security:scan-leaks`'s fixture
assumptions.

## What was checked and found sound

- **`session-user.ts`**: `narrowSessionUser` structurally cannot leak anything beyond `name`/
  `email` — it destructures exactly those two keys and never spreads the raw session object. No
  token, id, or session metadata reaches `AccountMenu` through this file.
- **Close-source tracking (`use-close-source.ts`, `use-floating-menu.ts`, `Dialog.tsx`,
  `RowMenu.tsx`, `AccountMenu.tsx`)**: the `sourceRef` is reset to `'programmatic'` at the start of
  every effect run gated on `open` transitioning true, so a keyboard-close recorded in one
  open/close cycle cannot leak into the next open of the same or a different overlay instance. Both
  the capture-phase listeners and the render-time `closeSource()` read ordering were traced and are
  correct (Radix's own capture-phase Escape handling always runs before the primitive's
  `onOpenChange` callback triggers React's state update and this component's next render).
  `use-close-source.test.tsx` directly covers the "resets on every re-open" and "removes both
  listeners on unmount" cases.
- **`Fingerprint.tsx` diff mode**: block-length mismatches (differing fingerprint formats/lengths)
  correctly fall through to `isDiffing = true` (an `undefined` compare-block never equals a real
  block), never crash on a shape mismatch, and the diff signal is carried by font-weight + ink
  shade, never colour alone (`BLOCK_MATCH_CLASSES`/`BLOCK_DIFF_CLASSES`), satisfying the "no
  colour-only signalling" rule. No raw HTML injection surface — text-only rendering throughout.
  Non-`SHA256:`-shaped input degrades to an as-is fallback render rather than crashing.
  `TrustFingerprintDialog`'s snapshot-on-open discipline (captured once per `open` transition, never
  re-captured from a live `server` prop while open) correctly defends the display/promote race the
  file's own header describes, and the atomic backend `FINGERPRINT_MISMATCH` path is handled without
  silently retrying or accepting a stale value.
- **`ServerList.tsx` first-load stagger / `ActivityList.tsx` `computeEnteringIds`**: both effects
  were traced for the exact 08-19 nightly flake described in the code's own comments; the ref-based
  "recompute only on a genuinely new items reference" fix in `ActivityList.tsx` is correct and its
  test suite (`ActivityList.test.tsx`) directly exercises the regression scenario. `ServerList.tsx`'s
  `hasEnteredRef`/`isFirstLoad` pairing correctly fires the stagger exactly once across the
  loading -> ready transition and never replays on a later re-render or newly added server.
  `Toolbar.tsx`'s scroll-edge listener is added/removed cleanly with no leak; `Sidebar.tsx`'s sticky
  positioning change (`static` -> `sticky`) was reviewed against the G3-adjustment comment and holds.
- **`(shell)/layout.tsx`'s `has-[>*]:` inspector slot**: pure CSS, no JS-computed boolean and no
  SSR/hydration mismatch risk — the documented reasoning (Next's parallel-route prop never being the
  literal `null` even when empty) was verified against the code as written.
- **`capture-ui-review.ts`/`fixture-host.ts` credential handling** (aside from WR-03's error-path
  gap): unauthenticated screens are captured strictly before sign-in with every field empty, the
  real admin/fixture passwords are only ever passed into Playwright's `fill()`, never built into a
  string this script itself constructs or logs, and `docs/ui/review/*` is gitignored (only
  `README.md` and the explicitly-approved `docs/ui/approved/` set are committed).
- **`check-ui-safety.mjs`'s shadow allowlist and backdrop-filter budget gates**: exact-path
  allowlisting (not prefix-based) correctly scopes the shadow exception to exactly the four named
  files; the backdrop-filter gate's "count distinct files" approach was checked against its own
  documented worst-case reasoning and matches.
- No hardcoded secrets, `eval`, `dangerouslySetInnerHTML` (beyond the one reviewed, pre-existing
  occurrence in `apps/web/src/app/layout.tsx`, unchanged by this phase), `as any`, `@ts-ignore`, or
  `eslint-disable` found anywhere in the reviewed file set. No empty catch blocks. No stray
  `console.log`/`debugger` in product code (only expected CLI-output `console.log` in build/review
  scripts).

---

_Reviewed: 2026-09-27T03:46:59Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
