# Phase 8: Rediseño de la app - Pattern Map

**Mapped:** 2026-09-23
**Files analyzed:** 27 (new + modified, excluding test-only mirror files)
**Analogs found:** 27 / 27 (every file has at least a role-match analog; several have exact analogs)

Read first: `docs/ui-build-prompt.md`, `08-CONTEXT.md`, `08-RESEARCH.md`, `08-UI-SPEC.md` — this
file only maps *where to copy code from*, it does not restate the spec's values (tokens, durations,
copy). Where this file says "copy the shape from X", the spec still governs the literal values.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/ui/src/RowMenu.tsx` (fix in place) | component (floating menu) | event-driven (open/select/dismiss) | itself (`RowMenu.tsx` today) + `Dialog.tsx`'s controlled-open pattern | exact (modify existing) |
| `packages/ui/src/use-floating-menu.ts` (new) | hook | event-driven | `RowMenu.tsx`'s existing roving-focus/keydown logic (extracted) | exact (extraction) |
| `packages/ui/src/AccountMenu.tsx` (new) | component (floating menu) | event-driven | `RowMenu.tsx` (shared primitive) + `ThemeToggle.tsx` (embedded control) | exact |
| `packages/ui/src/NavTree.tsx` (new) | component (nav) | transform (data → tree UI) | `apps/web/src/components/Sidebar.tsx`'s `<ul>` nav items + `Disclosure.tsx` (expand/collapse) | role-match |
| `packages/ui/src/InsetGroup.tsx` (new) | component (layout/surface) | transform | `packages/ui/src/StatTile.tsx` (surface-1/hairline/rounded wrapper) + `ServerFacts.tsx`'s group markup (title outside, rows inside) | role-match |
| `packages/ui/src/Fingerprint.tsx` (new) | component (display) | transform | `packages/ui/src/CopyButton.tsx` (composed) + `LabelValue.tsx`'s mono-value rendering + `TrustFingerprintDialog.tsx`'s existing inline mono diff markup | role-match |
| `packages/ui/src/Sheet.tsx` (modify — add drag) | component (overlay) | event-driven (gesture) | itself (`Sheet.tsx` today, Radix Dialog panel) | exact (modify existing) |
| `packages/ui/src/motion-tokens.ts` (new) | config | — | `packages/ui/tokens.css`'s token-definition convention (plain named exports, one file, one purpose) | role-match |
| `packages/ui/src/motion-features.js` (new, domMax re-export) | config | — | none (new pattern) — follow `08-RESEARCH.md` Pattern 1 verbatim | no analog |
| `packages/ui/src/Dialog.tsx` (modify — shadow-floating, surface-elevated) | component (overlay) | request-response (confirm) | itself | exact (modify existing) |
| `packages/ui/src/Tooltip.tsx` (verify — stays solid) | component (overlay) | — | itself | exact (no structural change expected) |
| `packages/ui/src/tokens.css` (modify — add §5.2 tokens) | config | — | itself | exact (modify existing) |
| `packages/ui/theme.css` (modify — `--color-surface-elevated`) | config | — | itself (existing `@theme` bindings) | exact (modify existing) |
| `packages/ui/src/contrast.ts` (modify — generalize for `surface-elevated`) | utility | transform | itself (`auditTheme`'s derived-regex loop) | exact (modify existing) |
| `scripts/check-ui-safety.mjs` (modify — shadow-outside-allowlist gate) | config/gate | static analysis | itself (`runCountGate` pattern) | exact (modify existing) |
| `apps/web/src/app/(shell)/layout.tsx` (modify — `@inspector` slot, NavTree/AccountMenu) | layout (Next.js route) | request-response (SSR) + event-driven (client state) | itself | exact (modify existing) |
| `apps/web/src/app/(shell)/@inspector/default.tsx` (new) | route (parallel slot) | — | `08-RESEARCH.md` Pattern 4 (Next.js parallel-route convention) — no existing slot in repo | no analog (new Next.js primitive for this repo) |
| `apps/web/src/components/Sidebar.tsx` (modify or replaced by NavTree+AccountMenu composition) | component (nav shell) | event-driven | itself | exact (modify existing) |
| `apps/web/src/components/Toolbar.tsx` (modify — scroll-edge effect) | component (chrome) | event-driven (scroll) | itself | exact (modify existing) |
| `apps/web/src/components/SignOutButton.tsx` (behavior absorbed into AccountMenu) | component (action) | request-response | itself | exact (source of truth for sign-out flow) |
| `apps/web/src/components/ServerFacts.tsx` (modify — wrap groups in `InsetGroup`, use `Fingerprint`) | component (detail view) | transform | itself | exact (modify existing) |
| `apps/web/src/components/SettingsGroups.tsx` (modify — wrap in `InsetGroup`) | component (detail view) | transform | itself | exact (modify existing) |
| `apps/web/src/components/ServerList.tsx` (modify — single `InsetGroup` wrapper) | component (list) | CRUD (read) | itself | exact (modify existing) |
| `apps/web/src/components/ServerRow.tsx` (modify — stagger entry) | component (row) | CRUD (read) | itself | exact (modify existing) |
| `apps/web/src/components/DiscoverySection.tsx` (modify — timeline thread + ring header) | component (live progress) | event-driven (SSE-backed) | itself | exact (modify existing) |
| `apps/web/src/components/DiscoveryStep.tsx` (modify — thread segment) | component (row) | transform | itself | exact (modify existing) |
| `apps/web/src/components/FirstTrustNotice.tsx` (modify — use `Fingerprint`) | component (notice) | display | itself | exact (modify existing) |
| `apps/web/src/components/TrustFingerprintDialog.tsx` (modify — use `Fingerprint` diff mode) | component (destructive confirm) | request-response | itself | exact (modify existing) |
| `apps/web/src/app/globals.css` (modify — §Surface Craft rules) | config | — | itself (existing global stylesheet, e.g. `:focus-visible` rule referenced in `layout.tsx`) | exact (modify existing) |
| `tests/e2e/shell.spec.ts` (modify — AccountMenu testids) | test (E2E) | — | itself | exact (modify existing) |
| `tests/e2e/canary-ui.spec.ts` (modify — AccountMenu testids) | test (E2E) | — | itself + `shell.spec.ts` | exact (modify existing) |
| `tests/e2e/brand.spec.ts` (modify — AccountMenu testids) | test (E2E) | — | itself + `shell.spec.ts` | exact (modify existing) |
| `tests/e2e/server-sheet.spec.ts` (extend — drag sequence) | test (E2E) | — | itself | exact (modify existing) |
| `docs/ui/APPROVAL.md` + `docs/ui/approved/` + `docs/ui/review/` (new) | docs/fixture | — | `docs/brand/APPROVAL.md` + `docs/brand/approved/` + `docs/brand/review/` | exact |
| `tests/unit/ui/approval-record.test.ts` (new) | test (unit) | static analysis of docs | `tests/unit/brand/approval-record.test.ts` | exact |
| `scripts/ui/capture-ui-review.ts` (or similar, new) | tooling (Playwright capture) | batch | `scripts/brand/capture-brand-review.ts` + `scripts/brand/review-paths.ts` | exact |
| `packages/ui/src/Fingerprint.test.tsx`, `AccountMenu.test.tsx`, `NavTree.test.tsx`, `InsetGroup.test.tsx` (new) | test (unit, jsdom) | — | `packages/ui/src/RowMenu.test.tsx`, `Disclosure.test.tsx` | exact |

## Pattern Assignments

### `packages/ui/src/RowMenu.tsx` (component, event-driven) — fix in place

**Analog:** itself, today's file (already read in full above)

**Current shape to build on** (`packages/ui/src/RowMenu.tsx` lines 1–124): built on
`DialogPrimitive.Root modal={false}` with an *uncontrolled* open state — Radix owns Esc-close,
outside-click-close and close→trigger-focus-return already. The component owns exactly one custom
behavior: arrow-key roving focus (`handleContentKeyDown`, lines 60–82), matched by `role="menu"`/
`role="menuitem"` overrides on the primitive.

**The three required diffs** (see `08-UI-SPEC.md` §6.1 / `08-RESEARCH.md` Pattern 3), sketched
against the real current code:

```tsx
// BEFORE (line 53, 85): uncontrolled, no close-on-select
export function RowMenu({ items, triggerLabel, 'data-testid': testId }: RowMenuProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  // ...
  return (
    <DialogPrimitive.Root modal={false}>
      {/* ... */}
      <DialogPrimitive.Trigger className={TRIGGER_CLASSES} data-testid={testId} data-hit-area={44} aria-haspopup="menu">
      {/* ... */}
      {items.map((item) => (
        <button key={item.label} type="button" role="menuitem" className={...}
          onClick={() => { item.onSelect(); }}>
          {item.label}
        </button>
      ))}

// AFTER (three targeted additions, everything else unchanged):
export function RowMenu({ items, triggerLabel, 'data-testid': testId }: RowMenuProps) {
  const [open, setOpen] = useState(false); // NEW
  const contentRef = useRef<HTMLDivElement | null>(null);
  // ...
  return (
    <DialogPrimitive.Root modal={false} open={open} onOpenChange={setOpen}>
      {/* ... */}
      <DialogPrimitive.Trigger className={TRIGGER_CLASSES} data-testid={testId} data-hit-area={44}
        aria-haspopup="menu" aria-expanded={open}> {/* NEW */}
      {/* ... */}
      {items.map((item, index) => (
        <button key={item.id ?? index} type="button" role="menuitem" className={...} /* NEW key */
          onClick={() => { item.onSelect(); setOpen(false); }}> {/* NEW setOpen(false) */}
          {item.label}
        </button>
      ))}
```

`RowMenuItem` gains an optional `id?: string` (currently only `label`/`onSelect`/`destructive`,
`RowMenu.tsx` lines 6–10).

**Test analog** (`packages/ui/src/RowMenu.test.tsx`, all 105 lines read above): every new behavior
gets a RED test in this exact same file, following its established shape — `renderUi`/`screen`/
`userEvent` from `./testing/render.js`, `buildItems(onEdit, onDelete)` helper, assertions like
`expect(screen.queryByRole('menuitem')).toBeNull()`. Add: "closes and returns focus to trigger after
selecting an item" (currently only "closes on Escape" and "closes on outside click" are covered,
lines 60–89) and "aria-expanded reflects open state" (assert via `toHaveAttribute('aria-expanded', ...)`
on the trigger).

**Shadow addition:** `CONTENT_CLASSES` (line 26–28) gains `shadow-[var(--shadow-floating)]` and swaps
`bg-surface-3` for whatever the final surface-step decision is (per `08-UI-SPEC.md` §5.2, RowMenu
stays `bg-surface-3` — already correct, no change needed there).

---

### `packages/ui/src/use-floating-menu.ts` (new hook) — extracted shared primitive

**Analog:** `RowMenu.tsx`'s own `handleContentKeyDown`/`menuItemNodes` (lines 56–82) — lift verbatim,
parameterize by `contentRef`. Both `RowMenu` and `AccountMenu` (`08-UI-SPEC.md` §4.4) call this hook
instead of each owning a second copy of arrow-key roving focus. Also carries the keyboard-vs-pointer
close-source tracking (`08-UI-SPEC.md` §6.2) as **capture-phase native listeners on `document`** —
this is new code with no existing analog in the repo (the anti-pattern to avoid is reaching for
Radix's `onEscapeKeyDown`/`onInteractOutside`, which `scripts/check-ui-safety.mjs` lines 130–136
explicitly forbids at `expected: 0`).

```js
// scripts/check-ui-safety.mjs lines 130-136 — the exact gate this hook must not trip:
runCountGate({
  name: 'zero onEscapeKeyDown/onInteractOutside overrides (Radix Dialog/Sheet default behaviour must stay untouched)',
  files: NON_TEST_SOURCE_FILES,
  pattern: /onEscapeKeyDown|onInteractOutside/g,
  expected: 0,
  comparator: (total, expected) => total === expected,
}),
```

---

### `packages/ui/src/AccountMenu.tsx` (new component, event-driven)

**Analogs:** `RowMenu.tsx` (shared floating-menu shell/primitive, via `use-floating-menu.ts`) +
`packages/ui/src/ThemeToggle.tsx` (embedded control, must call this file's own write path, never a
second one) + `apps/web/src/components/SignOutButton.tsx` (sign-out action/copy source).

**Imports pattern** (mirror `RowMenu.tsx` lines 1–4):
```tsx
import { useRef, useState, type KeyboardEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from './cn.js';
import { ThemeToggle } from './ThemeToggle.js';
```

**Theme control — the one write path, never a second writer** (`ThemeToggle.tsx` lines 1–130,
especially the header comment lines 60–69 and `STORAGE_KEY` export line 11): `AccountMenu` renders
`<ThemeToggle data-testid="shell-account-menu-theme-toggle" />` directly inside its "Appearance" row —
it must **not** reimplement `readStoredTheme`/`resolveSystemTheme`/`localStorage.setItem` itself.
Pitfall P17 (inherited, `08-RESEARCH.md` Pitfall 9) is exactly this mistake.

**Sign-out action — copy/behavior source** (`SignOutButton.tsx` lines 15–39): same close-stream-then-
POST-then-navigate sequence (`close()` from `useShellContext()`, `apiSend('POST', '/api/auth/sign-out')`,
`router.push('/login')`) — reuse `SignOutButton`'s internals directly rather than duplicating the
sequence, or have `AccountMenu`'s "Sign out" row render `<SignOutButton>` itself styled as a menu item.

**Avatar:** new, no analog — `bg-surface-3`/`border-hairline`/`text-ink` circle per `08-UI-SPEC.md`
§4.3, styled like `RowMenu.tsx`'s `TRIGGER_CLASSES` sizing conventions (`h-11 w-11` touch-target
pattern, line 20–24) scaled to the avatar's own dimensions.

---

### `packages/ui/src/NavTree.tsx` (new component, transform)

**Analog:** `apps/web/src/components/Sidebar.tsx` lines 72–115 (the flat `<ul>`/`<li>` nav item
markup, `ITEM_CLASSES`/`ACTIVE_ITEM_CLASSES`/`LABEL_CLASSES` at lines 22–26) for the leaf rendering,
plus `packages/ui/src/Disclosure.tsx` in full (46 lines) for expand/collapse:

```tsx
// Sidebar.tsx lines 72-86 — the leaf pattern NavTree's flat-leaf case must render identically:
<li>
  <Tooltip content="Servers">
    <Link href="/servers" aria-label="Servers" aria-current={isActive('/servers') ? 'page' : undefined}
      onClick={onClose} className={cn(ITEM_CLASSES, isActive('/servers') ? ACTIVE_ITEM_CLASSES : '')}>
      <Server {...ICON_PROPS} />
      <span className={LABEL_CLASSES}>Servers</span>
    </Link>
  </Tooltip>
</li>
```

```tsx
// Disclosure.tsx lines 36-46 — the expand/collapse shape NavTree's parent-with-children case reuses
// (grid-template-rows transition, CollapsiblePrimitive, aria-expanded from the primitive):
export function Disclosure({ title, children, defaultOpen = false, 'data-testid': testId }: DisclosureProps) {
  return (
    <CollapsiblePrimitive.Root defaultOpen={defaultOpen} data-testid={testId} className="group">
      <CollapsiblePrimitive.Trigger className={TRIGGER_CLASSES}>
        <ChevronRight aria-hidden="true" size={16} strokeWidth={1.5} className={CHEVRON_CLASSES} />
        {title}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className={CONTENT_CLASSES}>{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
```

Data shape: generic `NavTreeItem { id, label, href, icon, children? }` (no `Project`/`Environment`
type imports — D-07). Today's caller (`Sidebar.tsx`) passes exactly the three flat leaves it renders
today (Servers/Activity/Settings, `History`/`Server`/`Settings` icons from `lucide-react`, same as
`Sidebar.tsx` line 10).

**Rail tooltip behavior:** `Sidebar.tsx`'s existing `<Tooltip content="Servers">` wrapper (line 74) is
already the rail-tooltip pattern — `NavTree` internalizes this per-leaf, keyed off the same
`min-[900px]`/`min-[1280px]` breakpoints `Sidebar.tsx` lines 60–64 already use.

**Test analog:** `packages/ui/src/Disclosure.test.tsx` for the expand/collapse cases;
`apps/web/src/components/Sidebar.test.tsx` for the existing flat-leaf keyboard/routing assertions this
component must keep passing once `Sidebar.tsx` composes `NavTree` instead of its own `<ul>`.

---

### `packages/ui/src/InsetGroup.tsx` (new component, transform)

**Analogs:** `packages/ui/src/StatTile.tsx` lines 20 (`ROOT_CLASSES = cn('flex flex-col gap-1
rounded-md border border-hairline bg-surface-1 p-5')`) for the surface-step/hairline/radius
convention (radius differs — `--r-lg` per D-01, not StatTile's `--r-md`), and
`apps/web/src/components/ServerFacts.tsx` lines 85–97 for the exact title-outside/rows-inside markup
this component formalizes:

```tsx
// ServerFacts.tsx lines 85-97 — the shape InsetGroup wraps and generalizes:
<div data-testid="server-facts-system" className="flex flex-col gap-1">
  <h3 className="text-label uppercase text-ink-secondary">System</h3>
  <LabelValue label="Hostname" value={server.hostname} mono dimmed={dimmed} caption={asOfCaption} />
  {/* ... more LabelValue rows ... */}
</div>
```

`InsetGroup` takes over the `bg-surface-1 border border-hairline rounded-lg` block wrapper (new,
`--r-lg` per D-01) while keeping the `<h3 className="text-label uppercase text-ink-secondary">` title
markup **unchanged** and **outside** the block (per `08-UI-SPEC.md` §1's explicit "unchanged markup
and role" instruction) — do not invent a new title role.

**Row separator convention:** hairline between rows, no block border per row (matches `DiscoveryStep.tsx`
line 108's `border-b border-hairline py-3 last:border-b-0` pattern for "hairline separates rows, last
row has none").

**Applied to** (per `08-UI-SPEC.md` §1): `ServerFacts.tsx`'s three groups (System/Docker/Connection,
lines 85–127), `SettingsGroups.tsx`'s Instance/Advanced (lines 61–76), `ServerList.tsx`'s whole list
(lines 71–78) including its `EmptyState` (lines 60–69) rendered inside the block.

**Test analog:** `packages/ui/src/StatTile.test.tsx` and `ServerFacts.test.tsx` for the wrapper/data-
testid conventions this new component's own test file should follow.

---

### `packages/ui/src/Fingerprint.tsx` (new component, transform)

**Analogs:** `packages/ui/src/CopyButton.tsx` (composed, in full above) for the copy affordance, and
the existing inline mono-diff markup already present (informally) in
`apps/web/src/components/TrustFingerprintDialog.tsx` lines 157–177 and
`apps/web/src/components/FirstTrustNotice.tsx` lines 27–40 — `Fingerprint` formalizes exactly this
pattern into one shared component:

```tsx
// TrustFingerprintDialog.tsx lines 157-163 — the ad hoc diff markup Fingerprint's diff mode replaces:
<div className="flex flex-col gap-2">
  <span data-mono="true" className="break-all text-mono text-ink-tertiary">
    {`Host: ${server.host}:${String(server.sshPort)}`}
  </span>
  <span data-mono="true" className="break-all text-mono text-ink">
    {server.hostFingerprint === null ? 'Trusted: not available' : `Trusted: ${server.hostFingerprint}`}
  </span>
```

```tsx
// FirstTrustNotice.tsx lines 27-40 — the single-fingerprint + CopyButton composition Fingerprint's
// non-diff mode replaces:
<div className="flex items-center gap-2">
  <span data-mono="true" className="break-all text-mono text-ink">{fingerprint}</span>
  <CopyButton value={fingerprint} label="Copy fingerprint" />
</div>
```

```tsx
// CopyButton.tsx (full component, 78 lines) — reused as-is inside Fingerprint, never reimplemented:
export function CopyButton({ value, label = 'Copy', 'data-testid': testId }: CopyButtonProps) {
  // feature-detects navigator.clipboard.writeText, swallows failures without throwing/logging
}
```

`LabelValue.tsx`'s own `mono`/`copyable` props (lines 32–56) are the pattern for how a value gets its
mono+copy treatment today — `Fingerprint` supersedes this specifically for the "Host fingerprint" row
in `ServerFacts.tsx` (`LabelValue` line 118–125 today), while `LabelValue` itself keeps serving every
other mono/copyable value in the app unchanged.

**No color, ever (diff mode):** matching blocks `text-ink-secondary font-normal`, differing blocks
`text-ink font-semibold` — mirrors the same "never color-only" discipline already established by
`DiscoveryStep.tsx`'s `STATE_WORDS` table (lines 21–29, "the status word is always in the DOM's text
content") and `RowMenu.tsx`'s `DESTRUCTIVE_ITEM_CLASSES` comment (lines 35–39) about measured-not-
assumed contrast.

**Test analog:** none exists yet (`08-RESEARCH.md` Wave 0 Gaps) — model the new `Fingerprint.test.tsx`
on `packages/ui/src/CopyButton.test.tsx`'s and `LabelValue.test.tsx`'s structure (`renderUi`/`screen`
from `./testing/render.js`).

---

### `packages/ui/src/Sheet.tsx` (modify — drag-to-dismiss)

**Analog:** itself (69 lines, read in full above). Current `PANEL_CLASSES` (lines 21–26) uses a pure
CSS `data-[state=open]:translate-x-0 data-[state=closed]:translate-x-full` transition driven entirely
by Radix's own `data-state`. The drag gesture wraps this same panel in `motion`'s `<m.div drag="x">`
(per `08-UI-SPEC.md` §7.3 / `08-RESEARCH.md` Pattern 1) — the Radix `DialogPrimitive.Content` stays
exactly as-is (focus trap, Esc, outside-click all untouched per the file's own header comment lines
41–47); only the panel's own transform authority moves from the CSS class to the motion value while
dragging.

```tsx
// Sheet.tsx lines 21-26, 48-53 — what stays untouched around the new drag wrapper:
const PANEL_CLASSES = cn(
  'fixed inset-y-0 right-0 z-50 flex h-full w-[480px] flex-col',
  'rounded-l-lg border-l border-hairline bg-surface-1/72 backdrop-blur-xl backdrop-saturate-[1.8]',
  'motion-safe:transition-transform motion-safe:duration-[var(--duration-sheet)] motion-safe:ease-[var(--ease-standard)]',
  'data-[state=open]:translate-x-0 data-[state=closed]:translate-x-full',
);
// ...
export function Sheet({ open, onOpenChange, title, children, footer, 'data-testid': testId }: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASSES} />
        <DialogPrimitive.Content className={PANEL_CLASSES} data-testid={testId} aria-describedby={undefined}>
```

The `<LazyMotion features={loadFeatures} strict><m.div drag="x" ...>` wrapper goes **inside**
`DialogPrimitive.Content`, replacing the plain `<div className={PANEL_CLASSES}>` — see
`08-RESEARCH.md`'s "Pattern 1" code block for the exact `motion` API shape (already Context7-verified)
and `08-UI-SPEC.md` §7.3 for the exact prop values (`dragElastic={0.15}`, `SPRING.drawer` from the new
`motion-tokens.ts`).

**Test analog:** `packages/ui/src/Sheet.test.tsx` (existing) for jsdom-level assertions (focus/ARIA);
`tests/e2e/server-sheet.spec.ts` (existing) is where the real drag sequence must be exercised — jsdom
cannot simulate pointer capture/drag physics (same "Radix behavior verified in Playwright, not jsdom"
discipline the file's own header already states for focus trap/Esc/outside-click).

---

### `packages/ui/src/Dialog.tsx` (modify — shadow-floating, surface-elevated)

**Analog:** itself (`packages/ui/src/Dialog.tsx`, full file read above). `PANEL_CLASSES` (lines
11–14) currently: `'fixed left-1/2 top-1/2 z-50 flex w-[420px] -translate-x-1/2 -translate-y-1/2
flex-col gap-4', 'rounded-lg border border-hairline bg-surface-1 p-8'` — gains
`shadow-[var(--shadow-floating)]` and swaps `bg-surface-1` for `bg-surface-elevated` (the new alias
token, light-unchanged/dark-one-step-lighter per `08-UI-SPEC.md` §5.2). `DialogShell` (lines 30–43) is
the one shared scaffold both `ConfirmDialog` and `DestructiveConfirmDialog` sit on — the change
applies once, here, and both dialog variants inherit it automatically (no duplicate edit needed).

---

### `packages/ui/src/contrast.ts` (modify — audit `surface-elevated`)

**Analog:** itself — `auditTheme`'s existing derived-regex loops (e.g. `SURFACE_BG_RE = /^(canvas|
surface-\d+)$/` at line 233, `INK_TOKEN_RE` loop at lines 435–457). `--surface-elevated` does not
match `SURFACE_BG_RE` as written (it's not `surface-\d+`) — either extend `SURFACE_BG_RE` to also
match `surface-elevated`, or add it to the derived-name list explicitly, so the existing ink-on-
surface loop (lines 438–457) picks it up automatically rather than a new hand-written audit block
being added (the module's whole design principle, stated in its own header comment lines 1–15, is
"derive from parsed token names, never a hardcoded list").

**Test analog:** `packages/ui/src/contrast.test.ts` (existing) — add cases for `--ink`/`--ink-secondary`
on `--surface-elevated` in both themes, following the same shape as existing `auditTheme`/`auditTokens`
assertions there.

---

### `scripts/check-ui-safety.mjs` (modify — shadow-outside-allowlist gate)

**Analog:** itself — the `runCountGate` helper (lines 68–80) and any of the existing gate
declarations (lines 92–158) as the template for the new gate:

```js
// check-ui-safety.mjs lines 92-99 — the exact shape a new gate declaration follows:
runCountGate({
  name: 'exactly one reviewed dangerouslySetInnerHTML occurrence (T-5-99)',
  files: ALL_SOURCE_FILES,
  pattern: /dangerouslySetInnerHTML/g,
  expected: 1,
  comparator: (total, expected) => total === expected,
}),
```

The new gate cannot be a simple `pattern`/`expected` count gate like the others (it needs to assert
`shadow`/`box-shadow` usage is *absent outside an allowlist of files*, not a fixed total count) — it
needs its own small function following `listFiles`/`codeOf`/`stripCommentLines` (lines 19–64)
conventions: scan `NON_TEST_SOURCE_FILES`, exclude `Sheet.tsx`/`Dialog.tsx`/`RowMenu.tsx`/
`AccountMenu.tsx` by path, then apply the same `pattern.match`/count-then-report shape the existing
gates use, printing via the same `console.log('OK ...')`/`console.error('FAIL ...')` convention
(lines 160–178) so its output is indistinguishable in style from the existing nine gates.

---

### `apps/web/src/app/(shell)/layout.tsx` (modify — `@inspector` slot, NavTree/AccountMenu)

**Analog:** itself (101 lines, read in full above). Everything in the current file — the
`ShellContext.Provider`/`TooltipProvider` nesting (lines 72–74), the skip-link (lines 79–86), the
`requireSession()`/SSE-reconnect guard effects (lines 27–59) — stays **completely untouched**; only
two things change:

```tsx
// layout.tsx lines 87-97 — current three-part shell:
<div className="flex min-h-screen bg-canvas">
  <Sidebar open={mobileNavOpen} onClose={() => { setMobileNavOpen(false); }} />
  <main id="shell-main" tabIndex={-1} className="min-w-0 flex-1">
    {children}
  </main>
</div>
```

becomes a four-part composition (per `08-UI-SPEC.md` §2.3 / `08-RESEARCH.md` Pattern 4): `Sidebar`
either keeps its name and internally composes `NavTree`+`AccountMenu`, or is replaced outright by
those two components directly in this file — either way the function signature gains an `inspector:
ReactNode` prop (from the new `@inspector` parallel-route slot) and the JSX gains an `<aside>` sibling
per `08-RESEARCH.md`'s Pattern 4 code block. The Next.js parallel-route wiring itself (`export default
function ShellLayout({ children, inspector }: ...)`, the slot prop name) has no existing analog in
this repo — copy the shape from `08-RESEARCH.md` Pattern 4 verbatim, it is already Next.js-16-verified
against this repo's pinned version.

**Test analog:** `08-RESEARCH.md`'s own Playwright sketch (Pattern 4, "inspector slot reserves no
space when empty, at any width") — add to `tests/e2e/shell.spec.ts`.

---

### `apps/web/src/components/Toolbar.tsx` (modify — scroll-edge effect)

**Analog:** itself (64 lines, read in full above). Current `border-b border-hairline` is a static
Tailwind class baked into the root `<div>`'s className (line 40: `'sticky top-0 z-30 flex h-[52px]
items-center gap-3 border-b border-hairline bg-surface-1/90 px-4 backdrop-blur'`) — this becomes a
scroll-position-driven class toggle (IntersectionObserver or `animation-timeline: scroll()`, executor's
choice per `08-UI-SPEC.md` §2.2) that swaps `border-transparent`↔`border-hairline`. Everything else in
this file (the `backLink`/mobile-menu-button branch at lines 42–56, `StreamStatus` composition,
`primaryAction`/`secondaryActions` prop shape at lines 27–32) is unchanged — this is the literal
enforcement of `08-RESEARCH.md`'s "type impedes the prohibited" pattern already noted in CONTEXT.md
(`ToolbarProps.primaryAction` single-slot).

---

### `apps/web/src/components/ServerFacts.tsx`, `SettingsGroups.tsx`, `ServerList.tsx` (modify — wrap in `InsetGroup`)

**Analog:** each file, itself (all three fully read above). In every case the change is: replace the
existing `<div className="flex flex-col gap-1">` (or equivalent) group wrapper with `<InsetGroup
title="...">`, keeping every child (`LabelValue`, `ServerRow`, `EmptyState`) and every existing
`data-testid` (`server-facts-system`, `settings-instance-group`, `servers-list`) unchanged — D-04's
"layout intacto salvo lo que los grupos exigen" is the literal instruction here: no row/column
restructuring, only the wrapper.

---

### `apps/web/src/components/DiscoverySection.tsx`, `DiscoveryStep.tsx` (modify — timeline thread + Viewfinder ring)

**Analogs:** each file, itself (both fully read above), plus `packages/ui/src/brand/geometry.ts`
(310 lines, read above) for the `[data-part="aperture"]` animation hook.

`DiscoverySection.tsx`'s existing `buildChecklist`/`summarize` pipeline (imported from
`../lib/discovery-progress`, line 15) is the **single source of progress** the new thread-fill and
ring must read from — the file's own header comment (lines 1–9) already states this discipline
("the fetched settled snapshot is never rendered directly, only ever through that one pure reducer");
the new authored-moment code adds a `completedFraction` derived from the same `checklist.steps` array
already iterated at lines 178–187, never a second computation.

`DiscoveryStep.tsx`'s existing `border-b border-hairline py-3 last:border-b-0` per-row treatment
(line 108) is the hairline convention the vertical thread sits behind/inside — the thread is a new
absolutely-positioned element layered behind the existing step markers, not a rewrite of the row
structure itself.

`geometry.ts`'s module header (lines 27–30) confirms the exact selector to animate:
> "PART NAMES ARE ANIMATION HOOKS... Phase 8 animates the mark (UI-08) by selecting
> `[data-part="aperture"]`"

— `MonogramPartName` (line 94) already includes `'aperture'` as a valid part name; no geometry change
is needed, only a CSS rule targeting the existing SVG's `data-part="aperture"` group.

---

### `apps/web/src/components/FirstTrustNotice.tsx`, `TrustFingerprintDialog.tsx` (modify — use `Fingerprint`)

**Analog:** each file, itself (both fully read above) — see the `Fingerprint.tsx` section above for
the exact spans each file's inline mono markup gets replaced by. `TrustFingerprintDialog.tsx`'s
surrounding request/error-handling logic (lines 93–143: `handleConfirm`, `FINGERPRINT_MISMATCH`
handling, `snapshot` state) is **completely untouched** — only the JSX inside the `<DestructiveConfirmDialog>`'s
children (lines 157–177) swaps to two `<Fingerprint>` instances in diff mode.

---

### `docs/ui/APPROVAL.md`, `docs/ui/approved/`, `docs/ui/review/`, `tests/unit/ui/approval-record.test.ts` (new — mirror brand's exact shape)

**Analog:** `docs/brand/APPROVAL.md` (47 lines, read in full above) — table shape (`| Field | Value
|` rows: Date, Concept→Gate, Adjustment rounds used→Rounds used, Approver, Evidence), "## Adjustment
log" section with one bullet per round including unused rounds ("Round 2: none."). For phase 8 the
table's "Concept" row becomes "Gate" (G1/G2/G3, per D-13) and this repeats **three times**, once per
gate, rather than once — model each gate's row block on this file's single-approval shape.

`tests/unit/brand/approval-record.test.ts` (132 lines, read in full above) is the direct template for
`tests/unit/ui/approval-record.test.ts`:

```ts
// approval-record.test.ts lines 30-37 — the exact row-parsing helper to replicate for docs/ui/APPROVAL.md:
const approval = (): string => readFileSync(APPROVAL_PATH, 'utf8');
function row(label: string): string {
  const match = approval().match(new RegExp(String.raw`^\|\s*${label}\s*\|\s*(.+?)\s*\|\s*$`, 'm'));
  expect(match, `no \`| ${label} |\` row in ${APPROVAL_PATH}`).toBeTruthy();
  return match?.[1] ?? '';
}
```

```ts
// approval-record.test.ts lines 122-131 — the exact AI-attribution-ban pattern to replicate under docs/ui/:
describe('the brand kit carries no AI attribution (CLAUDE.md §7)', () => {
  it('no file under docs/brand/ mentions an assistant vendor or an attribution trailer', () => {
    const forbidden = ['claude', 'anthropic', 'co-authored-by'];
    const offenders = filesUnder(BRAND_DIR).filter((file) => {
      const text = readFileSync(file, 'latin1').toLowerCase();
      return forbidden.some((needle) => text.includes(needle));
    });
    expect(offenders).toEqual([]);
  });
});
```

`docs/brand/approved/`'s "exactly these files and nothing else" pattern (lines 100–107 of the test)
— `readdirSync(APPROVED_DIR).sort()` against an expected list built from a `SURFACES`×`THEMES`
cross-product — is the exact shape `docs/ui/approved/`'s own pin test follows, built from
`08-UI-SPEC.md` §11.1's six screens × 2 themes × 1280px-only (approved) vs. `docs/ui/review/`'s full
4-width matrix.

---

### `scripts/ui/*` capture pipeline (new — mirror brand's exact pipeline)

**Analogs:** `scripts/brand/review-paths.ts` (51 lines, read in full) and
`scripts/brand/capture-brand-review.ts` (263 lines, header + first ~80 lines read above).

`review-paths.ts`'s pattern — repo-root-resolved-from-module-location (never `process.cwd()`, line
9–14/24), a fixed `SURFACES`/`THEMES` const tuple (lines 32–36), and a single `reviewPngPath(...)`
path-builder function every consuming script imports rather than string-concatenating paths itself —
is the exact shape a new `scripts/ui/review-paths.ts` follows, with `SURFACES` becoming the six
screens + overlay captures (`08-UI-SPEC.md` §11.1) instead of the four brand surfaces.

`capture-brand-review.ts`'s pattern — env-var-gated attach mode (`BRAND_REVIEW_BASE_URL`) vs. default
real-stack boot (`tests/e2e/fixtures/stack.ts`), explicit fixture credentials with no literal
fallback, and capturing unauthenticated screens first on a fresh context before any credential exists
on screen (module header lines 24–28) — is the exact discipline the new UI capture script must follow,
substituting the sshd Testcontainers fixture states D-12 names (connected+discovered, error, 80-char
name, empty list) for the three brand concepts this script currently loops over.

---

## Shared Patterns

### Floating-menu primitive (Radix `Dialog` non-modal, `modal={false}`)
**Source:** `packages/ui/src/RowMenu.tsx` (its own header comment, lines 41–52, explains why this
primitive was chosen over the seven other approved Radix packages)
**Apply to:** `AccountMenu.tsx` (D-05 explicitly requires sharing this primitive), extracted jointly
into `use-floating-menu.ts`.

### Single theme write path
**Source:** `packages/ui/src/ThemeToggle.tsx`, `STORAGE_KEY = 'noodara-theme'` (line 11)
**Apply to:** `AccountMenu.tsx`'s "Appearance" row — must render/call `ThemeToggle` itself, never a
second `localStorage.setItem('noodara-theme', ...)` call site.

### Derived-from-parsed-names contrast audits (never a hardcoded list)
**Source:** `packages/ui/src/contrast.ts`, e.g. `SURFACE_BG_RE`/`INK_TOKEN_RE`/`FILL_TOKEN_RE` (lines
211–233)
**Apply to:** any plan introducing `--surface-elevated` or any other new token this phase adds —
extend a regex/derivation, never append a hand-written pair to a literal array.

### Static safety gates via `runCountGate`
**Source:** `scripts/check-ui-safety.mjs`, `runCountGate` (lines 68–80) + the nine existing gate
declarations (lines 92–158)
**Apply to:** the new shadow-outside-allowlist gate (UI-03) — same reporting shape
(`console.log('OK ...')` / `console.error('FAIL ...')`, `process.exit(1)` on any failure).

### "The type impedes the prohibited"
**Source:** `apps/web/src/components/Toolbar.tsx`'s `ToolbarProps.primaryAction` (single optional
slot, not an array, lines 27–32)
**Apply to:** `AccountMenu`'s fixed three-item shape (Settings/Appearance/Sign out — no caller-supplied
extra items this phase), `NavTree`'s no-disabled-items rule (a leaf with no destination is never
rendered, never rendered `disabled`).

### No client platform clock reads — caller supplies `now: Date`
**Source:** `apps/web/src/components/ServerFacts.tsx` (`now: Date` prop, line 39, docstring lines
37–39), `ServerRow.tsx` (line 18–20), `DiscoverySection.tsx` (line 47)
**Apply to:** any new/modified component in this phase that renders a relative time or duration
(`Fingerprint`'s captured-at captions if added, discovery step duration labels) — thread `now`
explicitly, never call `new Date()`/`Date.now()` inside the component.

### Comment-stripped, derived static gates never trust a comment
**Source:** `scripts/check-ui-safety.mjs`'s `stripCommentLines` (lines 44–59)
**Apply to:** the new shadow gate and any future UI-safety gate this phase adds — must strip comments
before matching, so a code comment describing the forbidden pattern (like this very file) can never
accidentally satisfy or defeat the gate.

### Human-gated approval record, mirrored from Phase 7
**Source:** `docs/brand/APPROVAL.md` + `tests/unit/brand/approval-record.test.ts` (both read in full
above)
**Apply to:** `docs/ui/APPROVAL.md` + `tests/unit/ui/approval-record.test.ts` — three gate rows
(G1/G2/G3) instead of one concept row, same table/log/no-AI-attribution shape.

## No Analog Found

Files with no close match in the codebase (planner should use `08-UI-SPEC.md`/`08-RESEARCH.md`
patterns instead — both already contain concrete, Context7-verified or Next.js-16-verified code):

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `apps/web/src/app/(shell)/@inspector/default.tsx` | route (Next.js parallel-route slot) | — | No parallel route exists anywhere in this repo yet; `08-RESEARCH.md` Pattern 4's code block is the verified source to copy, not an existing file. |
| `packages/ui/src/motion-features.js` (domMax re-export for `LazyMotion`) | config | — | No prior `motion`/Framer Motion usage exists in this repo at all (D19 is this phase's first use); `08-RESEARCH.md` Pattern 1's code block is the verified source. |
| The keyboard-vs-pointer close-source capture-phase listener mechanism (inside `use-floating-menu.ts`) | interaction logic | event-driven | No existing component in this repo distinguishes close-by-keyboard from close-by-pointer; `08-UI-SPEC.md` §6.2 is the fully-specified design to implement fresh. |

## Metadata

**Analog search scope:** `packages/ui/src/` (all ~40 component/utility files), `apps/web/src/components/`
(all ~28 files), `apps/web/src/app/(shell)/`, `apps/web/src/lib/`, `scripts/` (root + `brand/`),
`tests/e2e/` (15 spec files), `tests/unit/brand/`, `docs/brand/`.
**Files scanned:** ~35 read in full or near-full (RowMenu, Sheet, Dialog, Disclosure, Tooltip,
ThemeToggle, SignOutButton, Sidebar, Toolbar, ServerFacts, SettingsGroups, ServerList, ServerRow,
DiscoverySection, DiscoveryStep, FirstTrustNotice, TrustFingerprintDialog, LabelValue, CopyButton,
StatTile, contrast.ts, check-ui-safety.mjs, tokens.css, geometry.ts, shell layout.tsx, index.ts,
RowMenu.test.tsx, shell.spec.ts, docs/brand/APPROVAL.md, approval-record.test.ts, review-paths.ts,
capture-brand-review.ts header); directory listings taken for the remainder.
**Pattern extraction date:** 2026-09-23
