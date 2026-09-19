import { cn } from './cn.js';

type Dimension = number | string;

function toDimension(value: Dimension): string {
  return typeof value === 'number' ? `${value.toString(10)}px` : value;
}

export interface SkeletonProps {
  readonly width: Dimension;
  readonly height: Dimension;
  readonly 'data-testid'?: string;
}

// Skeleton (skill SS5 "Carga", 05-UI-SPEC.md Component Inventory) -- a solid `--surface-2` block,
// never a shimmer sweep. The only motion allowed is Tailwind's `motion-safe:` variant, which
// compiles to `@media (prefers-reduced-motion: no-preference)` -- every animated skeleton in this
// file degrades to a fully static block the instant the user's OS-level reduced-motion preference
// is on (skill SS2.4/SS7), with no extra branching needed here. Geometry is always explicit
// width/height props, never inferred, so a caller matches real content exactly (05-UI-SPEC.md's
// "5 skeleton rows, exact 44px geometry"). No spinner, no `role="progressbar"`/`role="status"`
// anywhere in this module -- the skill's spinner ban is a component contract, not a convention.
export function Skeleton({ width, height, 'data-testid': testId }: SkeletonProps) {
  return (
    <div
      data-testid={testId}
      aria-hidden="true"
      style={{ width: toDimension(width), height: toDimension(height) }}
      className={cn('rounded-sm bg-surface-2 motion-safe:animate-pulse')}
    />
  );
}

const ROW_HEIGHT_PX = 44;

export interface SkeletonRowProps {
  readonly 'data-testid'?: string;
}

const ROW_BLOCK_CLASSES = 'h-4 rounded-sm bg-surface-2 motion-safe:animate-pulse';

// SkeletonRow -- 44px tall, matching `ListRow`'s own fixed row height (05-UI-SPEC.md's spacing
// table: "Desktop table/list rows: 44px height"). The height is exposed as a `data-height`
// attribute (not only inline style) so a test can assert the contract from an attribute rather
// than a computed style jsdom never lays out. Defaults its own `data-testid` to `skeleton-row` so
// a caller rendering several of these (Plan 05-13's 5-row list-loading state) can count them
// without threading a unique id through every instance.
export function SkeletonRow({ 'data-testid': testId = 'skeleton-row' }: SkeletonRowProps = {}) {
  return (
    <div
      data-testid={testId}
      data-height={ROW_HEIGHT_PX}
      aria-hidden="true"
      style={{ height: toDimension(ROW_HEIGHT_PX) }}
      className="flex items-center gap-4 border-b border-hairline px-4"
    >
      <div className={cn(ROW_BLOCK_CLASSES, 'w-32')} />
      <div className={cn(ROW_BLOCK_CLASSES, 'w-24')} />
      <div className={cn(ROW_BLOCK_CLASSES, 'w-16')} />
    </div>
  );
}

export interface SkeletonTextProps {
  readonly width?: Dimension;
  readonly 'data-testid'?: string;
}

// SkeletonText -- a single skeleton line (the text-row-sized sibling of the block `Skeleton`
// above), used for a single label/value row or a settings caption while its real value loads.
export function SkeletonText({ width = '100%', 'data-testid': testId }: SkeletonTextProps) {
  return (
    <div
      data-testid={testId}
      aria-hidden="true"
      style={{ width: toDimension(width), height: '1em' }}
      className="rounded-sm bg-surface-2 motion-safe:animate-pulse"
    />
  );
}
