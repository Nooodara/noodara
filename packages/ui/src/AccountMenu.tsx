import { type ComponentType, type CSSProperties, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from './cn.js';
import { PRESS_CLASSES } from './press.js';
import { useFloatingMenu } from './use-floating-menu.js';

/** The minimal prop surface `AccountMenu` needs from whatever link primitive the caller's router
 *  provides -- same `linkComponent` discipline `NavTree.tsx` already established (D-07): this
 *  package has no router dependency of its own and must never gain one. `role` is always
 *  `'menuitem'` here (not a wider string) so the "Settings" row is unambiguously one of the two
 *  arrow-key-navigable items `use-floating-menu.ts`'s `[role="menuitem"]` query picks up. */
export interface AccountMenuLinkProps {
  readonly href: string;
  readonly role: 'menuitem';
  readonly 'data-testid': string;
  readonly onClick: () => void;
  readonly className: string;
  readonly children: ReactNode;
}

// The shell's single account affordance (UI-11, D-05/D-06). Deliberately no `items` array and no
// caller-supplied extra rows -- the fixed two-row shape (Settings / Sign out) is enforced by this
// prop type itself, the same discipline `ToolbarProps.primaryAction` already applies elsewhere in
// this package. A future caller (Phase 9: profile editing, preferences) adds fields to this same
// interface; it never gains a generic slot a caller could use to reshape the menu.
//
// 08-19-PLAN.md Task 3 (G3 adjustment round 1, item 5, D-05 change): Appearance's inline
// `ThemeToggle` used to be this menu's middle row -- moved into an Appearance `InsetGroup` on
// `/settings` instead (`apps/web/src/components/SettingsGroups.tsx`), per the user's own G3
// review ("Creo que es mejor que la apariencia esté en settings y no como sección aparte").
// `ThemeToggle`'s own `STORAGE_KEY` still has exactly one writer; only its mount point moved.
export interface AccountMenuProps {
  readonly name: string;
  readonly email: string;
  readonly settingsHref: string;
  readonly linkComponent: ComponentType<AccountMenuLinkProps>;
  /** The sign-out control, rendered as an opaque last row -- `SignOutButton` (apps/web) is the
   *  one implementation of the close-stream/POST/navigate sequence; this component never
   *  substitutes or duplicates it (T-08-24). The slot's own root element is expected to carry
   *  `role="menuitem"` so it participates in the same arrow-key roving focus as "Settings". */
  readonly signOutSlot: ReactNode;
  /** Forces the avatar-only, no-name rendering unconditionally, overriding the CSS-only
   *  responsive behaviour below. Unused by `Sidebar.tsx` today (its three breakpoints are already
   *  expressed as pure Tailwind classes, identical technique to `NavTree.tsx`'s own
   *  `hidden min-[1280px]:inline` label -- no JS-computed, hydration-risking breakpoint boolean is
   *  needed for the common case); kept for a future caller that only ever renders the collapsed
   *  rail form. */
  readonly railOnly?: boolean;
  readonly 'data-testid'?: string;
}

const DEFAULT_TRIGGER_TESTID = 'shell-account-menu-trigger';

function getInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return '';
  const first = tokens[0]?.[0] ?? '';
  if (tokens.length === 1) return first.toUpperCase();
  const last = tokens[tokens.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase();
}

// D-06: a monochrome surface-3 circle with a hairline and ink initials -- never the app's one
// blue action colour or any of its fill/soft variants (the mark stays monochrome inside the app
// exactly like Phase 7's brand mark, D-09's precedent). `size` mirrors 08-UI-SPEC.md SS4.1/4.3's two
// literal diameters: 28px everywhere except the 900-1279px rail, where it grows to 32px -- the
// three-way swap (28 sheet / 32 rail / 28 expanded) is pure Tailwind, the same
// hidden-at-one-breakpoint-only technique `Sidebar.tsx`'s own brand blocks already use, so no
// JS-computed breakpoint boolean is needed here either.
const AVATAR_TRIGGER_CLASSES = cn(
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-3 text-label text-ink',
  'min-[900px]:h-8 min-[900px]:w-8 min-[1280px]:h-7 min-[1280px]:w-7',
);
const AVATAR_TRIGGER_RAIL_ONLY_CLASSES =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-3 text-label text-ink';
const AVATAR_HEADER_CLASSES =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-3 text-label text-ink';

function Avatar({ initials, className }: { readonly initials: string; readonly className: string }) {
  return (
    <span aria-hidden="true" className={className}>
      {initials}
    </span>
  );
}

// Touch-target row height (44px, matches NavTree leaves and RowMenu's own trigger convention) --
// hover reveal gated behind `(hover: hover) and (pointer: fine)` (UI-10) so a tap on touch never
// leaves the trigger stuck highlighted. The focus ring is `--ink`, deliberately not the app's one
// blue action colour: D-06 keeps this whole component monochrome, and a focus indicator is not a
// call to action.
// 08-19-PLAN.md Task 3 (G3 adjustment round 1, item 4): the trigger is `w-full` at every
// breakpoint so its hover/pressed surface spans the whole sidebar row, but the content inside it
// (avatar, plus name once visible) was always left-aligned via `px-3` -- fine once the name is
// showing, but in the 900-1279px icon rail (where `NAME_CLASSES` hides the name) that pinned the
// avatar to the row's left edge while the hover rectangle kept the full row's width, reading as a
// highlight offset up-left of the circle. `justify-center` only for that one rail breakpoint
// (mirroring `NAME_CLASSES`'s own three-breakpoint shape) re-centres the lone avatar in the
// rectangle without disturbing the left-aligned avatar+name row at the sheet width or expanded
// sidebar, where a centred layout would look wrong next to `NavTree`'s own left-aligned items.
const TRIGGER_JUSTIFY_CLASSES = 'justify-start min-[900px]:justify-center min-[1280px]:justify-start';
// `railOnly` forces the avatar-only rendering unconditionally (no responsive name to react to),
// so its own trigger is centred at every width rather than riding the three-breakpoint shape
// above.
const TRIGGER_JUSTIFY_RAIL_ONLY_CLASSES = 'justify-center';
const TRIGGER_CLASSES = cn(
  'flex h-11 w-full items-center gap-3 rounded-sm px-3 text-ink outline-none',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
);

// Name shown at the sheet width (<900px) and the expanded sidebar (>=1280px), hidden only across
// the 900-1279px rail -- the reverse of `Sidebar.tsx`'s own BRAND_RAIL_CLASSES/
// BRAND_EXPANDED_CLASSES pair, same three literal breakpoints.
const NAME_CLASSES = 'truncate text-callout font-medium text-ink min-[900px]:hidden min-[1280px]:inline';

// 288px (8px-grid-aligned, wider than RowMenu's 160px min-width to fit the header row),
// bg-surface-3 (unchanged, already the lightest surface tier in both themes -- same reasoning as
// RowMenu, 08-UI-SPEC.md SS5.2), the same allowlisted `--shadow-floating` level as RowMenu (UI-03)
// and the same `prefers-contrast: more` border-strong swap RowMenu got in 08-06-PLAN.md Task 2.
const CONTENT_CLASSES = cn(
  'absolute bottom-full left-0 z-50 mb-1 w-[288px] rounded-md border border-hairline bg-surface-3',
  'shadow-[var(--shadow-floating)]',
  'contrast-more:border-hairline-strong',
  // UI-07 (08-14-PLAN.md Task 1, 08-UI-SPEC.md §7.2/§7.4): same origin-anchoring treatment as
  // RowMenu.tsx's identical comment -- this menu is also built on the non-modal Dialog primitive
  // (no Popper var available), but its own `bottom-full left-0` positioning always anchors its
  // bottom-left corner to the trigger's top-left corner instead, so the inline custom property
  // (CONTENT_TRANSFORM_ORIGIN_STYLE below) carries the opposite value from RowMenu's.
  'origin-[var(--transform-origin)]',
  'motion-safe:transition-[transform,opacity] motion-safe:duration-[150ms] motion-safe:ease-[var(--ease-out)]',
  'motion-safe:data-[state=closed]:scale-[0.97] motion-safe:data-[state=closed]:opacity-0',
  'motion-safe:data-[state=open]:scale-100 motion-safe:data-[state=open]:opacity-100',
);

const CONTENT_TRANSFORM_ORIGIN_STYLE = { '--transform-origin': 'bottom left' } as CSSProperties;

const HEADER_CLASSES = 'flex items-center gap-3 p-4';
const DIVIDER_CLASSES = 'border-t border-hairline';

// 08-20-PLAN.md Task 2 (UI-05/§9 #10, pitfall P14): mirrors RowMenu.tsx's/Dialog.tsx's identical
// override -- appended to `CONTENT_CLASSES` only while the in-flight close is keyboard-initiated,
// read from `useFloatingMenu`'s own `closeSource` (delegated to the shared close-source primitive
// owned by 08-04; this file never calls that primitive directly).
const INSTANT_CLOSE_CLASS = '!duration-0';
// PRESS_CLASSES (UI-05, 08-20-PLAN.md Task 1) is the one shared press-feedback definition
// (press.ts, owned by 08-13) -- composed in, never redeclared.
const ITEM_CLASSES = cn(
  'flex h-11 w-full items-center px-4 text-left text-body text-ink outline-none',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2 focus-visible:bg-surface-2',
  PRESS_CLASSES,
);
const SIGN_OUT_ROW_CLASSES = 'px-2 py-1';

// AccountMenu (UI-11, D-05/D-06, 08-UI-SPEC.md SS4) -- the shell's single account affordance,
// replacing the old ThemeToggle + SignOutButton cluster. Built on the same shared floating-menu
// hook (imported below, SS4.4's explicit ask) `RowMenu` builds on: open state, arrow-key roving
// focus, close-on-select and keyboard-vs-pointer close-source tracking all come from that one
// hook -- this file owns only its own unique content (the header row), never a second hand-rolled
// dismiss/focus implementation.
export function AccountMenu({
  name,
  email,
  settingsHref,
  linkComponent: LinkComponent,
  signOutSlot,
  railOnly = false,
  'data-testid': testId,
}: AccountMenuProps) {
  const { open, setOpen, contentRef, handleContentKeyDown, handleOpenAutoFocus, selectItem, closeSource } =
    useFloatingMenu();
  const initials = getInitials(name);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={false}>
      <div className="relative w-full">
        <DialogPrimitive.Trigger
          className={cn(TRIGGER_CLASSES, railOnly ? TRIGGER_JUSTIFY_RAIL_ONLY_CLASSES : TRIGGER_JUSTIFY_CLASSES)}
          data-testid={testId ?? DEFAULT_TRIGGER_TESTID}
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Avatar initials={initials} className={railOnly ? AVATAR_TRIGGER_RAIL_ONLY_CLASSES : AVATAR_TRIGGER_CLASSES} />
          {railOnly ? null : <span className={NAME_CLASSES}>{name}</span>}
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Content
          ref={contentRef}
          role="menu"
          aria-label="Account menu"
          className={cn(CONTENT_CLASSES, closeSource() === 'keyboard' && INSTANT_CLOSE_CLASS)}
          style={CONTENT_TRANSFORM_ORIGIN_STYLE}
          onKeyDown={handleContentKeyDown}
          onOpenAutoFocus={handleOpenAutoFocus}
        >
          <div data-part="account-menu-header" className={HEADER_CLASSES}>
            <Avatar initials={initials} className={AVATAR_HEADER_CLASSES} />
            <div className="min-w-0">
              <p className="truncate text-title text-ink">{name}</p>
              <p className="truncate text-caption text-ink-secondary">{email}</p>
            </div>
          </div>
          <div className={DIVIDER_CLASSES} />
          <LinkComponent
            href={settingsHref}
            role="menuitem"
            data-testid="shell-account-menu-settings-link"
            onClick={selectItem((): void => undefined)}
            className={ITEM_CLASSES}
          >
            Settings
          </LinkComponent>
          <div className={DIVIDER_CLASSES} />
          <div className={SIGN_OUT_ROW_CLASSES}>{signOutSlot}</div>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Root>
  );
}
