import type { CSSProperties } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { cn } from './cn.js';
import { PRESS_CLASSES } from './press.js';
import { useFloatingMenu } from './use-floating-menu.js';

export interface RowMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
  /** Stable identity for the rendered React key -- two items sharing the same `label` (e.g. two
   *  "Restart" actions on different sub-resources) must render as two distinct elements rather
   *  than colliding on a label-derived key; falls back to the item's own array index when
   *  omitted. */
  readonly id?: string;
}

export interface RowMenuProps {
  readonly items: readonly RowMenuItem[];
  /** The trigger's accessible name -- must describe the row it acts on (e.g. "Actions for
   *  {server name}"), never a bare "..." glyph with no label (T-5-40). */
  readonly triggerLabel: string;
  /** 'hover' (rows): revealed on row hover/focus on fine pointers. 'always' (toolbars): always shown. */
  readonly reveal?: 'hover' | 'always';
  readonly 'data-testid'?: string;
}

// Touch/coarse-pointer devices (08-UI-SPEC.md brief SS8.1 #2): the trigger stays fully opaque by
// default -- the hover-only reveal is gated behind `(hover: hover) and (pointer: fine)`, so a
// touch user (who can never trigger `:hover` in the first place) is never left with a
// permanently-invisible action. On a device that genuinely supports hover, the reveal-on-hover/
// focus-within behaviour is unchanged from before; `focus-visible:` still reveals unconditionally
// on every device, since keyboard focus is never gated behind a pointer capability.
const TRIGGER_BASE_CLASSES = cn(
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ink-secondary outline-none',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
);
const TRIGGER_CLASSES = cn(
  TRIGGER_BASE_CLASSES,
  '[@media(hover:hover)_and_(pointer:fine)]:opacity-0',
  '[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100',
  '[@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100',
  // UI-10 (08-06-PLAN.md Task 2): the hover reveal itself is gated the same way as the opacity
  // reveal above -- a tap on touch (which can never trigger `:hover`) must never leave this
  // trigger stuck highlighted.
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2',
  'focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
);

// UI-03 (08-06-PLAN.md Task 1, 08-UI-SPEC.md SS5.1/5.2): `--shadow-floating` applies to exactly
// four components -- Sheet, Dialog, RowMenu, AccountMenu (scripts/check-ui-safety.mjs's
// SHADOW_ALLOWLIST is the machine-checked gate that proves no other component ever gets one).
// `bg-surface-3` stays exactly as-is -- already the lightest surface tier in both themes, so no
// new elevated-surface token is needed here (unlike Sheet/Dialog).
//
// UI-10 (08-06-PLAN.md Task 2, 08-UI-SPEC.md SS10): `contrast-more:` (Tailwind's built-in variant
// for `prefers-contrast: more`) swaps the hairline for the strong token (T-08-19). No
// reduced-transparency override: RowMenu is already solid, nothing to drop.
// Mobile round 1 adjustment (09-14 checkpoint): `fixed`, not `absolute` -- this content is now
// rendered through `DialogPrimitive.Portal` (below), so it is no longer a descendant of the
// row's own `relative inline-block` wrapper and has no positioned ancestor to be `absolute`
// relative to in the first place. Its `top`/`right` (or `bottom`/`right`) coordinates are set
// inline from `menuStyle` (see the `useLayoutEffect` in `RowMenu` below), measured off the
// trigger's own bounding rect, never a CSS-only anchor -- the one thing that makes it immune to
// every ancestor's `overflow-hidden` (InsetGroup's own rounded card, T-mobile-round1) and to
// running out of horizontal room inside the row's own narrow DOM position.
const CONTENT_CLASSES = cn(
  'fixed z-50 min-w-[160px] rounded-md border border-hairline bg-surface-3 py-1',
  'shadow-[var(--shadow-floating)]',
  'contrast-more:border-hairline-strong',
  // UI-07 (08-14-PLAN.md Task 1, 08-UI-SPEC.md §7.2/§7.4): grows from the trigger's own corner,
  // never a hardcoded `origin-top-right` guess. This menu is built on the non-modal Dialog
  // primitive (D-05's own explicit ask), not Popper, so there is no `--radix-popper-transform-
  // origin` var here (unlike Tooltip.tsx, which has one) -- `right-0 top-full` on this element is
  // a fixed structural fact of its own positioning (its top-right corner always touches the
  // trigger's bottom-right corner), so the origin is set as a `--transform-origin` custom
  // property inline on this element itself (CONTENT_TRANSFORM_ORIGIN_STYLE below), from inside
  // this component, never from a call site.
  'origin-[var(--transform-origin)]',
  'motion-safe:transition-[transform,opacity] motion-safe:duration-[150ms] motion-safe:ease-[var(--ease-out)]',
  'motion-safe:data-[state=closed]:scale-[0.97] motion-safe:data-[state=closed]:opacity-0',
  'motion-safe:data-[state=open]:scale-100 motion-safe:data-[state=open]:opacity-100',
);

