import type { ReactElement, ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from './cn.js';

// Re-exported so every screen that needs a tooltip-bearing component mounts exactly one
// provider ancestor -- `packages/ui/src/testing/render.tsx`'s `renderUi` mounts this for every
// component test, and `apps/web`'s root layout mounts the same provider for the real app.
export const TooltipProvider = TooltipPrimitive.Provider;

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
