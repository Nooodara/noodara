import { describe, expect, it, vi } from 'vitest';
import { Textarea } from './Textarea.js';
import { renderUi, screen, userEvent } from './testing/render.js';

describe('Textarea', () => {
  it('renders a multiline control reachable by getByRole("textbox") that updates while typing, firing onChange per keystroke', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    renderUi(<Textarea aria-label="Private key" onChange={handleChange} />);

    const textarea = screen.getByRole('textbox', { name: 'Private key' });
    await user.type(textarea, 'ab');

    expect(textarea).toHaveValue('ab');
    expect(handleChange).toHaveBeenCalledTimes(2);
  });

  it('accepts a rows prop', () => {
    renderUi(<Textarea aria-label="Private key" rows={6} />);

    expect(screen.getByRole('textbox', { name: 'Private key' })).toHaveAttribute('rows', '6');
  });

  it('forwards autoComplete="off" verbatim', () => {
    renderUi(<Textarea aria-label="Private key" autoComplete="off" />);

    expect(screen.getByRole('textbox', { name: 'Private key' })).toHaveAttribute('autocomplete', 'off');
  });

  it('carries data-mono="true" when mono is set', () => {
    renderUi(<Textarea aria-label="Private key" mono />);

    expect(screen.getByRole('textbox', { name: 'Private key' })).toHaveAttribute('data-mono', 'true');
  });

  it('carries data-mono="false" when mono is not set', () => {
    renderUi(<Textarea aria-label="Private key" />);

    expect(screen.getByRole('textbox', { name: 'Private key' })).toHaveAttribute('data-mono', 'false');
  });

  it('carries aria-invalid="true" when invalid is set', () => {
    renderUi(<Textarea aria-label="Private key" invalid />);

    expect(screen.getByRole('textbox', { name: 'Private key' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('carries no aria-invalid attribute when invalid is not set', () => {
    renderUi(<Textarea aria-label="Private key" />);

    expect(screen.getByRole('textbox', { name: 'Private key' })).not.toHaveAttribute('aria-invalid');
  });

  it('does not accept typed input while disabled, leaving its value unchanged', async () => {
    const user = userEvent.setup();
    renderUi(<Textarea aria-label="Private key" disabled />);
    const textarea = screen.getByRole('textbox', { name: 'Private key' });

    await user.type(textarea, 'abc');

    expect(textarea).toHaveValue('');
  });

  it('never echoes a typed value into any attribute other than its own value', async () => {
    const user = userEvent.setup();
    const secret = '-----BEGIN OPENSSH PRIVATE KEY-----zK9qLdistinctive';
    const { container } = renderUi(<Textarea aria-label="Private key" />);
    const textarea = screen.getByRole('textbox', { name: 'Private key' });

    await user.type(textarea, secret);

    expect(textarea).toHaveValue(secret);

    const otherAttributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((attr) => !(el === textarea && attr.name === 'value'))
        .map((attr) => attr.value),
    );
    expect(otherAttributeValues.some((value) => value.includes(secret))).toBe(false);
  });
});