// Mobile round 1 adjustment (09-14 checkpoint): the vertical gap between the trigger and the
// portal-positioned content -- replaces the old `mt-1` Tailwind utility, which only worked while
// the content was `absolute` inside the trigger's own positioned wrapper.
const MENU_GAP_PX = 4;
// `ITEM_CLASSES`' own `h-9` (36px) times two items, plus the content's own `py-1` (4px top + 4px
// bottom) -- an estimate of the content's rendered height used only to decide, before paint,
// whether it should open downward (the common case) or upward when the trigger sits too close to
// the bottom of the viewport to fit it below (viewport-aware positioning, per the checkpoint's own
// wording). A slightly-off estimate only ever shifts the open direction near that boundary; it
// never affects layout once real content is measured, since this menu has no measured-height
// dependency of its own beyond deciding that one up/down branch.
const ESTIMATED_CONTENT_HEIGHT_PX = 36 * 2 + 8;

type MenuPosition = { readonly top: number; readonly right: number } | { readonly bottom: number; readonly right: number };

const CONTENT_TRANSFORM_ORIGIN_STYLE = { '--transform-origin': 'top right' } as CSSProperties;
const CONTENT_TRANSFORM_ORIGIN_STYLE_BOTTOM = { '--transform-origin': 'bottom right' } as CSSProperties;

function menuStyle(position: MenuPosition | null): CSSProperties {
  if (position === null) {
    // Not yet measured (the very first render after open, before the layout effect below runs) --
    // parked off-screen rather than left at the CSS-default static position, so there is never a
    // single visible frame at the wrong spot.
    return { top: 0, right: 0, visibility: 'hidden' };
  }
  return 'top' in position
    ? { top: position.top, right: position.right }
    : { bottom: position.bottom, right: position.right };
}

// Same hover-gating rationale as TRIGGER_CLASSES above (UI-10) -- a tap must never leave an item
// stuck in its hover-highlighted state. PRESS_CLASSES (UI-05, 08-20-PLAN.md Task 1) is the one
// shared press-feedback definition (press.ts, owned by 08-13) -- composed in, never redeclared.
const ITEM_CLASSES = cn(
  'flex h-9 w-full items-center px-3 text-left text-callout text-ink outline-none',
  '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2 focus-visible:bg-surface-2',
  PRESS_CLASSES,
);

// text-status-error-text, not text-status-error (05-33 continuation, WR-C-08 call-site fix,
// 2026-09-20): the base token measured 3.11:1 light / 4.20:1 dark on --surface-3 (this menu's own
// bg-surface-3) -- real AA failures on the "Delete" item's own text. The -text token clears 4.5:1
// on --surface-3 in both themes (measured, see contrast.test.ts).
const DESTRUCTIVE_ITEM_CLASSES = 'text-status-error-text';

// 08-20-PLAN.md Task 2 (UI-05/§9 #10, pitfall P14): mirrors Dialog.tsx's/Sheet.tsx's identical
// override -- appended to `CONTENT_CLASSES` only while the in-flight close is keyboard-initiated,
// read from `useFloatingMenu`'s own `closeSource` (delegated to the shared close-source primitive
// owned by 08-04; this file never calls that primitive directly). `!duration-0` wins the
// specificity fight against any un-flagged transition-duration utility a later plan (08-14,
// UI-07) composes into `CONTENT_CLASSES`.
const INSTANT_CLOSE_CLASS = '!duration-0';

