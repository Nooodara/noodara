import { describe, expect, it, vi } from 'vitest';
import { Input } from './Input.js';
import { renderUi, screen, userEvent } from './testing/render.js';

describe('Input', () => {
  it('renders a textbox-role element that updates while typing, firing onChange per keystroke', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    renderUi(<Input aria-label="Name" onChange={handleChange} />);

    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.type(input, 'ab');

    expect(input).toHaveValue('ab');
    expect(handleChange).toHaveBeenCalledTimes(2);
  });

  it('forwards autoComplete="off" verbatim', () => {
    renderUi(<Input aria-label="Private key" autoComplete="off" />);

    expect(screen.getByRole('textbox', { name: 'Private key' })).toHaveAttribute('autocomplete', 'off');
  });

  it('forwards autoComplete="current-password" verbatim', () => {
    renderUi(<Input aria-label="Password" autoComplete="current-password" />);

    expect(screen.getByRole('textbox', { name: 'Password' })).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
  });

  it('carries data-mono="true" when mono is set', () => {
    renderUi(<Input aria-label="Host" mono />);

    expect(screen.getByRole('textbox', { name: 'Host' })).toHaveAttribute('data-mono', 'true');
  });

  it('carries data-mono="false" when mono is not set', () => {
    renderUi(<Input aria-label="Host" />);

    expect(screen.getByRole('textbox', { name: 'Host' })).toHaveAttribute('data-mono', 'false');
  });

  it('carries aria-invalid="true" when invalid is set', () => {
    renderUi(<Input aria-label="SSH port" invalid />);

    expect(screen.getByRole('textbox', { name: 'SSH port' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('carries no aria-invalid attribute when invalid is not set', () => {
    renderUi(<Input aria-label="SSH port" />);

    expect(screen.getByRole('textbox', { name: 'SSH port' })).not.toHaveAttribute('aria-invalid');
  });

  it('does not accept typed input while disabled, leaving its value unchanged', async () => {
    const user = userEvent.setup();
    renderUi(<Input aria-label="Name" disabled />);
    const input = screen.getByRole('textbox', { name: 'Name' });

    await user.type(input, 'abc');

    expect(input).toHaveValue('');
  });

  it('never echoes a typed value into any attribute other than its own value', async () => {
    const user = userEvent.setup();
    const secret = 'zK9qLdistinctive';
    const { container } = renderUi(<Input aria-label="Private key" />);
    const input = screen.getByRole('textbox', { name: 'Private key' });

    await user.type(input, secret);

    expect(input).toHaveValue(secret);

    const otherAttributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((attr) => !(el === input && attr.name === 'value'))
        .map((attr) => attr.value),
    );
    expect(otherAttributeValues.some((value) => value.includes(secret))).toBe(false);
  });
});
