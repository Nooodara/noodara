import type { TextareaHTMLAttributes } from 'react';
import { cn } from './cn.js';

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  readonly mono?: boolean;
  readonly invalid?: boolean;
}

// --surface-2 fill, --r-sm radius, hairline border, --accent focus border -- same skill SS4.5
// spec as Input, except height is driven by the caller's `rows` prop rather than a fixed 36px.
const BASE_CLASSES = cn(
  'w-full resize-y rounded-sm border border-hairline bg-surface-2 px-3 py-2',
  'text-callout text-ink placeholder:text-ink-tertiary',
  'outline-none transition-[border-color,opacity] duration-[var(--duration-micro)] ease-[var(--ease-standard)]',
  'focus-visible:border-accent',
  'disabled:pointer-events-none disabled:opacity-50',
);

const INVALID_CLASSES = 'border-status-error';
const MONO_CLASSES = 'font-mono text-mono';

// Textarea (skill SS4.5, 05-UI-SPEC.md Component Inventory) -- the private-key/mono-content
// sibling of Input, same `mono`/`invalid`/`autoComplete` contract (see Input.tsx's doc comment
// for the autofill and no-value-duplication rules, both apply identically here).
export function Textarea({ mono = false, invalid = false, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      data-mono={mono ? 'true' : 'false'}
      aria-invalid={invalid ? true : undefined}
      className={cn(BASE_CLASSES, invalid ? INVALID_CLASSES : undefined, mono ? MONO_CLASSES : undefined)}
    />
  );
}
