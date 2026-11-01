import { cn } from './cn.js';
import type { Tone } from './tone.js';

export interface TonePillProps {
  readonly tone: Tone;
  /** Always rendered as text: state is never colour-only. */
  readonly label: string;
  readonly 'data-testid'?: string;
}

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-status-ok-soft text-status-ok-text',
  warn: 'bg-status-warn-soft text-status-warn-text',
  error: 'bg-status-error-soft text-status-error-text',
  idle: 'bg-status-idle-soft text-status-idle-text',
};

const DOT_CLASSES: Record<Tone, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  error: 'bg-status-error',
  idle: 'bg-status-idle',
};

// TonePill (24-01): StatusPill's look for any infrastructure status already mapped to a Tone by
// the caller (DNS, certificate, proxy). The label is plain text; the dot is decorative.
export function TonePill({ tone, label, 'data-testid': testId = 'tone-pill' }: TonePillProps) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-caption font-medium',
        'transition-[color,background-color] duration-[150ms] ease-[var(--ease-out)]',
        TONE_CLASSES[tone],
      )}
    >
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASSES[tone])} />
      {label}
    </span>
  );
}
