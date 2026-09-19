import { describe, expect, it, vi } from 'vitest';
import { ListRow } from './ListRow.js';
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

  it('emits a data-height of 44, matching SkeletonRow', () => {
    renderUi(<ListRow onActivate={vi.fn()} primaryText="Row" data-testid="row" />);

    expect(screen.getByTestId('row')).toHaveAttribute('data-height', '44');
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
});
