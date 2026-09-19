import { describe, expect, it, vi } from 'vitest';
import { Button, type ButtonVariant } from './Button.js';
import { renderUi, userEvent } from './testing/render.js';

const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];

describe('Button', () => {
  it.each(VARIANTS)('renders the %s variant with a matching data-variant attribute', (variant) => {
    const { getByRole } = renderUi(<Button variant={variant}>Go</Button>);

    expect(getByRole('button', { name: 'Go' })).toHaveAttribute('data-variant', variant);
  });

  it('defaults to the primary variant when none is passed', () => {
    const { getByRole } = renderUi(<Button>Go</Button>);

    expect(getByRole('button', { name: 'Go' })).toHaveAttribute('data-variant', 'primary');
  });

  it('keeps the accessible name unchanged, sets aria-busy and disabled while loading', () => {
    const { getByRole, rerender } = renderUi(<Button>Save</Button>);
    const idleText = getByRole('button', { name: 'Save' }).textContent;

    rerender(<Button loading>Save</Button>);
    const button = getByRole('button', { name: 'Save' });

    expect(button.textContent).toBe(idleText);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
  });

  it('does not invoke onClick while loading', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { getByRole } = renderUi(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    await user.click(getByRole('button', { name: 'Save' }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('blocks onClick and does not set aria-busy when only disabled is passed', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { getByRole } = renderUi(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const button = getByRole('button', { name: 'Save' });

    await user.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button).not.toHaveAttribute('aria-busy');
  });

  it('marks a non-filled destructive button as data-filled="false"', () => {
    const { getByRole } = renderUi(<Button variant="destructive">Delete</Button>);

    expect(getByRole('button', { name: 'Delete' })).toHaveAttribute('data-filled', 'false');
  });

  it('marks a filled destructive button as data-filled="true"', () => {
    const { getByRole } = renderUi(
      <Button variant="destructive" filled>
        Delete
      </Button>,
    );

    expect(getByRole('button', { name: 'Delete' })).toHaveAttribute('data-filled', 'true');
  });

  it('invokes onClick exactly once per click when enabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { getByRole } = renderUi(<Button onClick={onClick}>Go</Button>);

    await user.click(getByRole('button', { name: 'Go' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('never renders a spinner while loading', () => {
    const { container, queryByRole } = renderUi(<Button loading>Save</Button>);

    expect(container.querySelector('[class*="animate-spin"]')).toBeNull();
    expect(queryByRole('progressbar')).toBeNull();
  });
});
