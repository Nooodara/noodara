import type { ComponentProps, ReactElement, ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './cn.js';

// Radix's own built-in default (verified against @radix-ui/react-tooltip's source) -- made an
// explicit, named, documented constant here rather than left as an unstated library default, so
// the "a second hover within one session opens instantly" contract (08-UI-SPEC.md §7.2's Tooltip
// row) is a decision this codebase owns and can tune, not an implicit inherited value. A caller
// (or a test) may still override the provider's own repeat-hover skip-delay prop.
const DEFAULT_SKIP_DELAY_DURATION_MS = 300;

export type TooltipProviderProps = ComponentProps<typeof TooltipPrimitive.Provider>;

// Every screen that needs a tooltip-bearing component mounts exactly one provider ancestor --
// `packages/ui/src/testing/render.tsx`'s `renderUi` mounts this for every component test, and
// `apps/web`'s root layout mounts the same provider for the real app. A thin wrapper (not a bare
// re-export, unlike before 08-14) so the repeat-hover skip-delay prop below gets the explicit
// default above whenever a caller does not supply its own.
export function TooltipProvider(props: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider
      {...props}
      skipDelayDuration={props.skipDelayDuration ?? DEFAULT_SKIP_DELAY_DURATION_MS}
    />
  );
}

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactElement;
  /** Controlled open state. Undefined (the default) leaves the primitive's own hover/focus
   *  open logic untouched; `CopyButton` (Plan 05-24 Task 2) is the one caller that forces this
   *  open to show its transient "Copied" confirmation regardless of hover state. */
  readonly open?: boolean;
  readonly 'data-testid'?: string;
}

const CONTENT_CLASSES = cn(
  'z-50 max-w-xs rounded-sm border border-hairline bg-surface-3 px-2 py-1',
  'text-caption text-ink',
  // UI-07 (08-14-PLAN.md Task 1, 08-UI-SPEC.md §7.2/§7.4): Tooltip sits on
  // @radix-ui/react-popper underneath (unlike RowMenu/AccountMenu's hand-rolled Dialog
  // positioning), so its own Content wrapper already computes and exposes
  // `--radix-tooltip-content-transform-origin` (aliased from Popper's own
  // `--radix-popper-transform-origin`) -- this reads that variable directly rather than guessing
  // a static corner.
  'origin-[var(--radix-tooltip-content-transform-origin)]',
  'motion-safe:transition-[opacity] motion-safe:duration-[125ms] motion-safe:ease-[var(--ease-out)]',
  'motion-safe:data-[state=closed]:opacity-0',
  'motion-safe:data-[state=delayed-open]:opacity-100',
  'motion-safe:data-[state=instant-open]:opacity-100',
);

// Tooltip (skill SS4.6, 05-UI-SPEC.md Component Inventory) -- a thin styling wrapper over
// `@radix-ui/react-tooltip`. This file adds no keyboard handler, no pointer-down handler and no
// custom dismiss logic of its own: shown on hover and focus, dismissed on Escape/blur/outside
// interaction, are all the primitive's own built-in behaviour, untouched here. Used for ISO
// timestamps (`RelativeTime`) and the collapsed sidebar's item labels.
export function Tooltip({ content, children, open, 'data-testid': testId }: TooltipProps) {
  return (
    <TooltipPrimitive.Root {...(open === undefined ? {} : { open })}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content data-testid={testId} sideOffset={4} className={CONTENT_CLASSES}>
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
