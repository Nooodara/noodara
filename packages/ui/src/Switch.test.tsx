import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch.js';
import { renderUi, screen, userEvent } from './testing/render.js';

describe('Switch', () => {
  it('exposes role switch with its checked state and name', () => {
    renderUi(<Switch checked label="HTTPS redirect" onCheckedChange={() => undefined} />);
    const control = screen.getByRole('switch', { name: 'HTTPS redirect' });
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toHaveAttribute('data-state', 'on');
  });

  it('calls onCheckedChange with the next value on click', async () => {
    const onChange = vi.fn();
    renderUi(<Switch checked={false} label="HTTPS redirect" onCheckedChange={onChange} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does nothing when disabled', async () => {
    const onChange = vi.fn();
    renderUi(<Switch checked label="HTTPS redirect" disabled onCheckedChange={onChange} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
