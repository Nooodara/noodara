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

// The skeleton-to-content blur bridge (UI-09, 08-15-PLAN.md Task 2, docs/ui-build-prompt.md
// §7.6): a crossfade between two distinct DOM nodes (this skeleton, the content that replaces
// it) reads as one continuous transformation, not two objects swapping, when both sides move
// through the same blur+opacity bridge over the same duration. `data-entering="true"` keys the
// `@starting-style` entrance rule declared once in apps/web/src/app/globals.css -- native to the
// element, no `mounted`-state `useEffect` anywhere in this file. The transition itself is a
// plain CSS `filter: blur()` bridge, motion-safe-gated, never the translucent-material pattern
// Toolbar/Sheet use for their own separately-budgeted surfaces, so a caller keeps swapping
// skeleton/content exactly as it always has; no call site needs to change for the bridge to
// apply.
const ENTERING_ATTRS = { 'data-entering': 'true' } as const;
const BRIDGE_CLASSES =
  'motion-safe:transition-[opacity,filter] motion-safe:duration-[var(--duration-panel)] motion-safe:ease-[var(--ease-out)]';

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
      {...ENTERING_ATTRS}
      style={{ width: toDimension(width), height: toDimension(height) }}
      className={cn('rounded-sm bg-surface-2 motion-safe:animate-pulse', BRIDGE_CLASSES)}
    />
  );
}

export interface SkeletonRowProps {
  readonly 'data-testid'?: string;
}

const ROW_BLOCK_CLASSES = 'h-4 rounded-sm bg-surface-2 motion-safe:animate-pulse';

// SkeletonRow -- matches `ListRow`'s own row height, both driven by the single --row-height token
// (D-14: 44px comfortable / 36px compact). `data-row="true"` is the test hook (not only the
// className) so a test can assert the contract from an attribute rather than a computed style
// jsdom never lays out. Defaults its own `data-testid` to `skeleton-row` so a caller rendering
// several of these (Plan 05-13's 5-row list-loading state) can count them without threading a
// unique id through every instance.
export function SkeletonRow({ 'data-testid': testId = 'skeleton-row' }: SkeletonRowProps = {}) {
  return (
    <div
      data-testid={testId}
      data-row="true"
      aria-hidden="true"
      {...ENTERING_ATTRS}
      className={cn('flex h-[var(--row-height)] items-center gap-4 border-b border-hairline px-4', BRIDGE_CLASSES)}
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
      {...ENTERING_ATTRS}
      style={{ width: toDimension(width), height: '1em' }}
      className={cn('rounded-sm bg-surface-2 motion-safe:animate-pulse', BRIDGE_CLASSES)}
    />
  );
}
