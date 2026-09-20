import { useRef, type KeyboardEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { cn } from './cn.js';

export interface RowMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
}

export interface RowMenuProps {
  readonly items: readonly RowMenuItem[];
  /** The trigger's accessible name -- must describe the row it acts on (e.g. "Actions for
   *  {server name}"), never a bare "..." glyph with no label (T-5-40). */
  readonly triggerLabel: string;
  readonly 'data-testid'?: string;
}

const TRIGGER_CLASSES = cn(
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ink-secondary outline-none',
  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-surface-2',
  'focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
);

const CONTENT_CLASSES = cn(
  'absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-hairline bg-surface-3 py-1',
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

// RowMenu (skill SS4.4, 05-UI-SPEC.md Component Inventory, D-09) -- the per-row "..." action
// menu, revealed on hover/focus of its row (never a permanent column) and never itself a bare,
// unlabelled icon. No approved Radix primitive (dialog, tooltip, collapsible, radio-group,
// scroll-area, visually-hidden, checkbox -- docs/adr/0000) is a purpose-built popover/menu, so
// this is built on @radix-ui/react-dialog's non-modal usage per 05-25-PLAN.md Task 1's own
// instruction -- see 05-25-SUMMARY.md's Decisions for the full reasoning. `modal={false}` gives
// outside-pointer-down dismiss, Escape-close and close -> trigger focus return entirely from the
// primitive (DialogContentNonModal); this file adds no hand-rolled dismiss logic of its own.
// `role="menu"`/`role="menuitem"` explicitly override the primitive's own default `role="dialog"`
// (DialogContent spreads caller props after its own role, so this override is safe) -- and having
// chosen the real WAI-ARIA menu pattern, this component owns the one behaviour the primitive does
// not provide for it: arrow-key roving focus between items.
export function RowMenu({ items, triggerLabel, 'data-testid': testId }: RowMenuProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  function menuItemNodes(): HTMLButtonElement[] {
    return Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  }

  function handleContentKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const nodes = menuItemNodes();
    if (nodes.length === 0) {
      return;
    }
    const currentIndex = nodes.findIndex((node) => node === document.activeElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = currentIndex < 0 ? 0 : (currentIndex + 1) % nodes.length;
      nodes[next]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const previous = currentIndex <= 0 ? nodes.length - 1 : currentIndex - 1;
      nodes[previous]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      nodes[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      nodes[nodes.length - 1]?.focus();
    }
  }

  return (
    <DialogPrimitive.Root modal={false}>
      <div className="relative inline-block">
        <DialogPrimitive.Trigger
          className={TRIGGER_CLASSES}
          data-testid={testId}
          data-hit-area={44}
          aria-haspopup="menu"
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
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            menuItemNodes()[0]?.focus();
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={cn(ITEM_CLASSES, item.destructive === true ? DESTRUCTIVE_ITEM_CLASSES : undefined)}
              onClick={() => {
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Root>
  );
}
