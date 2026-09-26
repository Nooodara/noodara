import { describe, expect, it, vi } from 'vitest';
import { PRESS_CLASSES } from './press.js';
import { RowMenu } from './RowMenu.js';
import { renderUi, screen, userEvent } from './testing/render.js';
import { useFloatingMenu } from './use-floating-menu.js';

// Mocks only the returned `closeSource` reading -- every other field (open state, roving focus,
// close-on-select) still comes from the real hook underneath, never reimplemented here. See
// Dialog.test.tsx's identical mock for why this is the one thing jsdom can genuinely,
// synchronously observe about the keyboard-no-animation branch, and why the real proof is
// tests/e2e/keyboard-motion.spec.ts (Task 3).
vi.mock('./use-floating-menu.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-floating-menu.js')>();
  return { ...actual, useFloatingMenu: vi.fn(actual.useFloatingMenu) };
});

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

  it('closes and returns focus to the trigger after selecting an item (UI-04, the select path -- not the Esc path above, which already passed)', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    renderUi(<RowMenu items={buildItems(onEdit, vi.fn())} triggerLabel="Actions for Alpha" />);
    const trigger = screen.getByRole('button', { name: 'Actions for Alpha' });

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('aria-expanded reflects open state', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);
    const trigger = screen.getByRole('button', { name: 'Actions for Alpha' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders two items with an identical label and each still fires only its own handler, keyed by id rather than label', async () => {
    const user = userEvent.setup();
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    renderUi(
      <RowMenu
        items={[
          { id: 'restart-1', label: 'Restart', onSelect: onFirst },
          { id: 'restart-2', label: 'Restart', onSelect: onSecond },
        ]}
        triggerLabel="Actions for Alpha"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));
    const restartItems = screen.getAllByRole('menuitem', { name: 'Restart' });
    expect(restartItems).toHaveLength(2);

    const secondRestartItem = restartItems[1];
    if (secondRestartItem === undefined) {
      throw new Error('expected a second "Restart" menuitem');
    }
    await user.click(secondRestartItem);

    expect(onSecond).toHaveBeenCalledTimes(1);
    expect(onFirst).not.toHaveBeenCalled();
  });

  // 08-06-PLAN.md Task 1 (UI-03, 08-UI-SPEC.md SS5.1/5.2): the content carries the one
  // allowlisted shadow and keeps bg-surface-3 exactly as-is -- already the lightest surface tier
  // in both themes, so it needs no new elevated-surface token.
  it('carries the floating shadow on the content element and keeps bg-surface-3 unchanged', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));

    const content = screen.getByRole('menu');
    expect(content.className).toContain('shadow-[var(--shadow-floating)]');
    expect(content.className).toContain('bg-surface-3');
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): RowMenu swaps to border-hairline-strong
  // under prefers-contrast: more, and declares no reduced-transparency override since it is
  // already solid.
  it('swaps to border-hairline-strong under prefers-contrast: more', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));

    const content = screen.getByRole('menu');
    expect(content.className).toContain('contrast-more:border-hairline-strong');
    expect(content.className).not.toContain('prefers-reduced-transparency');
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): every hover: utility on the trigger and on
  // each item must sit inside a (hover: hover) and (pointer: fine) variant, so a tap on touch
  // never leaves a stuck hover state. focus-visible: styles stay ungated (not pointer-dependent).
  it('gates every hover: utility on the trigger and items behind (hover: hover) and (pointer: fine)', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" data-testid="trigger" />);

    function assertNoUngatedHover(className: string): void {
      for (const token of className.split(/\s+/)) {
        if (token.includes('hover:') && !token.startsWith('[@media(hover:hover)_and_(pointer:fine)]:')) {
          throw new Error(`ungated hover utility found: ${token}`);
        }
      }
    }

    assertNoUngatedHover(screen.getByTestId('trigger').className);

    await user.click(screen.getByTestId('trigger'));
    for (const item of screen.getAllByRole('menuitem')) {
      assertNoUngatedHover(item.className);
    }
  });

  // 08-20-PLAN.md Task 1 (UI-05): every menu item, destructive or not, gets its press feedback
  // from the one shared PRESS_CLASSES definition -- never a second, local press-scale literal.
  it('gets its press feedback from the one shared PRESS_CLASSES definition (UI-05)', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));

    for (const item of screen.getAllByRole('menuitem')) {
      for (const token of PRESS_CLASSES.split(/\s+/).filter(Boolean)) {
        expect(item.className).toContain(token);
      }
    }
  });

  // 08-20-PLAN.md Task 2 (UI-05/§9 #10, pitfall P14): once the shared closeSource (read through
  // useFloatingMenu, never a second useCloseSource call of its own) is wired in, an Escape-close
  // must still dismiss the menu and return focus to the trigger correctly -- jsdom cannot verify
  // a *rendered* transition's absence (no compiled stylesheet is loaded in this test environment
  // for Radix's own Presence component to detect, so it always unmounts synchronously here
  // regardless of which class is applied -- the exact same honest limitation Sheet.test.tsx's own
  // "adds a zero-duration override..." test already documents for the identical mechanism). The
  // real, only-honest proof that no animation actually plays is
  // tests/e2e/keyboard-motion.spec.ts's real-browser measurement (Task 3).
  it('still dismisses via Escape, with focus returning to the trigger, once closeSource is wired in', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);
    const trigger = screen.getByRole('button', { name: 'Actions for Alpha' });

    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('applies the zero-duration override to the content while the recorded close source reads keyboard', async () => {
    const user = userEvent.setup();
    const mockedHook = vi.mocked(useFloatingMenu);
    const defaultImpl = mockedHook.getMockImplementation();
    mockedHook.mockImplementation(() => {
      const real = defaultImpl!();
      return { ...real, closeSource: () => 'keyboard' as const };
    });

    try {
      renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);
      await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));

      expect(screen.getByRole('menu').className).toContain('!duration-0');
    } finally {
      mockedHook.mockImplementation(defaultImpl!);
    }
  });

  it('does not apply the override to the content while the recorded close source is the default, programmatic reading', async () => {
    const user = userEvent.setup();
    renderUi(<RowMenu items={buildItems(vi.fn(), vi.fn())} triggerLabel="Actions for Alpha" />);

    await user.click(screen.getByRole('button', { name: 'Actions for Alpha' }));

    expect(screen.getByRole('menu').className).not.toContain('!duration-0');
  });
});
