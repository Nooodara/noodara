import { describe, expect, it } from 'vitest';
import { Skeleton, SkeletonRow, SkeletonText } from './Skeleton.js';
import { renderUi, screen } from './testing/render.js';

describe('Skeleton', () => {
  it('renders a block with the explicit width and height it was given', () => {
    renderUi(<Skeleton width={120} height={16} data-testid="my-skeleton" />);

    const el = screen.getByTestId('my-skeleton');
    expect(el).toHaveStyle({ width: '120px', height: '16px' });
  });

  it('renders no role="progressbar" and no role="status" -- the spinner ban is asserted, not assumed', () => {
    renderUi(<Skeleton width={120} height={16} data-testid="my-skeleton" />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('never carries an animate-spin class', () => {
    renderUi(<Skeleton width={120} height={16} data-testid="my-skeleton" />);

    expect(screen.getByTestId('my-skeleton').className).not.toMatch(/animate-spin/);
  });

  // UI-09 (08-15-PLAN.md Task 2): the skeleton-to-content crossfade's blur bridge -- a
  // motion-safe-gated opacity+filter transition at --duration-panel, plus the data-entering
  // attribute that keys the @starting-style entrance rule in globals.css. Never a
  // backdrop-filter -- that budget belongs to Toolbar/Sheet, not this component.
  it('carries the motion-safe blur-bridge transition and the data-entering attribute, never a backdrop-filter', () => {
    renderUi(<Skeleton width={120} height={16} data-testid="my-skeleton" />);

    const el = screen.getByTestId('my-skeleton');
    expect(el).toHaveAttribute('data-entering', 'true');
    expect(el.className).toMatch(/motion-safe:transition-\[opacity,filter\]/);
    expect(el.className).toMatch(/duration-\[var\(--duration-panel\)\]/);
    expect(el.className).not.toMatch(/backdrop/);
  });
});

describe('SkeletonRow', () => {
  it('carries data-row="true" and its height from the --row-height token, not a hardcoded data-height (D-14)', () => {
    const { container } = renderUi(<SkeletonRow />);

    const row = container.querySelector('[data-testid="skeleton-row"]');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('data-row', 'true');
    expect(row).not.toHaveAttribute('data-height');
    expect(row?.className).toMatch(/h-\[var\(--row-height\)\]/);
  });

  it('renders no role="progressbar" and no role="status"', () => {
    renderUi(<SkeletonRow />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('never carries an animate-spin class anywhere inside it', () => {
    const { container } = renderUi(<SkeletonRow />);

    expect(container.innerHTML).not.toMatch(/animate-spin/);
  });

  // UI-09 (08-15-PLAN.md Task 2): same blur-bridge/entrance contract as the block Skeleton above.
  it('carries the data-entering attribute for the blur-bridge entrance', () => {
    const { container } = renderUi(<SkeletonRow />);

    const row = container.querySelector('[data-testid="skeleton-row"]');
    expect(row).toHaveAttribute('data-entering', 'true');
  });

  it('renders exactly five row elements when five SkeletonRows are rendered, matching a 5-row list load', () => {
    const { container } = renderUi(
      <>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </>,
    );

    expect(container.querySelectorAll('[data-testid="skeleton-row"]')).toHaveLength(5);
  });
});

describe('SkeletonText', () => {
  it('renders a single skeleton line', () => {
    const { container } = renderUi(<SkeletonText data-testid="my-skeleton-text" />);

    expect(container.querySelector('[data-testid="my-skeleton-text"]')).not.toBeNull();
  });

  it('never carries an animate-spin class', () => {
    const { container } = renderUi(<SkeletonText data-testid="my-skeleton-text" />);

    expect(container.innerHTML).not.toMatch(/animate-spin/);
  });

  // UI-09 (08-15-PLAN.md Task 2): same blur-bridge/entrance contract as the block Skeleton above.
  it('carries the data-entering attribute for the blur-bridge entrance', () => {
    const { container } = renderUi(<SkeletonText data-testid="my-skeleton-text" />);

    expect(container.querySelector('[data-testid="my-skeleton-text"]')).toHaveAttribute('data-entering', 'true');
  });
});
