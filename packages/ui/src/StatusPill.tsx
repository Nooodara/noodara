import type { ServerStatus } from '@noodara/domain/server';
import { cn } from './cn.js';
import { serverStatusTone, STATUS_WORDS, type Tone } from './tone.js';

export interface StatusPillProps {
  readonly status: ServerStatus;
}

// One class pair per Tone: `-soft` background, full-saturation text (skill SS2.1 -- "el texto
// sobre -soft usa el color pleno"). The dot below reads `bg-current` so it inherits this same
// full-saturation colour from its parent's text colour, with no separate token lookup.
const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-status-ok-soft text-status-ok',
  warn: 'bg-status-warn-soft text-status-warn',
  error: 'bg-status-error-soft text-status-error',
  idle: 'bg-status-idle-soft text-status-idle',
};

// StatusPill (skill SS4.2, 05-UI-SPEC.md SS8): state is never colour-only -- the STATUS_WORDS
// word is always in the DOM text content, and the dot carries no meaning of its own
// (aria-hidden). `motion-safe:` is Tailwind's `@media (prefers-reduced-motion: no-preference)`
// variant -- the functional inverse of, and equivalent gate to, "run the pulse unless the user
// has requested @media (prefers-reduced-motion: reduce)": reduced motion always degrades to a
// static dot. This component owns no live-region behaviour of its own -- that belongs to the
// discovery section (a later plan), so two live regions never double-announce the same change.
export function StatusPill({ status }: StatusPillProps) {
  const tone = serverStatusTone(status);
  const pulsing = status === 'CONNECTING';

  return (
    <span
      data-testid="status-pill"
      data-status={status}
      data-tone={tone}
      data-pulsing={pulsing ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5',
        'text-caption font-medium',
        TONE_CLASSES[tone],
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 rounded-full bg-current', pulsing && 'motion-safe:animate-pulse')}
      />
      {STATUS_WORDS[status]}
    </span>
  );
}
