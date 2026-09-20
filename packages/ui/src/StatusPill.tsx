import type { ServerStatus } from '@noodara/domain/server';
import { cn } from './cn.js';
import { serverStatusTone, STATUS_WORDS, type Tone } from './tone.js';

export interface StatusPillProps {
  readonly status: ServerStatus;
}

// One class pair per Tone: `-soft` background, tone-specific `-text` word colour (Plan 05-33
// continuation, decision D1, 2026-09-20 -- supersedes skill SS2.1's original "el texto sobre
// -soft usa el color pleno", which failed AA at pill (12px) size in both themes; see
// docs/contrast-decision-05.md and the SKILL.md exception note this decision added). The dot
// below no longer reads `bg-current` -- see DOT_CLASSES -- because the word and the dot must be
// allowed to diverge in colour now that the word is tuned for contrast, not full saturation.
const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-status-ok-soft text-status-ok-text',
  warn: 'bg-status-warn-soft text-status-warn-text',
  error: 'bg-status-error-soft text-status-error-text',
  idle: 'bg-status-idle-soft text-status-idle-text',
};

// The dot stays at full saturation (D1: "dots, borders, meters stay vivid") via an explicit class
// per tone, independent of whatever colour the word (TONE_CLASSES, above) now uses.
const DOT_CLASSES: Record<Tone, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  error: 'bg-status-error',
  idle: 'bg-status-idle',
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
        className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASSES[tone], pulsing && 'motion-safe:animate-pulse')}
      />
      {STATUS_WORDS[status]}
    </span>
  );
}
