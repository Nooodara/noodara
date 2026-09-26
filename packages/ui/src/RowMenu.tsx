import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { cn } from './cn.js';
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
  readonly 'data-testid'?: string;
}

// Touch/coarse-pointer devices (08-UI-SPEC.md brief SS8.1 #2): the trigger stays fully opaque by
// default -- the hover-only reveal is gated behind `(hover: hover) and (pointer: fine)`, so a
// touch user (who can never trigger `:hover` in the first place) is never left with a
// permanently-invisible action. On a device that genuinely supports hover, the reveal-on-hover/
// focus-within behaviour is unchanged from before; `focus-visible:` still reveals unconditionally
// on every device, since keyboard focus is never gated behind a pointer capability.
const TRIGGER_CLASSES = cn(
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ink-secondary outline-none',
  '[@media(hover:hover)_and_(pointer:fine)]:opacity-0',
  '[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100',
  '[@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100',
  'hover:bg-surface-2',
  'focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
);

// UI-03 (08-06-PLAN.md Task 1, 08-UI-SPEC.md SS5.1/5.2): `--shadow-floating` applies to exactly
// four components -- Sheet, Dialog, RowMenu, AccountMenu (scripts/check-ui-safety.mjs's
// SHADOW_ALLOWLIST is the machine-checked gate that proves no other component ever gets one).
// `bg-surface-3` stays exactly as-is -- already the lightest surface tier in both themes, so no
// new elevated-surface token is needed here (unlike Sheet/Dialog).
const CONTENT_CLASSES = cn(
  'absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-hairline bg-surface-3 py-1',
  'shadow-[var(--shadow-floating)]',
);

const ITEM_CLASSES = cn(
  'flex h-9 w-full items-center px-3 text-left text-callout text-ink outline-none',
  'hover:bg-surface-2 focus-visible:bg-surface-2',
);

// text-status-error-text, not text-status-error (05-33 continuation, WR-C-08 call-site fix,
// 2026-09-20): the base token measured 3.11:1 light / 4.20:1 dark on --surface-3 (this menu's own
// bg-surface-3) -- real AA failures on the "Delete" item's own text. The -text token clears 4.5:1
// on --surface-3 in both themes (measured, see contrast.test.ts).
const DESTRUCTIVE_ITEM_CLASSES = 'text-status-error-text';

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
export function RowMenu({ items, triggerLabel, 'data-testid': testId }: RowMenuProps) {
  const { open, setOpen, contentRef, handleContentKeyDown, handleOpenAutoFocus, selectItem } = useFloatingMenu();

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={false}>
      <div className="relative inline-block">
        <DialogPrimitive.Trigger
          className={TRIGGER_CLASSES}
          data-testid={testId}
          data-hit-area={44}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <VisuallyHidden.Root>{triggerLabel}</VisuallyHidden.Root>
          <span aria-hidden="true">{'⋯'}</span>
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Content
          ref={contentRef}
          role="menu"
          aria-label={triggerLabel}
          className={CONTENT_CLASSES}
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
      </div>
    </DialogPrimitive.Root>
  );
}
