import { describe, expect, it, vi } from 'vitest';
import { PLACEHOLDER } from './format.js';
import { LabelValue } from './LabelValue.js';
import { renderUi, screen, userEvent, within } from './testing/render.js';

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

describe('LabelValue', () => {
  it('renders its label and value', () => {
    renderUi(<LabelValue label="Host" value="203.0.113.4:22" />);

    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.4:22')).toBeInTheDocument();
  });

  // D-14: vertical padding comes from the single --row-height-padding-y token, not a hardcoded py-2.
  it('takes its vertical padding from var(--row-height-padding-y), never a hardcoded py-2', () => {
    const { container } = renderUi(<LabelValue label="Host" value="203.0.113.4:22" data-testid="row" />);

    const root = container.querySelector('[data-testid="row"]');
    expect(root?.className).toMatch(/py-\[var\(--row-height-padding-y\)\]/);
    expect(root?.className).not.toMatch(/\bpy-2\b/);
  });

  it('renders the value in mono when mono is supplied', () => {
    renderUi(<LabelValue label="Host" value="203.0.113.4:22" mono />);

    expect(screen.getByText('203.0.113.4:22').className).toMatch(/font-mono/);
  });

  it('renders exactly one copy button when copyable, whose click passes the value to the clipboard stub', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { container } = renderUi(<LabelValue label="Fingerprint" value="a1:b2:c3:d4" copyable />);

    expect(within(container).getAllByRole('button')).toHaveLength(1);

    await user.click(within(container).getByRole('button'));

    expect(writeText).toHaveBeenCalledWith('a1:b2:c3:d4');
  });

  it('renders no copy button when copyable is absent', () => {
    const { container } = renderUi(<LabelValue label="Fingerprint" value="a1:b2:c3:d4" />);

    expect(within(container).queryAllByRole('button')).toHaveLength(0);
  });

  it('carries data-dimmed="true" when dimmed, and data-dimmed="false" without it', () => {
    const { container: dimmedContainer } = renderUi(<LabelValue label="Host" value="203.0.113.4" dimmed />);
    expect(dimmedContainer.querySelector('[data-dimmed]')).toHaveAttribute('data-dimmed', 'true');

    const { container: plainContainer } = renderUi(<LabelValue label="Host" value="203.0.113.4" />);
    expect(plainContainer.querySelector('[data-dimmed]')).toHaveAttribute('data-dimmed', 'false');
  });

  it('renders the shared placeholder for a null value', () => {
    renderUi(<LabelValue label="Host" value={null} />);

    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('always carries data-mono on the value, true when mono is set and false otherwise', () => {
    renderUi(<LabelValue label="Host" value="203.0.113.4" mono />);
    expect(screen.getByText('203.0.113.4')).toHaveAttribute('data-mono', 'true');

    renderUi(<LabelValue label="OS" value="Ubuntu 24.04" />);
    expect(screen.getByText('Ubuntu 24.04')).toHaveAttribute('data-mono', 'false');
  });


  // 14-13 (A2): a 300-character repository URL truncates in the middle inside the row instead of
  // being clipped by the card edge; the full value stays available (title, screen-reader text, copy).
  it('truncates a long value in the middle when truncate="middle", keeping the copy button reachable', () => {
    const url = `https://git.example.test/${'service-catalog-component-'.repeat(11)}x.git`;
    renderUi(<LabelValue label="Repository" value={url} mono copyable truncate="middle" data-testid="row" />);

    const row = screen.getByTestId('row');
    const value = row.querySelector('[data-mono]');
    expect(value).toHaveAttribute('title', url);
    expect(value?.querySelector('[data-part="tail"]')?.textContent).toBe(url.slice(-16));
    expect(screen.getByText(url).className).toMatch(/\bsr-only\b/);
    // The value column can shrink (min-w-0); the label never does.
    expect(value?.parentElement?.className).toMatch(/\bmin-w-0\b/);
    expect(row.querySelector('span')?.className).toMatch(/\bshrink-0\b/);
    expect(screen.getByRole('button', { name: 'Copy Repository' })).toBeInTheDocument();
  });

  it('lets any value column shrink, so a long unbroken value never pushes the row past its card', () => {
    renderUi(<LabelValue label="Host" value={'h'.repeat(300)} data-testid="row" />);

    const value = screen.getByText('h'.repeat(300));
    expect(value.parentElement?.className).toMatch(/\bmin-w-0\b/);
    expect(value.className).toContain('[overflow-wrap:anywhere]');
  });
});
