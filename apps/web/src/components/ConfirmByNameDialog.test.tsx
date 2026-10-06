import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import {
  CONFIRM_FAILED_COPY,
  CONFIRM_MISMATCH_COPY,
  ConfirmByNameDialog,
  deleteOutcome,
  type ConfirmOutcome,
} from './ConfirmByNameDialog';

vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function Harness({ onConfirm, name = 'Billing API' }: { onConfirm: (typed: string) => Promise<ConfirmOutcome>; name?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Delete thing
      </button>
      <ConfirmByNameDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${name}?`}
        body="This cannot be undone."
        confirmLabel="Delete thing"
        requiredName={name}
        onConfirm={onConfirm}
        data-testid="confirm-dialog"
      />
    </>
  );
}

async function openDialog(onConfirm: (typed: string) => Promise<ConfirmOutcome>, name?: string) {
  const user = userEvent.setup();
  renderUi(<Harness onConfirm={onConfirm} {...(name === undefined ? {} : { name })} />);
  await user.click(screen.getByRole('button', { name: 'Delete thing' }));
  const dialog = await screen.findByTestId('confirm-dialog');
  const input = screen.getByRole('textbox');
  const confirm = () => screen.getAllByRole('button', { name: 'Delete thing' }).find((button) => dialog.contains(button));
  return { user, dialog, input, confirm };
}

describe('ConfirmByNameDialog (13-10 A2, A4, H1)', () => {
  it('keeps confirm disabled until the exact name is typed, case and whitespace sensitive', async () => {
    const { user, input, confirm } = await openDialog(vi.fn());
    expect(confirm()).toBeDisabled();
    await user.type(input, 'billing api');
    expect(confirm()).toBeDisabled();
    await user.clear(input);
    await user.type(input, ' Billing API');
    expect(confirm()).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Billing API ');
    expect(confirm()).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Billing API');
    expect(confirm()).toBeEnabled();
  });

  it('submits once even when confirm is clicked twice, then closes on success', async () => {
    let resolve: (outcome: ConfirmOutcome) => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<ConfirmOutcome>((r) => {
          resolve = r;
        }),
    );
    const { user, input, confirm } = await openDialog(onConfirm);
    await user.type(input, 'Billing API');
    const button = confirm();
    if (button === undefined) throw new Error('confirm button missing');
    await user.click(button);
    await user.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('Billing API');
    resolve({ ok: true });
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  it('shows the failure message in place and keeps the dialog open', async () => {
    const onConfirm = vi.fn(() => Promise.resolve<ConfirmOutcome>({ ok: false, message: 'Remove its services first.' }));
    const { user, input, confirm } = await openDialog(onConfirm);
    await user.type(input, 'Billing API');
    const button = confirm();
    if (button === undefined) throw new Error('confirm button missing');
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Remove its services first.');
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
  });

  it('is dismissed by Escape and returns focus to the trigger', async () => {
    const { user } = await openDialog(vi.fn());
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete thing' })).toHaveFocus();
    });
  });

  it('never puts the typed value in the URL', async () => {
    const before = window.location.href;
    const onConfirm = vi.fn(() => Promise.resolve<ConfirmOutcome>({ ok: true }));
    const { user, input, confirm } = await openDialog(onConfirm);
    await user.type(input, 'Billing API');
    const button = confirm();
    if (button === undefined) throw new Error('confirm button missing');
    await user.click(button);
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toContain('Billing');
  });

  it('is generic: the copy and the required name come from the caller', async () => {
    const { dialog } = await openDialog(vi.fn(), 'web-frontend');
    expect(dialog).toHaveTextContent('Delete web-frontend?');
    expect(dialog).toHaveTextContent('This cannot be undone.');
  });

  it('treats a thrown confirm as a fixed failure message', async () => {
    const onConfirm = vi.fn(() => Promise.reject(new Error('boom: raw')));
    const { user, input, confirm } = await openDialog(onConfirm);
    await user.type(input, 'Billing API');
    const button = confirm();
    if (button === undefined) throw new Error('confirm button missing');
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(CONFIRM_FAILED_COPY);
  });
});

describe('deleteOutcome (13-10 H1)', () => {
  const failure = (code: string, message = 'raw server text') =>
    ({ ok: false, code, message, unauthorized: false }) as Parameters<typeof deleteOutcome>[0];

  it('treats success and NOT_FOUND (already deleted) as done', () => {
    expect(deleteOutcome({ ok: true, data: {} })).toEqual({ ok: true });
    expect(deleteOutcome(failure('NOT_FOUND'))).toEqual({ ok: true });
  });

  it('maps the mismatch to fixed copy, never the server text', () => {
    expect(deleteOutcome(failure('DELETE_CONFIRMATION_MISMATCH'))).toEqual({ ok: false, message: CONFIRM_MISMATCH_COPY });
  });

  it('uses caller recovery copy, and fixed copy for anything else', () => {
    expect(deleteOutcome(failure('ENVIRONMENT_NOT_EMPTY'), { ENVIRONMENT_NOT_EMPTY: 'Remove its services first.' })).toEqual({
      ok: false,
      message: 'Remove its services first.',
    });
    const other = deleteOutcome(failure('INTERNAL_ERROR'));
    expect(other).toEqual({ ok: false, message: CONFIRM_FAILED_COPY });
  });
});
