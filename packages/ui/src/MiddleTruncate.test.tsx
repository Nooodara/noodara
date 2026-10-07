import { describe, expect, it } from 'vitest';
import { MiddleTruncate } from './MiddleTruncate.js';
import { renderUi, screen } from './testing/render.js';

const LONG_URL = `https://git.example.test/platform-engineering/${'service-catalog-component-'.repeat(10)}x.git`;

describe('MiddleTruncate', () => {
  it('shows the start and the end of a long value, the middle elided by an ellipsis on the head', () => {
    renderUi(<MiddleTruncate value={LONG_URL} data-testid="mt" />);

    const root = screen.getByTestId('mt');
    const head = root.querySelector('[data-part="head"]');
    const tail = root.querySelector('[data-part="tail"]');
    expect(head?.textContent).toBe(LONG_URL.slice(0, LONG_URL.length - 16));
    expect(tail?.textContent).toBe(LONG_URL.slice(-16));
    // Layout contract: the head shrinks with an ellipsis, the tail never shrinks, and the root can
    // shrink below its content (min-w-0), so the value is never clipped by the card edge.
    expect(head?.className).toMatch(/\btruncate\b/);
    expect(head?.className).toMatch(/\bmin-w-0\b/);
    expect(tail?.className).toMatch(/\bshrink-0\b/);
    expect(root.className).toMatch(/\bmin-w-0\b/);
    expect(root.className).toMatch(/\bflex\b/);
  });

  it('keeps the full value on demand: a title for pointer users and the whole text for screen readers', () => {
    renderUi(<MiddleTruncate value={LONG_URL} data-testid="mt" />);

    const root = screen.getByTestId('mt');
    expect(root).toHaveAttribute('title', LONG_URL);
    const full = screen.getByText(LONG_URL);
    expect(full.className).toMatch(/\bsr-only\b/);
    for (const part of root.querySelectorAll('[data-part="head"], [data-part="tail"]')) {
      expect(part).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('renders a short value as one end-truncating span', () => {
    renderUi(<MiddleTruncate value="main" data-testid="mt" />);

    const root = screen.getByTestId('mt');
    expect(root.querySelector('[data-part="tail"]')).toBeNull();
    expect(root).toHaveTextContent('main');
    expect(root.className).toMatch(/\btruncate\b/);
  });

  it('renders markup in the value as inert text, never as HTML', () => {
    const hostile = `https://x.test/<img src=x onerror="alert(1)"><script>alert(2)</script>${'a'.repeat(60)}`;
    const { container } = renderUi(<MiddleTruncate value={hostile} data-testid="mt" />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(hostile)).toBeInTheDocument();
  });
});
