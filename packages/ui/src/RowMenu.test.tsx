import { describe, expect, it, vi } from 'vitest';
import { RowMenu } from './RowMenu.js';
import { renderUi, screen, userEvent } from './testing/render.js';

function buildItems(onEdit: () => void, onDelete: () => void) {
  return [
    { label: 'Edit', onSelect: onEdit },
    { label: 'Delete', onSelect: onDelete, destructive: true },
  ] as const;
}

describe('RowMenu', () => {
  it('renders a trigger with a real accessible name, not a bare "..." glyph with no label', () => {
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    expect(screen.getByRole('button', { name: 'Actions for Alpha' })).toBeInTheDocument();
  });

  it('passes data-testid through to the trigger', () => {
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" data-testid="row-menu-trigger" />);

    expect(screen.getByTestId('row-menu-trigger')).toBeInTheDocument();
  });

  it('gives the trigger a >=44px hit area, assertable via data-hit-area', () => {
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" data-testid="row-menu-trigger" />);

    expect(screen.getByTestId('row-menu-trigger')).toHaveAttribute('data-hit-area', '44');
  });

  it('does not put any menu item in the accessibility tree before the trigger is activated', () => {
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('reveals the items once the trigger is activated', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));

    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('invokes exactly the selected item handler, never a sibling handler', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    renderUi(<RowMenu items={buildItems(onEdit, onDelete)} triggerLabel="Actions for Alpha" />);

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);
    const trigger = screen.getByRole('button', { name: 'Actions for Alpha' });

    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes when a pointer interaction happens outside the menu', async () => {
    const user = userEvent.setup();
    renderUi(
      <div>
        <RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />
        <button type="button">Outside</button>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('moves focus between items with ArrowDown/ArrowUp, the roving-focus WAI-ARIA menu pattern', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });
});
