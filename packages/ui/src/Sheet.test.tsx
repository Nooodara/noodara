import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet.js';
import { renderUi, screen, userEvent } from './testing/render.js';

// Real focus trapping, Esc-to-close and outside-click dismissal are Radix Dialog's own built-in
// behaviour (05-UI-SPEC.md SS8, "Radix traps focus and closes on Esc -- do not override it") and
// are verified end to end by Plan 05-17's `@sheet` Playwright spec, not here -- jsdom does not
// implement the layout/focus mechanics Radix's FocusScope depends on, so a jsdom-only test
// asserting them would be dishonest about what it actually proves.

describe('Sheet', () => {
  it('renders nothing from its content when closed -- absent, not merely hidden', () => {
    renderUi(
      <Sheet open={false} onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Sheet body content')).not.toBeInTheDocument();
  });

  it('renders its content inside a dialog whose accessible name is the title prop when open', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.getByRole('dialog', { name: 'Add server' })).toBeInTheDocument();
  });

  it('renders the body children and the footer the caller composes', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server" footer={<button type="button">Save</button>}>
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.getByText('Sheet body content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('invokes onOpenChange(false) exactly once when the close affordance is clicked, never managing open itself', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderUi(
      <Sheet open onOpenChange={onOpenChange} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('forwards data-testid to the content element', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server" data-testid="add-server-sheet">
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.getByTestId('add-server-sheet')).toBe(screen.getByRole('dialog'));
  });
});
