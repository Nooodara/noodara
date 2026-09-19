import type { ReactNode } from 'react';
import { cn } from './cn.js';

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

const ROW_HEIGHT_PX = 44;

const ROW_CLASSES = cn('group flex items-center border-b border-hairline hover:bg-surface-2');

const ACTIVATION_CLASSES = cn(
  'flex min-w-0 flex-1 items-center gap-4 px-4 text-left outline-none',
  'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
);

const PRIMARY_TEXT_CLASSES = 'truncate text-headline font-semibold text-ink';
const SECONDARY_CLASSES = 'truncate text-callout text-ink-secondary';
const TRAILING_CLASSES = 'flex shrink-0 items-center pr-4';

// ListRow (skill SS4.4, 05-UI-SPEC.md Component Inventory, D-09) -- the 44px hairline row every
// list this phase needs (servers, activity) is built from. Whole-row activation is a real <a>
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
      data-height={ROW_HEIGHT_PX}
      style={{ height: `${ROW_HEIGHT_PX.toString(10)}px` }}
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
