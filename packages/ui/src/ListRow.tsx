import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { PRESS_CLASSES } from './press.js';

// Exactly one of href/onActivate must be given -- a discriminated union rather than two loose
// optional props, so `<ListRow />` with neither (or both) fails to type-check instead of
// silently rendering a dead row.
type ListRowActivation =
  | { readonly href: string; readonly onActivate?: undefined }
  | { readonly href?: undefined; readonly onActivate: () => void };

export type ListRowProps = ListRowActivation & {
  readonly primaryText: ReactNode;
  readonly secondary?: ReactNode;
  readonly trailing?: ReactNode;
  readonly 'data-testid'?: string;
};

// UI-10 (08-06-PLAN.md Task 2, 08-UI-SPEC.md SS10): the row hover reveal is gated behind
// `(hover: hover) and (pointer: fine)` -- a tap on touch (which can never trigger `:hover`) must
// never leave a row stuck in its hover-highlighted state.
// D-14: row height comes from the single --row-height token (44px comfortable / 36px in compact
// density) rather than a hardcoded pixel value.
const ROW_CLASSES = cn(
  'group flex h-[var(--row-height)] items-center border-b border-hairline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2',
);

// The press feedback itself comes from the one shared `PRESS_CLASSES` definition (08-13-PLAN.md,
// UI-05) -- see packages/ui/src/press.ts.
const ACTIVATION_CLASSES = cn(
  'flex min-w-0 flex-1 items-center gap-4 px-4 text-left outline-none',
  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
  PRESS_CLASSES,
);

// 14-13 (A3): the name never shrinks, it is only capped at the row width; the description absorbs
// every missing pixel, so the name truncates only once the description is gone. (A weighted
// flex-shrink still took a sub-pixel from the name, which is enough to draw an ellipsis.)
const PRIMARY_TEXT_CLASSES = 'max-w-full shrink-0 truncate text-headline font-semibold text-ink';
const SECONDARY_CLASSES = 'min-w-0 truncate text-callout text-ink-secondary';
const TRAILING_CLASSES = 'flex shrink-0 items-center pr-4';

// ListRow (skill SS4.4, 05-UI-SPEC.md Component Inventory, D-09) -- the hairline row (height from
// the --row-height token, D-14) every list this phase needs (servers, activity) is built from.
// Whole-row activation is a real <a>
// (href given) or <button> (onActivate given), never a <div> with a click handler -- Enter/Space
// keyboard activation is therefore entirely native browser behaviour and this file adds no
// onKeyDown of its own. The trailing slot (T-5-45's mitigation -- RowMenu, Plan 05-25's own other
// component, is its typical occupant) renders as a DOM sibling of the activation element, never a
// descendant, so a trailing click can never also activate the row.
export function ListRow({
  primaryText,
  secondary,
  trailing,
  href,
  onActivate,
  'data-testid': testId,
}: ListRowProps) {
  const content = (
    <>
      <span className={PRIMARY_TEXT_CLASSES}>{primaryText}</span>
      {secondary === undefined ? null : <span className={SECONDARY_CLASSES}>{secondary}</span>}
    </>
  );

  return (
    <div
      data-testid={testId}
      data-row="true"
      className={ROW_CLASSES}
    >
      {href === undefined ? (
        <button type="button" onClick={onActivate} className={ACTIVATION_CLASSES}>
          {content}
        </button>
      ) : (
        <a href={href} className={ACTIVATION_CLASSES}>
          {content}
        </a>
      )}
      {trailing === undefined ? null : <span className={TRAILING_CLASSES}>{trailing}</span>}
    </div>
  );
}
