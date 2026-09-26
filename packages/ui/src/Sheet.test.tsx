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

  // 08-06-PLAN.md Task 1 (UI-03, 08-UI-SPEC.md SS5.1/5.2): the panel carries the one allowlisted
  // shadow and the surface-elevated alias -- light is byte-identical to before (surface-elevated
  // resolves to surface-1 in light), dark resolves one step lighter (surface-2).
  it('carries the floating shadow and bg-surface-elevated/72 on the panel element', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('shadow-[var(--shadow-floating)]');
    expect(panel.className).toContain('bg-surface-elevated/72');
    expect(panel.className).not.toContain('bg-surface-1/72');
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): prefers-reduced-transparency drops the
  // Sheet's translucency and blur entirely -- fully opaque background, no backdrop-filter.
  it('drops to a solid bg-surface-elevated and disables backdrop-filter under prefers-reduced-transparency', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('[@media(prefers-reduced-transparency:reduce)]:bg-surface-elevated');
    expect(panel.className).toContain('[@media(prefers-reduced-transparency:reduce)]:[backdrop-filter:none]');
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): prefers-contrast: more swaps the hairline
  // for the strong variant and pushes the translucent background toward fully opaque.
  it('swaps to border-hairline-strong and a fully opaque background under prefers-contrast: more', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('contrast-more:border-hairline-strong');
    expect(panel.className).toContain('contrast-more:bg-surface-elevated');
  });
});
