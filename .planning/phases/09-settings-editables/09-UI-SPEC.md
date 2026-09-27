---
phase: 9
slug: settings-editables
status: draft
shadcn_initialized: false
preset: none
created: 2026-09-27
---

# Phase 9 — UI Design Contract

> Visual and interaction contract for `/settings`'s new editable surfaces (`apps/web` +
> `packages/ui`) and the two `/login` copy fixes this phase's auth work touches. This is **not** a
> new design system — the palette, type scale, spacing grid, radii and motion tokens are locked in
> `.claude/skills/noodara-ux-apple/SKILL.md`, `packages/ui/tokens.css` and Phase 8's
> `08-UI-SPEC.md` (`InsetGroup`, `Sheet`, `SegmentedControl`, floating elevation, motion contract,
> surface craft, a11y fallbacks — all reused unchanged). This document adds exactly what
> `09-CONTEXT.md`'s D-01…D-17 require and no more: the `Account` group's three editable rows and
> their per-field `Sheet` forms, the `Appearance` group's three `SegmentedControl` rows, the
> password-change `Notice`, and the `/login` notice + generic-failure-banner fix. Where this
> document and Phase 8's `08-UI-SPEC.md` conflict, `08-UI-SPEC.md` wins for anything it already
> specifies (elevation, motion, surface craft) — this document never re-specifies those, only cites
> them.
>
> Locked inputs this document does not reopen: `09-CONTEXT.md` D-01…D-17 (every decision below
> cites the D-number it implements), `08-UI-SPEC.md` §1 (`InsetGroup`), §5 (Floating Surfaces),
> §7 (Motion Contract), `09-RESEARCH.md`'s Architecture Patterns (server-authoritative preferences,
> custom `/api/account/*` endpoints), and `docs/ui-build-prompt.md` §9/§10.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — no shadcn/ui, no `components.json` (unchanged since Phase 5/8). Hand-built components on Radix primitives. |
| Preset | not applicable |
| Component library | Radix UI primitives (`@radix-ui/react-dialog` via `Sheet`, `@radix-ui/react-radio-group` via `SegmentedControl`) — no new primitive this phase. `motion@13.4.1` stays scoped exclusively to `Sheet.tsx` (D19, unchanged); this phase reuses `Sheet`, it does not touch its drag/motion internals. |
| Icon library | lucide-react, unchanged, `strokeWidth={1.5}`, 16/20px — this phase adds **zero new icons** (D-01: the `Edit` row control is a text button, "no icono nuevo") |
| Font | System stack per skill §2.2, unchanged |

---

## Tokens

Single source of truth: `packages/ui/tokens.css` (values) + `packages/ui/theme.css` (Tailwind v4
`@theme` binding). This phase verifies every existing token and adds exactly the two below (D-14).
No literal color/size/radius outside this file.

### Verify, do not touch

Every color/typography/spacing/radius/elevation/easing token from the skill and `08-UI-SPEC.md`
§Tokens (`--surface-elevated`, `--shadow-floating`, `--ease-*`, all eight `--text-*` roles,
`--space-*`, `--r-*`). This phase introduces zero new hues, zero new type roles, zero new radii.

### Add in this phase (`packages/ui/tokens.css`, `:root` only — theme-independent)

```css
/* Density (SET-05, D-14): the single source every row-bearing component (ListRow, InsetGroup
   rows, NavTree) reads instead of a hardcoded height. Comfortable is the default and is
   byte-identical to today's unlabeled 44px row height -- no visual change until a user opts into
   compact. */
--row-height: 44px;                          /* :root default = "comfortable" */
--row-height-padding-y: 8px;                 /* vertical padding paired with the row height above, on the 4px grid */

html[data-density="compact"] {
  --row-height: 36px;                        /* D-14's exact stated value */
  --row-height-padding-y: 4px;               /* 4px grid, not a proportional 8px*ratio value -- 36px row height minus
                                                 4px top + 4px bottom padding leaves 28px for the 20px-tall body text
                                                 line plus vertical centering */
}
```

Typography, inter-group spacing (`--space-6` between `InsetGroup` blocks) and page padding
(`--space-8`) are explicitly **not** touched by density (D-14) — only `--row-height` and
`--row-height-padding-y` ever read `[data-density]`.

