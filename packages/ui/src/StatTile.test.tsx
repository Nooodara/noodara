import { describe, expect, it } from 'vitest';
import { PLACEHOLDER } from './format.js';
import { StatTile } from './StatTile.js';
import { renderUi, screen } from './testing/render.js';

describe('StatTile', () => {
  it('renders its label and value, with the value carrying data-mono and tabular-nums', () => {
    renderUi(<StatTile label="CPU cores" value="4" />);

    expect(screen.getByText('CPU cores')).toBeInTheDocument();
    const valueEl = screen.getByText('4');
    expect(valueEl).toHaveAttribute('data-mono', 'true');
    expect(valueEl.className).toMatch(/tabular-nums/);
  });

  it('renders the shared placeholder for a null value, never a 0', () => {
    renderUi(<StatTile label="CPU cores" value={null} />);

    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('renders a caption when supplied, and no caption element when absent', () => {
    const { rerender } = renderUi(<StatTile label="RAM" value="8 GB" caption="as of 2 minutes ago" />);

    expect(screen.getByText('as of 2 minutes ago')).toBeInTheDocument();

    rerender(<StatTile label="RAM" value="8 GB" />);

    expect(screen.queryByText('as of 2 minutes ago')).not.toBeInTheDocument();
  });

  it('renders a meter element carrying the fraction in data-fraction when meterFraction is supplied', () => {
    const { container } = renderUi(<StatTile label="Disk" value="18 GB of 40 GB" meterFraction={0.45} />);

    const meter = container.querySelector('[data-fraction]');
    expect(meter).not.toBeNull();
    expect(meter).toHaveAttribute('data-fraction', '0.45');
  });

  it('renders no meter element when meterFraction is null', () => {
    const { container } = renderUi(<StatTile label="Disk" value={PLACEHOLDER} meterFraction={null} />);

    expect(container.querySelector('[data-fraction]')).toBeNull();
  });

  it('renders no meter element when meterFraction is omitted', () => {
    const { container } = renderUi(<StatTile label="Uptime" value="1 day, 2 hours" />);

    expect(container.querySelector('[data-fraction]')).toBeNull();
  });
});
