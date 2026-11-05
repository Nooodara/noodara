import { describe, expect, it } from 'vitest';
import { fireEvent, renderUi, screen } from '@noodara/ui/testing';
import type { MetricSeries } from '@noodara/domain/api-contract';
import { MetricChart } from './MetricChart';

function series(values: readonly (number | null)[]): MetricSeries {
  return {
    scope: 'server',
    entityId: '11111111-1111-4111-8111-111111111111',
    metric: 'cpu_percent',
    from: '2026-11-05T10:00:00.000Z',
    to: '2026-11-05T11:00:00.000Z',
    intervalSeconds: 60,
    points: values.map((v, index) => ({ t: new Date(Date.UTC(2026, 10, 5, 10, index)).toISOString(), v })),
  };
}

describe('MetricChart', () => {
  it('draws one accent line per run of samples, with no legend for a single series', () => {
    const { container } = renderUi(<MetricChart data-testid="c" title="CPU" unit="percent" series={series([1, 2, null, 3])} />);
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(2);
    paths.forEach((path) => {
      expect(path.getAttribute('class')).toContain('stroke-accent');
      expect(path.getAttribute('stroke-width')).toBe('2');
    });
    expect(screen.getByTestId('c-latest')).toHaveTextContent('3%');
  });

  it('keeps a table of the samples for screen readers', () => {
    renderUi(<MetricChart title="CPU" unit="percent" series={series([5, null, 7])} />);
    const table = screen.getByRole('table', { name: 'CPU' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('says when the range has no samples', () => {
    renderUi(<MetricChart data-testid="c" title="CPU" unit="percent" series={null} />);
    expect(screen.getByTestId('c-empty')).toHaveTextContent('No samples in this range.');
    expect(screen.getByTestId('c-latest')).toHaveTextContent('—');
  });

  it('shows a crosshair and tooltip on hover and hides them on leave', () => {
    renderUi(<MetricChart data-testid="c" title="CPU" unit="percent" series={series([10, 20, 30])} />);
    const svg = screen.getByRole('img');
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(svg, { clientX: 100, clientY: 10 });
    expect(screen.getByTestId('c-crosshair')).toBeInTheDocument();
    expect(screen.getByTestId('c-tooltip')).toHaveTextContent('20%');
    fireEvent.pointerLeave(svg);
    expect(screen.queryByTestId('c-tooltip')).toBeNull();
  });

  it('adds a worded warn pill when a threshold is crossed', () => {
    renderUi(<MetricChart data-testid="c" title="Memory" unit="percent" series={series([95])} alert="High memory" />);
    expect(screen.getByTestId('c-alert')).toHaveTextContent('High memory');
    expect(screen.getByTestId('c')).toHaveAttribute('data-alert', 'true');
  });
});