**Tailwind v4 `@custom-variant` for `data-motion` (D-13):** `motion-safe`/`motion-reduce` are
redefined in `packages/ui/theme.css` to also read `html[data-motion="reduce"|"allow"]` in addition
to the existing `prefers-reduced-motion` media query, so every one of the ~15 existing
`motion-safe:`/`motion-reduce:` call sites (`press.ts`, `Sheet.tsx`, `Disclosure.tsx`, `RowMenu.tsx`,
etc.) keeps working unchanged. **The exact `@custom-variant` grammar is an implementation detail
the planner must verify against a real Tailwind v4 build before committing** (`09-RESEARCH.md`
Open Question 4/Assumption A2) — this document fixes the **contract** (an explicit `data-motion`
override always wins over the OS preference, same call-site class names), not the CSS syntax.

No new colors, no new type roles, no new radii, no new `--shadow-*`, no new `--space-*` value.

---

## Spacing Scale

Unchanged 8px grid (skill §2.3). This phase's only spacing decision is the density pair above.

| Token | Value | Usage in this phase |
|-------|-------|-------|
| `--space-2` | 8px | gap between `InsetGroup` title and block (unchanged, D-01/D-04 phase 8) |
| `--space-4` | 16px | `Account`/`Appearance` row horizontal padding (`px-4`, matches existing `SettingsRowView`/`Appearance` row convention) |
| `--space-6` | 24px | gap between `Account`, `Appearance`, `Instance`, `Advanced` blocks (unchanged) |
| `--row-height` | 44px / 36px (compact) | Account row height, Appearance row min-height, `ListRow`/`InsetGroup` rows app-wide |
| `--row-height-padding-y` | 8px / 4px (compact) | vertical padding on rows that are not a fixed-height flex row (the three `Appearance` rows, which today use `py-2` — see §3 below); 4px is on-grid, not a proportional derivation from 8px |

Exceptions: none new. Touch targets stay ≥44px everywhere a control is directly tappable —
including the `Edit` button and each `SegmentedControl` segment — **even in compact density**
(D-14 explicitly: density changes row height/padding only, never touch-target size; a compact
`SegmentedControl` segment keeps its existing `py-1`/`h-8`-class sizing untouched, only the *row*
around it shrinks).

---

## Typography

Unchanged eight-role scale (skill §2.2). No new size, weight or line-height — only which existing
role each new element uses:

