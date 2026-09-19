import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

// The four variants skill SS4.1 defines. `destructive` is ghost-styled everywhere except inside
// a confirm dialog, where `filled` switches it to a solid `--status-error` fill.
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly loading?: boolean;
  readonly filled?: boolean;
  readonly children?: ReactNode;
}

// 32px height (h-8 against this project's 4px spacing base), --r-sm radius, 0 14px padding,
// --text-callout at weight 500 -- skill SS4.1's literal button spec. The focus ring
// (2px solid var(--accent), 2px offset) and the scale(0.97) press are CSS-only effects jsdom
// cannot compute; Playwright and Plan 05-21's noodara-ux-review audit verify them, not a
// component test (05-22-PLAN.md Task 2's own executor note).
const BASE_CLASSES = cn(
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-sm px-3.5',
  'text-callout font-medium',
  'outline-none transition-[opacity] duration-[var(--duration-micro)] ease-[var(--ease-standard)]',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'disabled:pointer-events-none disabled:opacity-50',
  'active:[transform:scale(0.97)]',
);

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:opacity-90',
  secondary: 'border border-hairline bg-surface-2 text-ink hover:bg-surface-3',
  ghost: 'bg-transparent text-ink-secondary hover:bg-surface-2',
  // Ghost by default (skill SS4.1: "nunca relleno rojo salvo en el botón de confirmación").
  destructive: 'bg-transparent text-status-error hover:bg-surface-2',
};

const DESTRUCTIVE_FILLED_CLASSES = 'bg-status-error text-on-accent hover:opacity-90';

// Button (skill SS4.1, 05-UI-SPEC.md Component Inventory). `loading` never renders a spinner --
// it keeps the label exactly as passed and communicates state through `disabled` + `aria-busy`
// alone, both asserted behaviourally in Button.test.tsx rather than by source grep.
export function Button({
  variant = 'primary',
  loading = false,
  filled = false,
  disabled = false,
  children,
  ...rest
}: ButtonProps) {
  const isDestructiveFilled = variant === 'destructive' && filled;
  const isDisabled = disabled || loading;

  return (
    <button
      {...rest}
      type={rest.type ?? 'button'}
      disabled={isDisabled}
      aria-busy={loading ? true : undefined}
      data-variant={variant}
      data-filled={isDestructiveFilled ? 'true' : 'false'}
      className={cn(BASE_CLASSES, isDestructiveFilled ? DESTRUCTIVE_FILLED_CLASSES : VARIANT_CLASSES[variant])}
    >
      {children}
    </button>
  );
}
