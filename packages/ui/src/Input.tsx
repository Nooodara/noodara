import type { InputHTMLAttributes } from 'react';
import { cn } from './cn.js';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  readonly mono?: boolean;
  readonly invalid?: boolean;
}

// 36px height (h-9 against this project's 4px spacing base), --surface-2 fill, --r-sm radius,
// hairline border, --accent focus border -- skill SS4.5's literal input spec.
const BASE_CLASSES = cn(
  'h-9 w-full rounded-sm border border-hairline bg-surface-2 px-3',
  'text-callout text-ink placeholder:text-ink-tertiary',
  'outline-none transition-[border-color,opacity] duration-[var(--duration-micro)] ease-[var(--ease-standard)]',
  'focus-visible:border-accent',
  'disabled:pointer-events-none disabled:opacity-50',
);

const INVALID_CLASSES = 'border-status-error';
const MONO_CLASSES = 'font-mono text-mono';

// Input (skill SS4.5, 05-UI-SPEC.md Component Inventory). `autoComplete` is always forwarded
// verbatim through `...rest` -- the component never substitutes a default, because both
// `off` (credential fields, T-5-32) and `username`/`current-password` (the login form) are
// legitimate depending on the call site. `value` is never copied into any attribute other
// than the control's own `value` -- a pasted private key must exist in exactly one place in
// the DOM (T-5-41), so this component adds no data-*/title/aria-label echo of it.
export function Input({ mono = false, invalid = false, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      data-mono={mono ? 'true' : 'false'}
      aria-invalid={invalid ? true : undefined}
      className={cn(BASE_CLASSES, invalid ? INVALID_CLASSES : undefined, mono ? MONO_CLASSES : undefined)}
    />
  );
}
