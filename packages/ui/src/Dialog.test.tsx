import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, DestructiveConfirmDialog } from './Dialog.js';
import { renderUi, screen, userEvent } from './testing/render.js';

describe('ConfirmDialog', () => {
  it('renders its title as the accessible name and its body as the description, with the confirm label and a ghost Cancel', () => {
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Re-run discovery?"
        body="This re-checks the server and may take a minute."
        confirmLabel="Re-run discovery"
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Re-run discovery?' });
    expect(screen.getByText('This re-checks the server and may take a minute.')).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription('This re-checks the server and may take a minute.');
    expect(screen.getByRole('button', { name: 'Re-run discovery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-variant', 'ghost');
  });

  it('invokes onConfirm exactly once when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Re-run discovery' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('invokes onOpenChange(false) and never onConfirm when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('DestructiveConfirmDialog', () => {
  function renderDialog(props: Partial<Parameters<typeof DestructiveConfirmDialog>[0]> = {}) {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const result = renderUi(
      <DestructiveConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete srv-1?"
        body="This permanently deletes the server."
        confirmLabel="Delete server"
        requiredName="srv-1"
        onConfirm={onConfirm}
        {...props}
      />,
    );
    return { onConfirm, onOpenChange, container: result.container };
  }

  it('renders the confirm button disabled on open, before anything is typed', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Delete server' })).toBeDisabled();
  });

  it('enables confirm on the exact required name, then disables it again after deleting one character', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('textbox');
    const confirmButton = screen.getByRole('button', { name: 'Delete server' });

    expect(confirmButton).toBeDisabled();

    await user.type(input, 'srv-1');
    expect(confirmButton).toBeEnabled();

    await user.type(input, '{backspace}');
    expect(confirmButton).toBeDisabled();
  });

  it('leaves confirm disabled for a case-variant or whitespace-padded name', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('textbox');
    const confirmButton = screen.getByRole('button', { name: 'Delete server' });

    await user.type(input, 'SRV-1');
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'srv-1 ');
    expect(confirmButton).toBeDisabled();
  });

  it('marks the confirm button destructive+filled and Cancel ghost, never destructive', () => {
    renderDialog();

    const confirmButton = screen.getByRole('button', { name: 'Delete server' });
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });

    expect(confirmButton).toHaveAttribute('data-variant', 'destructive');
    expect(confirmButton).toHaveAttribute('data-filled', 'true');
    expect(cancelButton).toHaveAttribute('data-variant', 'ghost');
  });

  it('calls onConfirm with the typed value exactly once when confirm is clicked after a match', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const input = screen.getByRole('textbox');

    await user.type(input, 'srv-1');
    await user.click(screen.getByRole('button', { name: 'Delete server' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('srv-1');
  });

  it('renders a supplied error string inside a role="alert" element in the input error position', () => {
    renderDialog({ error: 'That doesn\'t match. Type "srv-1" exactly to continue.' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('That doesn\'t match. Type "srv-1" exactly to continue.');
  });

  it('never echoes the typed confirmation value into any attribute other than the input value', async () => {
    const user = userEvent.setup();
    const { container } = renderDialog({ requiredName: 'zK9qLdistinctive' });
    const input = screen.getByRole('textbox');

    await user.type(input, 'zK9qLdistinctive');
    expect(input).toHaveValue('zK9qLdistinctive');

    const otherAttributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((attr) => !(el === input && attr.name === 'value'))
        .map((attr) => attr.value),
    );
    expect(otherAttributeValues.some((value) => value.includes('zK9qLdistinctive'))).toBe(false);
  });
});
