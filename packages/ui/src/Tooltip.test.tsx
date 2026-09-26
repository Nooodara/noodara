import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip.js';
import { renderUi, screen, userEvent, waitFor } from './testing/render.js';

describe('Tooltip', () => {
  it('renders its trigger child', () => {
    renderUi(
      <Tooltip content="Full detail">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Trigger' })).toBeInTheDocument();
  });

  it('associates its content with the trigger through the primitive\'s own ARIA wiring once opened via hover', async () => {
    const user = userEvent.setup();
    renderUi(
      <Tooltip content="Full detail">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Trigger' });
    expect(trigger).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.hover(trigger);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Full detail');
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
  });

  it('closes on Escape, proving the primitive\'s own dismiss behaviour is untouched', async () => {
    const user = userEvent.setup();
    renderUi(
      <Tooltip content="Full detail">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    await user.hover(screen.getByRole('button', { name: 'Trigger' }));
    await screen.findByRole('tooltip');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  it('supports a controlled open prop, so a caller can force its content visible', () => {
    renderUi(
      <Tooltip content="Copied" open>
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    expect(screen.getByRole('tooltip')).toHaveTextContent('Copied');
  });

  // 08-14-PLAN.md Task 1 (UI-07, 08-UI-SPEC.md §7.2/§7.4): the content grows from the trigger,
  // reading Radix's own Popper-provided transform-origin variable rather than a hardcoded corner
  // -- RowMenu/AccountMenu do not have this variable available (no Popper underneath), Tooltip
  // does.
  it('anchors its transform-origin to the trigger via the Popper-provided variable, at 125ms --ease-out', () => {
    renderUi(
      <Tooltip content="Full detail" open>
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    const content = screen.getByRole('tooltip').className;
    expect(content).toContain('origin-[var(--radix-tooltip-content-transform-origin)]');
    expect(content).toContain('motion-safe:duration-[125ms]');
    expect(content).toContain('motion-safe:ease-[var(--ease-out)]');
    expect(content).not.toContain('scale-[0]');
  });
});
