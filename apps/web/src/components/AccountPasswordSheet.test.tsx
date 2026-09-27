// 09-11-PLAN.md Task 2: the Change password Sheet (09-CONTEXT.md D-02/D-05/D-06, 09-UI-SPEC.md
// §1.2). No refreshSessionUser call here (D-06's Notice lives on the Settings page, rendered by
// the caller via onSaved -- the password change does not update name/email).
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import { AccountPasswordSheet } from './AccountPasswordSheet';
import type { ApiResult } from '../lib/api-client';

const apiSendMock = vi.fn<(...args: unknown[]) => Promise<ApiResult<unknown>>>();

vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  apiSend: (...args: unknown[]) => apiSendMock(...args),
}));

vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function Harness({ open = true, onSaved = vi.fn() }: { readonly open?: boolean; readonly onSaved?: (n: number) => void }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" data-testid="trigger">
        Change
      </button>
      <AccountPasswordSheet open={open} onOpenChange={() => undefined} onSaved={onSaved} returnFocusRef={triggerRef} />
    </div>
  );
}

beforeEach(() => {
  apiSendMock.mockReset();
});

describe('AccountPasswordSheet', () => {
  it('renders with the three fields, testids and copy', () => {
    renderUi(<Harness />);

    expect(screen.getByTestId('account-password-sheet')).toBeInTheDocument();
    expect(screen.getByText('Change password')).toBeInTheDocument();
    const current = screen.getByTestId('account-current-password-input');
    const next = screen.getByTestId('account-new-password-input');
    const confirm = screen.getByTestId('account-confirm-password-input');
    expect(current).toHaveAttribute('type', 'password');
    expect(current).toHaveAttribute('autocomplete', 'current-password');
    expect(next).toHaveAttribute('type', 'password');
    expect(next).toHaveAttribute('autocomplete', 'new-password');
    expect(confirm).toHaveAttribute('type', 'password');
    expect(confirm).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByTestId('account-password-save')).toHaveTextContent('Save password');
    expect(current).toHaveValue('');
    expect(next).toHaveValue('');
    expect(confirm).toHaveValue('');
  });

  it('keeps Save disabled until all three fields are filled and matching, then submits', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({ ok: true, data: { sessionsRevoked: 2 } });
    const onSaved = vi.fn();
    renderUi(<Harness onSaved={onSaved} />);

    const save = screen.getByTestId('account-password-save');
    expect(save).toBeDisabled();

    await user.type(screen.getByTestId('account-current-password-input'), 'current-pw');
    await user.type(screen.getByTestId('account-new-password-input'), 'brand-new-pw-12');
    expect(save).toBeDisabled();

    await user.type(screen.getByTestId('account-confirm-password-input'), 'brand-new-pw-12');
    expect(save).not.toBeDisabled();

    await user.click(save);

    expect(apiSendMock).toHaveBeenCalledWith('POST', '/api/account/password', {
      currentPassword: 'current-pw',
      newPassword: 'brand-new-pw-12',
    });
    await screen.findByTestId('account-password-sheet');
    expect(onSaved).toHaveBeenCalledWith(2);
  });

  it('shows "Passwords don\'t match." under Confirm and blocks submit on a mismatch', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);

    await user.type(screen.getByTestId('account-current-password-input'), 'current-pw');
    await user.type(screen.getByTestId('account-new-password-input'), 'brand-new-pw-12');
    await user.type(screen.getByTestId('account-confirm-password-input'), 'different');

    expect(await screen.findByText("Passwords don't match.")).toBeVisible();
    expect(screen.getByTestId('account-password-save')).toBeDisabled();
    expect(apiSendMock).not.toHaveBeenCalled();
  });

  it('shows the new-password policy copy under New password', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'weak',
      issues: [{ path: '/newPassword', message: 'too weak' }],
      unauthorized: false,
    });
    renderUi(<Harness />);

    await user.type(screen.getByTestId('account-current-password-input'), 'current-pw');
    await user.type(screen.getByTestId('account-new-password-input'), 'brand-new-pw-12');
    await user.type(screen.getByTestId('account-confirm-password-input'), 'brand-new-pw-12');
    await user.click(screen.getByTestId('account-password-save'));

    expect(
      await screen.findByText('Password must be 12–128 characters and not be a commonly used password.'),
    ).toBeVisible();
  });

  it('shows the current-password error on INVALID_CREDENTIAL', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'nope',
      issues: [{ path: '/currentPassword', message: 'wrong' }],
      unauthorized: false,
    });
    renderUi(<Harness />);

    await user.type(screen.getByTestId('account-current-password-input'), 'wrong-pw');
    await user.type(screen.getByTestId('account-new-password-input'), 'brand-new-pw-12');
    await user.type(screen.getByTestId('account-confirm-password-input'), 'brand-new-pw-12');
    await user.click(screen.getByTestId('account-password-save'));

    expect(await screen.findByText('Current password is incorrect.')).toBeVisible();
  });

  it('clears every password field on close and returns focus to the trigger', () => {
    const triggerRef = { current: document.createElement('button') };
    document.body.appendChild(triggerRef.current);

    const { rerender } = renderUi(
      <AccountPasswordSheet open onOpenChange={() => undefined} onSaved={vi.fn()} returnFocusRef={triggerRef} />,
    );

    rerender(
      <AccountPasswordSheet
        open={false}
        onOpenChange={() => undefined}
        onSaved={vi.fn()}
        returnFocusRef={triggerRef}
      />,
    );

    expect(triggerRef.current).toHaveFocus();

    rerender(
      <AccountPasswordSheet open onOpenChange={() => undefined} onSaved={vi.fn()} returnFocusRef={triggerRef} />,
    );

    expect(screen.getByTestId('account-current-password-input')).toHaveValue('');
    expect(screen.getByTestId('account-new-password-input')).toHaveValue('');
    expect(screen.getByTestId('account-confirm-password-input')).toHaveValue('');
  });

  it('disables all three inputs and shows loading while submitting', async () => {
    const user = userEvent.setup();
    let resolvePromise: (value: ApiResult<unknown>) => void = () => undefined;
    apiSendMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );
    renderUi(<Harness />);

    await user.type(screen.getByTestId('account-current-password-input'), 'current-pw');
    await user.type(screen.getByTestId('account-new-password-input'), 'brand-new-pw-12');
    await user.type(screen.getByTestId('account-confirm-password-input'), 'brand-new-pw-12');
    await user.click(screen.getByTestId('account-password-save'));

    expect(screen.getByTestId('account-current-password-input')).toBeDisabled();
    expect(screen.getByTestId('account-new-password-input')).toBeDisabled();
    expect(screen.getByTestId('account-confirm-password-input')).toBeDisabled();
    expect(screen.getByTestId('account-password-save')).toHaveAttribute('aria-busy', 'true');

    resolvePromise({ ok: true, data: { sessionsRevoked: 0 } });
  });
});
