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
});

describe('SkeletonRow', () => {
  it('renders at 44px height, readable from a data-height attribute rather than a computed style', () => {
    const { container } = renderUi(<SkeletonRow />);

    const row = container.querySelector('[data-testid="skeleton-row"]');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('data-height', '44');
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
});
