import { describe, expect, it } from 'vitest';
import { TonePill } from './TonePill.js';
import { renderUi } from './testing/render.js';

describe('TonePill', () => {
  it.each(['ok', 'warn', 'error', 'idle'] as const)('renders the label as text with tone %s', (tone) => {
    const { getByTestId } = renderUi(<TonePill tone={tone} label="Issued" data-testid="pill" />);
    const pill = getByTestId('pill');
    expect(pill).toHaveTextContent('Issued');
    expect(pill).toHaveAttribute('data-tone', tone);
    expect(pill.className).toContain(`bg-status-${tone}-soft`);
  });

  it('defaults the test id and hides the dot from assistive tech', () => {
    const { getByTestId } = renderUi(<TonePill tone="ok" label="Running" />);
    expect(getByTestId('tone-pill').querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('renders markup in the label as text', () => {
    const { getByTestId } = renderUi(<TonePill tone="idle" label="<b>x</b>" />);
    expect(getByTestId('tone-pill').querySelector('b')).toBeNull();
    expect(getByTestId('tone-pill')).toHaveTextContent('<b>x</b>');
  });
});
