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
});
