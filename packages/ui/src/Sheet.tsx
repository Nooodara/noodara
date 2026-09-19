import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './Button.js';
import { cn } from './cn.js';

export interface SheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly 'data-testid'?: string;
}

// Translucent --surface-1 (skill SS2.3's "Translucent" elevation level) at the opacity/blur pair
// the skill names for sidebar/toolbar/sheets -- no bespoke token, the same treatment those
// surfaces already use.
const OVERLAY_CLASSES = 'fixed inset-0 z-40 bg-canvas/72';

const PANEL_CLASSES = cn(
  'fixed inset-y-0 right-0 z-50 flex h-full w-[480px] flex-col',
  'rounded-l-lg border-l border-hairline bg-surface-1/72 backdrop-blur-xl backdrop-saturate-[1.8]',
  'motion-safe:transition-transform motion-safe:duration-[var(--duration-sheet)] motion-safe:ease-[var(--ease-standard)]',
  'data-[state=open]:translate-x-0 data-[state=closed]:translate-x-full',
);

const HEADER_CLASSES = 'flex items-center justify-between border-b border-hairline px-8 py-6';
const BODY_CLASSES = 'flex-1 overflow-y-auto px-8 py-8';
const FOOTER_CLASSES = 'flex items-center justify-end gap-2 border-t border-hairline px-8 py-6';

// Sheet (05-UI-SPEC.md SS2.4, skill SS4.5) -- a 480px right-side panel on Radix Dialog. Radix
// owns focus trapping, Esc-to-close and outside-click dismissal entirely on its own (skill SS7,
// SS8's "Radix traps focus and closes on Esc -- do not override it"); this component adds none
// of those dismiss-event handlers or focus-style overrides itself. Real
// focus-trap/Esc/outside-click behaviour is verified by Plan 05-17's `@sheet` Playwright spec,
// not this file's jsdom test -- jsdom does not implement the layout and focus mechanics Radix's
// FocusScope depends on. `aria-describedby={undefined}` is Radix's own documented way to opt out
// of its "missing Description" dev warning when a sheet genuinely has no separate description
// beyond its title and body content (the body is exactly the caller's own composed content, not
// a fixed sentence this component could sensibly duplicate into a Description).
export function Sheet({ open, onOpenChange, title, children, footer, 'data-testid': testId }: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASSES} />
        <DialogPrimitive.Content className={PANEL_CLASSES} data-testid={testId} aria-describedby={undefined}>
          <div className={HEADER_CLASSES}>
            <DialogPrimitive.Title className="text-title font-semibold text-ink">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" aria-label="Close">
                <X aria-hidden="true" size={16} strokeWidth={1.5} />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className={BODY_CLASSES}>{children}</div>
          {footer ? <div className={FOOTER_CLASSES}>{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
