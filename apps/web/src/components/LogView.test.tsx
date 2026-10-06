import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@noodara/ui';
import { fireEvent, renderUi, screen } from '@noodara/ui/testing';
import { LogView, tailLines, type LogViewLine } from './LogView';

function lines(count: number): LogViewLine[] {
  return Array.from({ length: count }, (_, index) => ({
    key: String(index),
    text: `line ${String(index)}`,
  }));
}

/** jsdom has no layout: give the scroller the geometry a real browser would. */
function geometry(
  element: HTMLElement,
  sizes: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: sizes.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: sizes.clientHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value: sizes.scrollTop,
  });
}

describe('tailLines', () => {
  it('returns no lines for empty text', () => {
    expect(tailLines('', 10)).toEqual({ lines: [], hidden: false });
  });

  it('splits text into lines keyed by their offset and ignores one trailing newline', () => {
    expect(tailLines('a\nbb\nc\n', 10)).toEqual({
      lines: [
        { key: '0', text: 'a' },
        { key: '2', text: 'bb' },
        { key: '5', text: 'c' },
      ],
      hidden: false,
    });
  });

  it('keeps only the last `max` lines and says that earlier ones are hidden', () => {
    const text = Array.from({ length: 100_000 }, (_, index) => `l${String(index)}`).join('\n');
    const tail = tailLines(text, 500);
    expect(tail.hidden).toBe(true);
    expect(tail.lines).toHaveLength(500);
    expect(tail.lines[0]?.text).toBe('l99500');
    expect(tail.lines.at(-1)?.text).toBe('l99999');
  });

  it('keeps a partial last line', () => {
    expect(tailLines('a\nb', 1)).toEqual({
      lines: [{ key: '2', text: 'b' }],
      hidden: true,
    });
  });
});

describe('LogView', () => {
  it('renders lines as monospace text only, never as markup', () => {
    renderUi(
      <LogView label="Build log" lines={[{ key: '0', text: '<img src=x onerror=alert(1)>' }]} />,
    );
    const log = screen.getByRole('log', { name: 'Build log' });
    expect(log.className).toContain('font-mono');
    expect(log.querySelector('img')).toBeNull();
    expect(log.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows the hidden-lines notice when earlier lines were dropped', () => {
    renderUi(
      <LogView label="Build log" lines={lines(3)} hiddenNotice="Showing the last 3 lines." />,
    );
    expect(screen.getByTestId('log-hidden-notice').textContent).toBe('Showing the last 3 lines.');
  });

  it('shows the empty text when there are no lines', () => {
    renderUi(<LogView label="Build log" lines={[]} emptyText="No output yet." />);
    expect(screen.getByText('No output yet.')).toBeTruthy();
  });

  it('renders a timestamp and marks stderr lines', () => {
    renderUi(
      <LogView
        label="Runtime logs"
        lines={[
          {
            key: '0',
            text: 'boom',
            timestamp: '2026-10-06T12:00:00.000Z',
            stream: 'stderr',
          },
        ]}
      />,
    );
    const row = screen.getByText('boom').closest('[data-stream]');
    expect(row?.getAttribute('data-stream')).toBe('stderr');
    expect(screen.getByText('2026-10-06T12:00:00.000Z')).toBeTruthy();
  });

  it('follows the bottom while the user is there and offers Jump to bottom after scrolling up', () => {
    // renderUi wraps in TooltipProvider; rerender must keep the same tree or React remounts it.
    const view = (count: number) => (
      <TooltipProvider delayDuration={0}>
        <LogView label="Build log" lines={lines(count)} />
      </TooltipProvider>
    );
    const { rerender } = renderUi(<LogView label="Build log" lines={lines(5)} />);
    const scroller = screen.getByTestId('log-scroller');
    geometry(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });

    rerender(view(6));
    // At the bottom (the initial state): new output scrolls into view.
    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'Jump to bottom' })).toBeNull();

    // The user scrolls up: auto-scroll stops and the jump button appears.
    geometry(scroller, {
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 300,
    });
    fireEvent.scroll(scroller);
    geometry(scroller, {
      scrollHeight: 1200,
      clientHeight: 200,
      scrollTop: 300,
    });
    rerender(view(7));
    expect(scroller.scrollTop).toBe(300);
    const jump = screen.getByRole('button', { name: 'Jump to bottom' });

    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(1200);
    expect(screen.queryByRole('button', { name: 'Jump to bottom' })).toBeNull();
  });
});
