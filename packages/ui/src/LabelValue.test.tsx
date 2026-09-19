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

  it('renders the value in mono when mono is supplied', () => {
    renderUi(<LabelValue label="Host" value="203.0.113.4:22" mono />);

    expect(screen.getByText('203.0.113.4:22').className).toMatch(/font-mono/);
  });

  it('renders exactly one copy button when copyable, whose click passes the value to the clipboard stub', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { container } = renderUi(<LabelValue label="Fingerprint" value="a1:b2:c3:d4" copyable />);

    const buttons = within(container).getAllByRole('button');
    expect(buttons).toHaveLength(1);

    await user.click(buttons[0]!);

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
});
