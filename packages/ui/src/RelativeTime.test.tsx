import { describe, expect, it } from 'vitest';
import { formatIso, formatRelativeTime } from './format.js';
import { RelativeTime } from './RelativeTime.js';
import { renderUi, screen, userEvent } from './testing/render.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ISO = '2026-09-19T11:55:00.000Z';

describe('RelativeTime', () => {
  it('renders exactly formatRelativeTime(iso, now) as its visible text', () => {
    renderUi(<RelativeTime value={ISO} now={NOW} />);

    expect(screen.getByText(formatRelativeTime(ISO, NOW))).toBeInTheDocument();
  });

  it('carries the full ISO string in a dateTime attribute on a <time> element', () => {
    const { container } = renderUi(<RelativeTime value={ISO} now={NOW} />);

    const timeEl = container.querySelector('time');
    expect(timeEl).not.toBeNull();
    expect(timeEl).toHaveAttribute('dateTime', ISO);
  });

  it('renders the shared placeholder and no dateTime attribute for a null value, never "Invalid Date"', () => {
    const { container } = renderUi(<RelativeTime value={null} now={NOW} />);

    expect(screen.getByText(formatRelativeTime(null, NOW))).toBeInTheDocument();
    expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument();
    expect(container.querySelector('time')).toBeNull();
  });

  it('wraps the relative text in a Tooltip whose content is the full ISO string', async () => {
    const user = userEvent.setup();
    renderUi(<RelativeTime value={ISO} now={NOW} />);

    await user.hover(screen.getByText(formatRelativeTime(ISO, NOW)));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(formatIso(ISO));
  });

  it('requires now as a prop -- omitting it is a compile-time error, never a platform clock read', () => {
    // @ts-expect-error -- `now` is required; RelativeTime must never read the platform clock itself
    const element = <RelativeTime value={null} />;

    expect(element).toBeDefined();
  });
});
