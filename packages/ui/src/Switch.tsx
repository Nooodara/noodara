import { cn } from './cn.js';

export interface SwitchProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** Accessible name; the visible label is the caller's. */
  readonly label: string;
  readonly disabled?: boolean;
  readonly 'data-testid'?: string;
}

// Switch (24-01): a native button with role="switch" so Space/Enter toggle it without custom key
// handling. The accent fill is the one action colour; the off state is a neutral surface.
export function Switch({ checked, onCheckedChange, label, disabled = false, 'data-testid': testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      data-state={checked ? 'on' : 'off'}
      onClick={() => {
        onCheckedChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-pill border border-hairline',
        'transition-[background-color] duration-[150ms] ease-[var(--ease-out)]',
        'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent-fill' : 'bg-surface-2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-5 w-5 rounded-full',
          'motion-safe:transition-transform motion-safe:duration-[150ms] motion-safe:ease-[var(--ease-out)]',
          checked ? 'translate-x-[17px] bg-on-accent' : 'translate-x-[1px] bg-ink-tertiary',
        )}
      />
    </button>
  );
}
