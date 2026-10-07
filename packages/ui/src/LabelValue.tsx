import { cn } from './cn.js';
import { CopyButton } from './CopyButton.js';
import { PLACEHOLDER } from './format.js';
import { MiddleTruncate } from './MiddleTruncate.js';

export interface LabelValueProps {
  readonly label: string;
  readonly value: string | null;
  readonly mono?: boolean;
  readonly copyable?: boolean;
  /** DETL-02's "facts from the last good discovery, attenuated" treatment -- surfaced as
   *  `data-dimmed` so the dimmed state is assertable from the DOM rather than a computed style. */
  readonly dimmed?: boolean;
  readonly caption?: string;
  /** 'middle' keeps a long value on one line, elided in the middle (14-13, A2). Otherwise a long
   *  value wraps anywhere rather than overflowing its card. */
  readonly truncate?: 'middle';
  readonly 'data-testid'?: string;
}

// Vertical padding comes from the single --row-height-padding-y token (D-14: 8px comfortable /
// 4px compact), not a hardcoded py-2 -- 8px is the same value comfortable renders today, so this
// is a no-op visually until a caller switches to compact density.
const ROOT_CLASSES = 'flex items-center justify-between gap-4 py-[var(--row-height-padding-y)]';
const LABEL_CLASSES = 'shrink-0 text-caption text-ink-secondary';
// The caption takes only the width the value leaves (basis 0), so a sentence never squeezes a short
// status word into breaking mid-word (14-13).
const CAPTION_CLASSES = 'min-w-0 flex-1 text-caption text-ink-tertiary';

// LabelValue (05-UI-SPEC.md SS2.5/SS2.7, skill SS4.6) -- a label/value row for the System/
// Docker/Connection groups and the Settings screen. `mono` renders technical values (host,
// fingerprint, IDs) in `--text-mono`; `dimmed` renders the value in `--ink-tertiary` and always
// carries `data-dimmed`, so DETL-02's attenuated last-good-discovery treatment is assertable
// without computing styles. The value span always carries `data-mono` (true/false, matching
// Input.tsx/Textarea.tsx's own always-present convention), added by Plan 05-16 so the Settings
// screen's own "every value is mono" behaviour (D-16) is assertable from the DOM rather than a
// computed style -- purely additive, no existing caller's rendered output changes. `copyable`
// renders exactly one `CopyButton` beside the value -- this component never renders a raw
// credential, since `ServerView` structurally cannot carry one (SEC-02); the fingerprint/public-
// URL/command rows are its only intended `copyable` callers.
export function LabelValue({
  label,
  value,
  mono = false,
  copyable = false,
  dimmed = false,
  caption,
  truncate,
  'data-testid': testId,
}: LabelValueProps) {
  const displayValue = value ?? PLACEHOLDER;
  const valueClasses = cn('text-callout', dimmed ? 'text-ink-tertiary' : 'text-ink', mono ? 'font-mono text-mono' : undefined);

  return (
    <div data-testid={testId} data-dimmed={dimmed ? 'true' : 'false'} className={ROOT_CLASSES}>
      <span className={LABEL_CLASSES}>{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-2">
        {caption !== undefined ? <span className={CAPTION_CLASSES}>{caption}</span> : null}
        {truncate === 'middle' && value !== null ? (
          <span data-mono={mono ? 'true' : 'false'} className={cn('flex min-w-0', valueClasses)} title={value}>
            <MiddleTruncate value={value} />
          </span>
        ) : (
          <span data-mono={mono ? 'true' : 'false'} className={cn('min-w-0 [overflow-wrap:anywhere]', valueClasses)}>
            {displayValue}
          </span>
        )}
        {copyable && value !== null ? <CopyButton value={value} label={`Copy ${label}`} /> : null}
      </div>
    </div>
  );
}
