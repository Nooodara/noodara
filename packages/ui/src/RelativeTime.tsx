import { formatIso, formatRelativeTime } from './format.js';
import { Tooltip } from './Tooltip.js';

export interface RelativeTimeProps {
  readonly value: string | null;
  /** The caller's own clock, always explicit -- this component never reads the platform clock
   *  itself (matching `format.ts`'s own discipline), so its output is deterministic in tests and
   *  regardless of the runner's timezone/locale. */
  readonly now: Date;
  readonly 'data-testid'?: string;
}

const TEXT_CLASSES = 'text-caption text-ink-secondary';

// RelativeTime (05-UI-SPEC.md's "as of" labelling, D-11, T-5-61) -- the single component every
// timestamp in the app renders through. Renders `formatRelativeTime` as its visible text while
// structurally carrying the exact instant: a valid ISO input wraps its `<time dateTime>` element
// in a `Tooltip` whose content is the full ISO string (`formatIso`), so a point-in-time snapshot
// can never be read as a live value without its date also being one hover/focus away. A `null`
// value renders the shared placeholder with no `<time>` element and no tooltip -- there is no
// instant to carry.
export function RelativeTime({ value, now, 'data-testid': testId }: RelativeTimeProps) {
  const text = formatRelativeTime(value, now);

  if (value === null) {
    return (
      <span data-testid={testId} className={TEXT_CLASSES}>
        {text}
      </span>
    );
  }

  return (
    <Tooltip content={formatIso(value)}>
      <time dateTime={value} data-testid={testId} className={TEXT_CLASSES}>
        {text}
      </time>
    </Tooltip>
  );
}
