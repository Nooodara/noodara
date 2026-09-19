import type { ReactNode } from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn.js';

export interface DisclosureProps {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly 'data-testid'?: string;
}

const TRIGGER_CLASSES = cn(
  'flex w-full items-center gap-2 py-2 text-left text-callout font-medium text-ink outline-none',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
);

// `prefers-reduced-motion` gates the chevron rotation and the content's open/close transition --
// Tailwind's `motion-safe:` variant compiles to `@media (prefers-reduced-motion: no-preference)`,
// the same gate Skeleton.tsx already uses, so both degrade to an instant, non-animated state the
// moment the user's OS-level reduced-motion preference is on (skill SS2.4/SS7).
const CHEVRON_CLASSES = cn(
  'h-4 w-4 shrink-0 text-ink-secondary motion-safe:transition-transform motion-safe:duration-[var(--duration-micro)]',
  'group-data-[state=open]:rotate-90',
);

const CONTENT_CLASSES = cn('motion-safe:transition-[grid-template-rows] motion-safe:duration-[var(--duration-panel)]');

// Disclosure (skill SS2.4/SS4, 05-UI-SPEC.md Component Inventory, D-16) -- a thin styling wrapper
// over `@radix-ui/react-collapsible`. Collapsed-by-default content is genuinely absent from the
// document (the primitive's own Presence-driven unmount, not a display/visibility toggle), which
// is what lets Plan 05-16's "the Advanced rows are absent on load" assertion and Plan 05-21's DOM
// canary scan (T-5-46) both hold. `aria-expanded` and the open/close toggle come entirely from
// the primitive -- this file adds no custom keydown handler and no custom animation handler of
// its own; the only motion is a CSS transition gated by `prefers-reduced-motion` above.
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
