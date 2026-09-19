import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl.js';
import { renderUi, screen, userEvent } from './testing/render.js';

// Arrow-key navigation between segments is verified by Playwright in a real browser, in
// Plan 05-17's @sheet spec -- jsdom does not implement the focus/keyboard behaviour Radix's
// roving tabindex relies on (ADR-0005). This suite asserts only that the primitive's roles,
// checked state and click-driven onValueChange contract are present.

const OPTIONS = [
  { value: 'privateKey', label: 'Private key' },
  { value: 'password', label: 'Password' },
] as const;

describe('SegmentedControl', () => {
  it('renders exactly two radio roles inside one radiogroup role', () => {
    renderUi(<SegmentedControl value="privateKey" onValueChange={() => {}} options={OPTIONS} />);

    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('marks the option matching value as checked and the other as unchecked', () => {
    renderUi(<SegmentedControl value="privateKey" onValueChange={() => {}} options={OPTIONS} />);

    expect(screen.getByRole('radio', { name: 'Private key' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Password' })).toHaveAttribute('aria-checked', 'false');
  });

  it('renders each option label as visible text', () => {
    renderUi(<SegmentedControl value="privateKey" onValueChange={() => {}} options={OPTIONS} />);

    expect(screen.getByText('Private key')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
  });

  it('invokes onValueChange exactly once with the clicked option value when it differs from the current one', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    renderUi(<SegmentedControl value="privateKey" onValueChange={handleChange} options={OPTIONS} />);

    await user.click(screen.getByRole('radio', { name: 'Password' }));

    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith('password');
  });

  it('does not invoke onValueChange when clicking the already-selected option', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    renderUi(<SegmentedControl value="privateKey" onValueChange={handleChange} options={OPTIONS} />);

    await user.click(screen.getByRole('radio', { name: 'Private key' }));

    expect(handleChange).not.toHaveBeenCalled();
  });

  it('forwards data-testid to the group element', () => {
    renderUi(
      <SegmentedControl
        value="privateKey"
        onValueChange={() => {}}
        options={OPTIONS}
        data-testid="server-sheet-credential-type"
      />,
    );

    expect(screen.getByTestId('server-sheet-credential-type')).toHaveAttribute('role', 'radiogroup');
  });
});
