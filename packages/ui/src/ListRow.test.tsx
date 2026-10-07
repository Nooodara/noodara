import { describe, expect, it, vi } from 'vitest';
import { ListRow } from './ListRow.js';
import { PRESS_CLASSES } from './press.js';
import { renderUi, screen, userEvent } from './testing/render.js';

describe('ListRow', () => {
  it('renders a single real <a> element (not a div) when href is given, named after the primary text', () => {
    renderUi(<ListRow href="/servers/1" primaryText="Alpha" />);

    const link = screen.getByRole('link', { name: /alpha/i });
    expect(link.tagName).toBe('A');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders a single real <button> element when onActivate is given, named after the primary text', () => {
    renderUi(<ListRow onActivate={vi.fn()} primaryText="Beta" />);

    const button = screen.getByRole('button', { name: /beta/i });
    expect(button.tagName).toBe('BUTTON');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('never activates the row through a div click handler', () => {
    const { container } = renderUi(<ListRow onActivate={vi.fn()} primaryText="Gamma" />);

    expect(container.querySelector('div[onclick]')).toBeNull();
  });

  it('invokes onActivate exactly once when Enter is pressed on the focused button row', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderUi(<ListRow onActivate={onActivate} primaryText="Delta" />);

    await user.tab();
    expect(screen.getByRole('button', { name: /delta/i })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('invokes onActivate exactly once when Space is pressed on the focused button row', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderUi(<ListRow onActivate={onActivate} primaryText="Epsilon" />);

    await user.tab();
    await user.keyboard(' ');

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('does not prevent the anchor default action when Enter is pressed on the focused href row', async () => {
    const user = userEvent.setup();
    renderUi(<ListRow href="/servers/1" primaryText="Zeta" />);
    const link = screen.getByRole('link', { name: /zeta/i });

    let observedDefaultPrevented: boolean | null = null;
    link.addEventListener('click', (event) => {
      observedDefaultPrevented = event.defaultPrevented;
    });

    await user.tab();
    await user.keyboard('{Enter}');

    expect(observedDefaultPrevented).toBe(false);
  });

  it('carries data-row="true" and its height from the --row-height token, not a hardcoded data-height (D-14)', () => {
    renderUi(<ListRow onActivate={vi.fn()} primaryText="Row" data-testid="row" />);

    const row = screen.getByTestId('row');
    expect(row).toHaveAttribute('data-row', 'true');
    expect(row).not.toHaveAttribute('data-height');
    expect(row.className).toMatch(/h-\[var\(--row-height\)\]/);
    expect(row).not.toHaveAttribute('style');
  });

  it('renders an optional secondary slot inside the activation element', () => {
    renderUi(<ListRow onActivate={vi.fn()} primaryText="Row name" secondary="host:22" />);

    expect(screen.getByRole('button', { name: /row name.*host:22/i })).toBeInTheDocument();
  });

  it('renders the trailing slot outside the activation element, so clicking it does not activate the row', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const trailingClick = vi.fn();
    renderUi(
      <ListRow
        onActivate={onActivate}
        primaryText="Trailing test"
        trailing={
          <button type="button" onClick={trailingClick}>
            Menu
          </button>
        }
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Menu' }));

    expect(trailingClick).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): the row's hover:bg-surface-2 must sit
  // inside a (hover: hover) and (pointer: fine) variant, so a tap on touch never leaves a stuck
  // hover state.
  it('gates its hover:bg-surface-2 behind (hover: hover) and (pointer: fine)', () => {
    renderUi(<ListRow onActivate={vi.fn()} primaryText="Row" data-testid="row" />);

    const row = screen.getByTestId('row');
    for (const token of row.className.split(/\s+/)) {
      if (token.includes('hover:') && !token.startsWith('[@media(hover:hover)_and_(pointer:fine)]:')) {
        throw new Error(`ungated hover utility found: ${token}`);
      }
    }
  });

  it('gets its press feedback from the one shared PRESS_CLASSES definition (UI-05)', () => {
    renderUi(<ListRow onActivate={vi.fn()} primaryText="Row" />);
    const button = screen.getByRole('button', { name: 'Row' });

    for (const token of PRESS_CLASSES.split(/\s+/).filter(Boolean)) {
      expect(button.className).toContain(token);
    }
  });


  // 14-13 (A3): at 375 px the secondary text (a description) gives up its width before the
  // primary text (a name) starts to truncate.
  it('shrinks the secondary text before the primary text', () => {
    renderUi(<ListRow href="/projects/1" primaryText="Payments" secondary="Card processing, settlement" />);

    const primary = screen.getByText('Payments');
    const secondary = screen.getByText('Card processing, settlement');
    // A weighted shrink still takes a sub-pixel from the name (enough for an ellipsis): the name
    // never shrinks, it is capped at the row width, and the description absorbs every missing pixel.
    expect(primary.className).toMatch(/\bshrink-0\b/);
    expect(primary.className).toMatch(/\bmax-w-full\b/);
    expect(secondary.className).toMatch(/\bmin-w-0\b/);
    expect(secondary.className).not.toMatch(/\bshrink-0\b/);
    expect(primary.className).toMatch(/\btruncate\b/);
    expect(secondary.className).toMatch(/\btruncate\b/);
  });
});