| Role | Used in this phase for |
|------|------|
| `--text-title` (20/600) | `Sheet` title: "Edit name" / "Edit email" / "Change password" |
| `--text-body` (15/400) | Account row value text (name, email — plain text, never mono: these are not technical identifiers per skill §2.2's "mono para SHAs, puertos, IPs" rule) |
| `--text-callout` (13/400, 500 for labels) | Account/Appearance row labels ("Name", "Email", "Password", "Theme", "Reduce motion", "Density"); `Edit` button text (unchanged `Button` ghost variant styling); `SegmentedControl` segment labels (unchanged component) |
| `--text-caption` (12/400) | `Field` help/error text inside Sheets; `Notice` secondary text if used |
| `--text-body` (15/400, in `Notice`) | The password-change `Notice` message text (unchanged `Notice` component role) |

No screen in this phase exceeds three simultaneous typographic levels. The Password row shows
**no value text at all** (§Copywriting below) — never a masked placeholder, so it introduces no
new typographic treatment either.

---

## Color

Unchanged 60/30/10 split. This phase adds **zero new hues and zero new tokens for color**.

| Role | Token(s) | Usage this phase |
|------|-------|-------|
| Dominant (60%) | `--canvas` | unchanged page background |
| Secondary (30%) | `--surface-1` (`Account`/`Appearance` `InsetGroup` blocks, unchanged), `--surface-elevated` (edit Sheets, unchanged from Phase 8) | |
| Accent (10%) | `--accent` (focus rings only), `--accent-fill` (selected `SegmentedControl` segment, `Save` primary button — both unchanged existing usages, not new) | See reserved-for list below — **no new accent usage this phase** |
| Destructive | not used | This phase introduces no destructive action requiring `--status-error`/`--status-error-fill` — password change is reversible (the user still knows their own new password) and revoking other sessions is not itself styled as destructive (D-06: neutral `Notice`, not a `Banner`/error tone) |
| Error (field-level only) | `--status-error-text` | `Field`'s existing error-text role (unchanged component), used for "Current password is incorrect." and the other inline errors in §Copywriting |

**Accent remains reserved for exactly the same list `08-UI-SPEC.md` already fixed.** This phase
adds zero new accent usages: the `Edit` button is `ghost` variant (`--ink-secondary`, unchanged
`Button` component, no new variant), never `primary`/`accent`-filled — only the Sheet's own `Save`
button (already accent-filled everywhere in the product) carries accent, exactly like every other
Sheet's primary action.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Account row — Name | Label "Name", value = current name, trailing `Edit` button (ghost, `data-testid="account-edit-name"`) |
| Account row — Email | Label "Email", value = current email, trailing `Edit` button (`account-edit-email`) |
| Account row — Password | Label "Password", **no value text** (§9 #16 — never a credential, not even masked), trailing `Edit` button reads "Change" (`account-edit-password`) — the one row where the button verb differs, since "Edit" would imply an existing value is shown |
| Sheet title — Name | "Edit name" |
| Sheet title — Email | "Edit email" |
| Sheet title — Password | "Change password" |
| Sheet field labels — Name | "Name", "Current password" |
| Sheet field labels — Email | "Email", "Current password" |
| Sheet field labels — Password | "Current password", "New password", "Confirm new password" |
| Sheet footer — Name | "Cancel" (ghost) + "Save name" (primary, `accent-fill`, `data-testid="account-name-save"`) |
| Sheet footer — Email | "Cancel" (ghost) + "Save email" (primary, `data-testid="account-email-save"`) |
| Sheet footer — Password | "Cancel" (ghost) + "Save password" (primary, `data-testid="account-password-save"`) |
| Sheet footer — DOM/layout (all three) | Same left-to-right order as `ServerSheet.tsx`'s existing pattern: `Cancel` first in DOM, both right-aligned, `Cancel` visually left of the primary button. "Cancel" itself is an accepted project convention inherited from Phase 8 `Sheet`s (`08-UI-SPEC.md` — every existing Sheet footer uses bare "Cancel" for the dismiss action) — a documented exception to the generic-label rule, not a silent match; only the primary CTA needed a specific verb+noun. |
| Field error — wrong current password (all three sheets, `INVALID_CREDENTIAL`) | "Current password is incorrect." under the Current password field |
| Field error — email format | "Enter a valid email address." (reuses `login/page.tsx`'s existing `EMAIL_FIELD_ERROR` copy verbatim, under the Email field) |
| Field error — email domain unresolvable (`EMAIL_DOMAIN_UNRESOLVABLE`, D-03) | "We couldn't find a mail server for this domain. Check the address and try again." under the Email field |
| Field error — name length/format | "Name must be 1–80 characters." under the Name field |
| Field error — weak/common new password | "Password must be 12–128 characters and not be a commonly used password." under the New password field (reuses v0.1's policy wording pattern, never a raw server message) |
| Field error — new password mismatch | "Passwords don't match." under the Confirm new password field |
| Sheet-level error (any other/network failure) | `Banner` (existing component, unchanged), message: "Something went wrong. Try again." — never raw server text (§9 #17) |
| Notice after password save, count known (D-06) | "Password updated. {n} other session{s} were signed out." (singular "session was" when n = 1) |
| Notice after password save, count unknown (D-06 fallback) | "Password updated. Other sessions were signed out." |
| `/login` Notice after redirect (D-07) | "Signed out because your password changed." (`data-testid="login-password-changed-notice"`, same `Notice` component/placement as the existing `login-setup-notice`) |
| `/login` generic-failure fallback (Pitfall 6 fix, touched because this phase adds a new `/login` query param) | Any `ApiErrorCode` with no entry in `copyForErrorCode`'s map now falls back to "Something went wrong. Try again." instead of rendering no banner at all — the banner is now unconditional whenever `bannerMessage` is set, for every non-2xx/network outcome |
| Appearance row — Theme | Label "Theme", `SegmentedControl` options "Auto" / "Light" / "Dark" |
| Appearance row — Reduce motion | Label "Reduce motion", `SegmentedControl` options "System" / "On" / "Off" |
| Appearance row — Density | Label "Density", `SegmentedControl` options "Comfortable" / "Compact" |
| Empty/loading/destructive states | Not applicable — this phase adds no list, no empty state, and no destructive confirmation (password change is not modeled as destructive per D-06) |

All copy: English, sentence case, no exclamation marks (§9 #20). Never reveals whether an email
exists (D-discretion) — the email-domain-unresolvable error is about the **domain**, never about
whether the address is taken, and this is a single-admin system so no "email already in use"
message is ever shown.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|--------------|
| shadcn official | none — shadcn is not used | not applicable |
| third-party component registries | none declared this phase | not applicable — no registry vetting triggered |

This phase introduces no new npm dependency (`09-RESEARCH.md`'s Package Legitimacy Audit: empty,
every capability already installed) and no shadcn/registry block of any kind.

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending

---

## 1. `Account` `InsetGroup` (SET-02/SET-03, D-01)

**New composition**, not a new primitive: `apps/web/src/components/SettingsGroups.tsx` gains a new
`InsetGroup title="Account"` block, first in the group order (§Group order below), reusing the
existing `InsetGroup`/`ListRow`-adjacent row shape from Phase 8 — **no changes to
`packages/ui/src/InsetGroup.tsx` itself**.

### 1.1 Row shape (three rows: Name, Email, Password)

Each row: `--row-height` tall (44px comfortable / 36px compact, per §Tokens), `px-4` horizontal
padding, flex row: label (`--text-callout`, 500 weight, `--ink-secondary`, matches `Field`'s own
label treatment) on the left, value text (`--text-body`, `--ink`, Name/Email rows only) filling the
middle, `Edit`/`Change` button (`Button variant="ghost"`, existing component, **no new variant** —
this is what D-01's "rol callout" means: the button's own text sits at the existing `--text-callout`
size `Button`'s `BASE_CLASSES` already renders at, not a new button kind) right-aligned. Hairline
row separators from `InsetGroup`'s own `ROW_CLASSES` (unchanged).

```tsx
// apps/web/src/components/SettingsGroups.tsx -- illustrative shape, not the final diff
<InsetGroup title="Account" data-testid="settings-account-group">
  <div className="flex items-center justify-between gap-4 px-4" style={{ height: 'var(--row-height)' }}>
    <span className="text-callout font-medium text-ink-secondary">Name</span>
    <div className="flex items-center gap-3">
      <span className="text-body text-ink">{name}</span>
      <Button variant="ghost" onClick={openNameSheet} data-testid="account-edit-name">Edit</Button>
    </div>
  </div>
  {/* Email row: identical shape, data-testid="account-edit-email" */}
  {/* Password row: label + Button variant="ghost" data-testid="account-edit-password" reading
      "Change" -- no value slot rendered at all, per §Copywriting */}
</InsetGroup>
```

The bare "Edit" label on the Name/Email rows is intentional: the row's own label ("Name"/"Email")
sits immediately to its left, so "Edit" reads unambiguously as "Edit name"/"Edit email" in context
— it is not a standalone generic label. Password uses "Change" for the same contextual reason
(reading unambiguously as "Change password"), and additionally because no value is shown for that
row to imply there is something already visible to "edit" (§Copywriting, §9 #16).

### 1.2 Edit `Sheet`s (D-01, D-02)

Each `Edit`/`Change` button opens the **existing** `packages/ui/src/Sheet.tsx` (480px lateral
panel, unchanged elevation/motion from `08-UI-SPEC.md` §5/§7 — this phase adds no new Sheet
behavior). One `Sheet` instance per row, opened/closed via local `open` state exactly like
`ServerSheet.tsx`'s existing pattern.

**Name sheet** (`data-testid="account-name-sheet"`):
1. `Field label="Name"` → `Input` (`data-testid="account-name-input"`, `autoFocus`, `autoComplete="name"`)
2. `Field label="Current password"` → `Input type="password"` (`data-testid="account-current-password-input"`, `autoComplete="current-password"`)
3. Footer: `Cancel` (ghost) + `Save name` (primary, `data-testid="account-name-save"`, `loading` while the request is in flight)

**Email sheet** (`data-testid="account-email-sheet"`): identical shape, `Field label="Email"` →
`Input type="email"` (`data-testid="account-email-input"`, `autoComplete="email"`), same Current
password field, footer `Cancel` + `Save email` (`data-testid="account-email-save"`).

**Password sheet** (`data-testid="account-password-sheet"`):
1. `Field label="Current password"` → `Input type="password"` (`data-testid="account-current-password-input"`, `autoComplete="current-password"`)
2. `Field label="New password"` → `Input type="password"` (`data-testid="account-new-password-input"`, `autoComplete="new-password"`)
3. `Field label="Confirm new password"` → `Input type="password"` (`data-testid="account-confirm-password-input"`, `autoComplete="new-password"`)
4. Footer: `Cancel` + `Save password` (`data-testid="account-password-save"`)

**States (all three sheets, the "seven states" DoD requirement):**

| State | Treatment |
|---|---|
| default | Fields empty (Password sheet) or pre-filled with the current value (Name/Email sheets) |
| hover | `Button`'s existing hover classes, unchanged |
| focus | `Input`'s existing `focus-visible:border-accent`, unchanged; see §Accessibility for focus order |
| active | `PRESS_CLASSES` `scale(0.97)`, unchanged |
| disabled | The primary button (`Save name`/`Save email`/`Save password`) disabled while a required field is empty or `submitting` |
| loading | The primary button renders `loading` (existing `Button` prop — `aria-busy`, never a spinner, per §9 #4) while the request is in flight, label unchanged; both fields become read-only (`disabled`) for the duration so a resubmit cannot race the first |
| error | Field-level errors per §Copywriting under the specific field; a `Banner` (existing component) for any error that is not attributable to one field |

On success: the Sheet closes, the row's value updates immediately (Name/Email — no page reload,
D-04's session revalidation), and — Password only — the `Notice` from §2 below renders on the
Settings page itself (the Sheet is already closed by the time it appears).

---

## 2. Password-change `Notice` (SET-03, D-06)

Reuses the **existing** `packages/ui/src/Notice.tsx` unchanged (neutral surface, no semantic tone
— this is confirmation, not a warning). Rendered inline on `/settings`, above the `Account`
`InsetGroup`, immediately after a successful password save; dismissible (`Notice`'s existing
`onDismiss`).

```tsx
<Notice
  message={sessionsRevoked !== undefined
    ? `Password updated. ${sessionsRevoked} other session${sessionsRevoked === 1 ? '' : 's'} were signed out.`
    : 'Password updated. Other sessions were signed out.'}
  onDismiss={() => setShowPasswordNotice(false)}
  data-testid="account-password-notice"
/>
```

No pre-confirmation dialog (D-06 — no `Dialog` is introduced by this phase).

---

## 3. `Appearance` `InsetGroup` rewrite (SET-04/SET-05, D-12/D-13/D-15)

`SettingsGroups.tsx`'s existing `Appearance` `InsetGroup` (today: one row with `ThemeToggle`) is
**replaced** with three rows, same block, same title, same position in the group order — each row
reusing the *exact* layout the current single Appearance row already established
(`flex items-center justify-between gap-4 px-4 py-2`, label at `--text-callout`/`--ink-secondary`
matching `Field`'s label weight — note this pre-existing row uses `--text-caption` today; this
phase promotes all three Appearance labels to `--text-callout` for parity with the new `Account`
row labels, a one-line style fix noted here so the planner does not treat it as silent scope):

```tsx
<InsetGroup title="Appearance" data-testid="settings-appearance-group">
  <div className="flex items-center justify-between gap-4 px-4 py-2">
    <span className="text-callout font-medium text-ink-secondary">Theme</span>
    <SegmentedControl
      data-testid="settings-theme-control"
      value={theme}
      onValueChange={setTheme}
      options={[
        { value: 'auto', label: 'Auto' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ]}
    />
  </div>
  <div className="flex items-center justify-between gap-4 px-4 py-2">
    <span className="text-callout font-medium text-ink-secondary">Reduce motion</span>
    <SegmentedControl
      data-testid="settings-reduce-motion-control"
      value={reduceMotion}
      onValueChange={setReduceMotion}
      options={[
        { value: 'system', label: 'System' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ]}
    />
  </div>
  <div className="flex items-center justify-between gap-4 px-4 py-2">
    <span className="text-callout font-medium text-ink-secondary">Density</span>
    <SegmentedControl
      data-testid="settings-density-control"
      value={density}
      onValueChange={setDensity}
      options={[
        { value: 'comfortable', label: 'Comfortable' },
        { value: 'compact', label: 'Compact' },
      ]}
    />
  </div>
</InsetGroup>
```

`ThemeToggle` (`packages/ui/src/ThemeToggle.tsx`) is extended (not duplicated, P17) to also export
an explicit-value write function (`applyTheme(value: Mode)` or equivalent) that these three
`SegmentedControl`s call into — cycling icon-button UI is removed from `AccountMenu` (already done
in Phase 8 G3) and now also removed from Settings; **only the underlying write-path function
survives**, reused by all three controls (theme write path unchanged for theme; reduce-motion and
density get their own equivalent single-writer functions in the same file or a sibling module, per
`09-RESEARCH.md`'s Anti-Patterns section — never a second ad hoc `document.documentElement.setAttribute` call site).

No switches anywhere (D-15 — `SegmentedControl` only, matching Theme's existing pattern).

---

## 4. `/login` copy fixes (D-07, Pitfall 6)

### 4.1 New `Notice` for `?reason=password-changed`

`apps/web/src/app/login/page.tsx` gains a second query-param branch alongside the existing
`setup=success` one:

```tsx
const passwordChanged = searchParams.get('reason') === 'password-changed';
// ...
{passwordChanged ? (
  <Notice message="Signed out because your password changed." data-testid="login-password-changed-notice" />
) : null}
```

Same `Notice` component, same placement (above the form, below the card title) as
`login-setup-notice` — no new visual treatment.

### 4.2 Generic-failure banner always renders (deferred-items.md fix, touched because this phase
edits `/login` anyway for 4.1)

`genericFailureMessage`'s fallback path must never leave `bannerMessage` unset for a real failure:
any `ApiErrorCode` without an entry in `copyForErrorCode`'s map (e.g. `FORBIDDEN_ORIGIN`/
`INVALID_ORIGIN`) now falls back to the shared generic string "Something went wrong. Try again."
instead of the current silent no-banner behavior. This is the one behavioral (not purely visual)
fix this UI-SPEC requires alongside the copy addition, per `09-CONTEXT.md`'s Specifics section and
`08-deferred-items.md`'s explicit hand-off.

---

## 5. Accessibility Contract

### 5.1 Sheet focus order (Name/Email/Password sheets)

Radix's `FocusScope` (unchanged, `Sheet.tsx` untouched by this phase) traps focus inside the panel.
Visual/DOM/tab order, top to bottom, is identical across all three sheets:

1. Header `Close` button (X, `aria-label="Close"`, unchanged from `Sheet.tsx`)
2. First field's input (`autoFocus` — Radix moves initial focus here, not to the Close button,
   matching `ServerSheet.tsx`'s existing precedent of focusing the first meaningful field)
3. Subsequent fields in the order listed in §1.2 (top to bottom)
4. Footer `Cancel` button
5. Footer primary button (`Save name`/`Save email`/`Save password`)

Shift+Tab from the first field returns to the Close button (Radix's own wrap-around, unchanged).
Tab from the primary button wraps back to the Close button (Radix's own trap).

### 5.2 Focus return on close

On close (save success, Cancel, Esc, outside click), focus returns to the row's `Edit`/`Change`
button that opened the Sheet — the trigger element is captured explicitly at open time (a
`triggerRef` set in the row's `onClick` handler before `onOpenChange(true)`, per
`09-RESEARCH.md`'s note on `deferred-items.md`'s open Esc-focus-return gap: **this phase's own
Sheets must not inherit that gap**, since unlike `ServerSheet`'s externally-rendered "Add server"
button, each row's own `Edit` button is co-located with its Sheet's own open state and can own a
ref cleanly).

### 5.3 `aria-live` for Notices

The password-change `Notice` (§2) and the `/login` password-changed `Notice` (§4.1) both render
inside a container with `role="status"` (or `aria-live="polite"`) so a screen reader announces the
confirmation without requiring focus to move there — `Notice.tsx` itself gains this if it does not
already carry it; verify against the component's current markup before assuming a change is
needed.

### 5.4 `SegmentedControl` keyboard behavior

Unchanged — `packages/ui/src/SegmentedControl.tsx` is a Radix `RadioGroup`: arrow keys move
selection and commit immediately (no separate "confirm" step), `Tab` moves to/from the group as one
stop (roving tabindex), `Home`/`End` jump to first/last segment. This phase adds three new
instances of the existing component, no new keyboard handling.

### 5.5 Contrast, both themes

All three new label/value/button/control combinations reuse already-audited pairs
(`--ink-secondary`/`--surface-1` for labels, `--ink`/`--surface-1` for values,
`--on-accent`/`--accent-fill` for the selected `SegmentedControl` segment) — no new pair requires a
fresh `contrast.ts` entry. The one new visual state, the Password row's button reading "Change"
instead of "Edit", uses the identical `Button variant="ghost"` styling already audited.

### 5.6 375px layout

At 375px, each `Account`/`Appearance` row must not wrap its label/control onto two lines: `Edit`/
`Change` buttons and `SegmentedControl`s keep their existing compact sizing (`Button` 32px tall,
`SegmentedControl` segments `px-3.5 py-1`), and row labels truncate with `truncate` if a future
locale ever produces a longer string (not exercised by today's English copy, but the class is
applied defensively, matching `ListRow`'s own `truncate` precedent). Sheets are unaffected by
viewport width (fixed 480px panel per `Sheet.tsx`, sliding fully off-screen edge-to-edge is out of
this phase's scope — unchanged from Phase 8).

---

## 6. `data-testid` Contract

### 6.1 New (must ship in the same plan as the component)

| Element | testid |
|---|---|
| Account group | `settings-account-group` |
| Account row — Edit Name | `account-edit-name` |
| Account row — Edit Email | `account-edit-email` |
| Account row — Change Password | `account-edit-password` |
| Name sheet | `account-name-sheet`, fields `account-name-input` / `account-current-password-input`, save `account-name-save` |
| Email sheet | `account-email-sheet`, fields `account-email-input` / `account-current-password-input`, save `account-email-save` |
| Password sheet | `account-password-sheet`, fields `account-current-password-input` / `account-new-password-input` / `account-confirm-password-input`, save `account-password-save` |
| Password-change Notice | `account-password-notice` |
| Appearance controls | `settings-theme-control`, `settings-reduce-motion-control`, `settings-density-control` |
| `/login` password-changed Notice | `login-password-changed-notice` |

### 6.2 Unchanged (must not be renamed by this phase)

`settings-instance-group`, `settings-advanced-disclosure`, `settings-row-{slug}` (from
`settings-rows.ts`, `Instance`/`Advanced` rows only — `SettingsRow`'s own type is untouched per
SET-06/D-17), `login-setup-notice`, `login-banner`, `login-submit`. The old
`settings-appearance-theme-toggle` testid is **removed** — replaced by the three new Appearance
control testids above; any spec asserting the old id must be rewritten in the same plan that ships
the `Appearance` rewrite (same discipline `08-UI-SPEC.md` §11.3 already established for
`shell-theme-toggle`).

---

## 7. Group Order (Claude's Discretion, resolved)

`/settings` renders, top to bottom: `Account` (Name, Email, Password) → `Appearance` (Theme,
Reduce motion, Density) → `Instance` (unchanged) → `Advanced` `Disclosure` (unchanged). The screen's
only authored moment stays the `Advanced` `Disclosure`'s `grid-template-rows` expand/collapse
(`08-UI-SPEC.md` §8.3) — this phase adds no second moment; the password-change `Notice`'s entry is
a plain `--duration-panel` fade, not an authored moment.

`Account` is a peer `InsetGroup` with no new focal weighting versus `Appearance`/`Instance`/
`Advanced`; the only authored moment on the page remains the `Advanced` `Disclosure` (Phase 8
D-11).
