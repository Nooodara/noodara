import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from './testing/render.js';
import { useFloatingMenu } from './use-floating-menu.js';

// Tiny in-test menu shell driving `useFloatingMenu` through the DOM (ADR-0005's own established
// discipline, matching `RowMenu.test.tsx`'s harness shape). `onKeyDown` is wired on the wrapper
// (not only the content node) so a key pressed while the trigger itself still has focus -- the
// "from the trigger" case in the hook's own <behavior> contract -- reaches the same roving-focus
// handler a real Content element would receive once Radix's own autofocus has run.
//
// The Escape/outside-pointer-close effect below is this harness's own stand-in for what Radix's
// real non-modal Dialog does for `RowMenu` in production (08-04-PLAN.md Task 2) -- proving here
// only that `useFloatingMenu` correctly re-exposes the delegated close-source reading once
// something closes the menu, not that the primitive itself works (that is
// `use-close-source.test.tsx`'s job).
function TestMenu({ onEdit, onDelete }: { readonly onEdit: () => void; readonly onDelete: () => void }) {
  const { open, setOpen, contentRef, handleContentKeyDown, selectItem, closeSource } = useFloatingMenu();
  const [reading, setReading] = useState('none');

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    function handlePointerDown(event: PointerEvent): void {
      const content = contentRef.current;
      if (content !== null && event.target instanceof Node && !content.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open, contentRef, setOpen]);

  return (
    <div onKeyDown={handleContentKeyDown}>
      <button type="button" onClick={() => setOpen(true)}>
        Trigger
      </button>
      {open && (
        <div ref={contentRef} role="menu">
          <button type="button" role="menuitem" onClick={selectItem(onEdit)}>
            Edit
          </button>
          <button type="button" role="menuitem" onClick={selectItem(onDelete)}>
            Delete
          </button>
          <button type="button" role="menuitem" onClick={selectItem(() => undefined)}>
            Archive
          </button>
        </div>
      )}
      <button type="button" onClick={() => setReading(closeSource())}>
        Read
      </button>
      <div data-testid="reading">{reading}</div>
      <button type="button">Outside</button>
    </div>
  );
}

describe('useFloatingMenu roving focus', () => {
  it('moves focus to the first item on ArrowDown when nothing inside the menu has focus yet', async () => {
    const user = userEvent.setup();
    renderUi(<TestMenu onEdit={vi.fn()} onDelete={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });

  it('wraps from the last item back to the first on ArrowDown', async () => {
    const user = userEvent.setup();
    renderUi(<TestMenu onEdit={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    screen.getByRole('menuitem', { name: 'Archive' }).focus();

    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });

  it('wraps from the first item to the last on ArrowUp', async () => {
    const user = userEvent.setup();
    renderUi(<TestMenu onEdit={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    screen.getByRole('menuitem', { name: 'Edit' }).focus();

    await user.keyboard('{ArrowUp}');

    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
  });

  it('jumps to the first item on Home and the last item on End', async () => {
    const user = userEvent.setup();
    renderUi(<TestMenu onEdit={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    screen.getByRole('menuitem', { name: 'Delete' }).focus();

    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus();
  });
});

describe('useFloatingMenu selectItem', () => {
  it('runs the handler, closes the menu, and records the close as programmatic', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    renderUi(<TestMenu onEdit={onEdit} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Trigger' }));

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Read' }));
    expect(screen.getByTestId('reading')).toHaveTextContent('programmatic');
  });
});

describe('useFloatingMenu delegated close-source (integration only -- see use-close-source.test.tsx for the primitive itself)', () => {
  it('surfaces an Escape-driven close as "keyboard"', async () => {
    const user = userEvent.setup();
    renderUi(<TestMenu onEdit={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Trigger' }));

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Read' }));

    expect(screen.getByTestId('reading')).toHaveTextContent('keyboard');
  });

  it('surfaces a pointer-outside-driven close as "pointer"', async () => {
    const user = userEvent.setup();
    renderUi(<TestMenu onEdit={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Trigger' }));

    await user.click(screen.getByRole('button', { name: 'Outside' }));
    await user.click(screen.getByRole('button', { name: 'Read' }));

    expect(screen.getByTestId('reading')).toHaveTextContent('pointer');
  });
});