// RowMenu (skill SS4.4, 05-UI-SPEC.md Component Inventory, D-09; 08-UI-SPEC.md SS6, 08-04-PLAN.md
// Task 2) -- the per-row "..." action menu, revealed on hover/focus of its row (never a permanent
// column) and never itself a bare, unlabelled icon. No approved Radix primitive (dialog, tooltip,
// collapsible, radio-group, scroll-area, visually-hidden, checkbox -- docs/adr/0000) is a
// purpose-built popover/menu, so this is built on @radix-ui/react-dialog's non-modal usage per
// 05-25-PLAN.md Task 1's own instruction -- see 05-25-SUMMARY.md's Decisions for the full original
// reasoning. `modal={false}` gives outside-pointer-down dismiss, Escape-close and close -> trigger
// focus return entirely from the primitive (DialogContentNonModal); this file adds no hand-rolled
// dismiss logic of its own. `role="menu"`/`role="menuitem"` explicitly override the primitive's
// own default `role="dialog"` (DialogContent spreads caller props after its own role, so this
// override is safe).
//
// Open state, arrow-key roving focus, close-on-select and close-source tracking all now come from
// `useFloatingMenu` -- the same hook `AccountMenu` (08-08) builds on, so this file owns only its
// own markup and item rendering, never a second copy of the shared floating-menu behaviour.
export function RowMenu({ items, triggerLabel, reveal = 'hover', 'data-testid': testId }: RowMenuProps) {
  const { open, setOpen, contentRef, handleContentKeyDown, handleOpenAutoFocus, selectItem, closeSource } =
    useFloatingMenu();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  // Mobile round 1 adjustment (09-14 checkpoint): measured, viewport-aware positioning -- opens
  // downward from the trigger's own bottom-right corner by default, flipping upward only when
  // there is genuinely not enough room below (a low-in-viewport trigger, e.g. the last row of a
  // long servers list). `useLayoutEffect` (not `useEffect`) runs synchronously before the browser
  // paints, so the very first frame the content is visible in already carries the real coordinates
  // -- never a flash at the parked `{ top: 0, right: 0 }` fallback. Re-measures on resize/scroll
  // while open so a device rotation or an in-page scroll never leaves a stale position behind.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }

    function measure(): void {
      const trigger = triggerRef.current;
      if (trigger === null) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const right = window.innerWidth - rect.right;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < ESTIMATED_CONTENT_HEIGHT_PX && rect.top > ESTIMATED_CONTENT_HEIGHT_PX) {
        setPosition({ bottom: window.innerHeight - rect.top + MENU_GAP_PX, right });
      } else {
        setPosition({ top: rect.bottom + MENU_GAP_PX, right });
      }
    }

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  const opensUpward = position !== null && 'bottom' in position;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={false}>
      <DialogPrimitive.Trigger
        ref={triggerRef}
        className={reveal === 'always' ? TRIGGER_BASE_CLASSES : TRIGGER_CLASSES}
        data-testid={testId}
        data-hit-area={44}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <VisuallyHidden.Root>{triggerLabel}</VisuallyHidden.Root>
        <span aria-hidden="true">{'⋯'}</span>
      </DialogPrimitive.Trigger>
      {/* Portal (Mobile round 1 adjustment, 09-14 checkpoint): re-parents the content to
          `document.body` (Radix's own default portal container, the same mechanism Sheet.tsx
          already relies on), so no ancestor between the trigger and the viewport -- InsetGroup's
          own `overflow-hidden` card chief among them -- can ever clip it again. */}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={contentRef}
          role="menu"
          aria-label={triggerLabel}
          className={cn(CONTENT_CLASSES, closeSource() === 'keyboard' && INSTANT_CLOSE_CLASS)}
          style={{ ...menuStyle(position), ...(opensUpward ? CONTENT_TRANSFORM_ORIGIN_STYLE_BOTTOM : CONTENT_TRANSFORM_ORIGIN_STYLE) }}
          onKeyDown={handleContentKeyDown}
          onOpenAutoFocus={handleOpenAutoFocus}
        >
          {items.map((item, index) => (
            <button
              key={item.id ?? index}
              type="button"
              role="menuitem"
              className={cn(ITEM_CLASSES, item.destructive === true ? DESTRUCTIVE_ITEM_CLASSES : undefined)}
              onClick={selectItem(item.onSelect)}
            >
              {item.label}
            </button>
          ))}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
