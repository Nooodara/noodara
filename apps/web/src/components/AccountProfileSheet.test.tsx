// 09-11-PLAN.md Task 2: the Name/Email account edit Sheet (09-CONTEXT.md D-01/D-02/D-04,
// 09-UI-SPEC.md §1.2). Follows ServerSheet.test.tsx's own harness shape (mocked apiSend, mocked
// require-session) plus a mocked refreshSessionUser (09-10's session store) this Sheet must call
// on a successful save.
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import { AccountProfileSheet } from './AccountProfileSheet';
import type { ApiResult } from '../lib/api-client';

const apiSendMock = vi.fn<(...args: unknown[]) => Promise<ApiResult<unknown>>>();
const refreshSessionUserMock = vi.fn<() => Promise<void>>();

vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  apiSend: (...args: unknown[]) => apiSendMock(...args),
}));

vi.mock('../lib/session-user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session-user')>()),
  refreshSessionUser: () => refreshSessionUserMock(),
}));

vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function Harness({ field, open = true }: { readonly field: 'name' | 'email'; readonly open?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" data-testid="trigger">
        Edit
      </button>
      <AccountProfileSheet
        field={field}
        initialValue={field === 'name' ? 'Ada Lovelace' : 'ada@example.test'}
        open={open}
        onOpenChange={() => undefined}
        returnFocusRef={triggerRef}
      />
    </div>
  );
}

beforeEach(() => {
  apiSendMock.mockReset();
  refreshSessionUserMock.mockReset();
});

describe('AccountProfileSheet — name', () => {
  it('renders the name sheet with the field pre-filled and the current password field', () => {
    renderUi(<Harness field="name" />);

    expect(screen.getByTestId('account-name-sheet')).toBeInTheDocument();
    expect(screen.getByText('Edit name')).toBeInTheDocument();
    expect(screen.getByTestId('account-name-input')).toHaveValue('Ada Lovelace');
    expect(screen.getByTestId('account-current-password-input')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('account-current-password-input')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByTestId('account-name-input')).toHaveAttribute('autocomplete', 'name');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByTestId('account-name-save')).toHaveTextContent('Save name');
  });

  it('keeps Save disabled until both fields are filled, then submits and refreshes the session', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({ ok: true, data: {} });
    const onOpenChange = vi.fn();

    function Wrapped() {
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <AccountProfileSheet
          field="name"
          initialValue="Ada Lovelace"
          open
          onOpenChange={onOpenChange}
          returnFocusRef={triggerRef}
        />
      );
    }
    renderUi(<Wrapped />);

    const save = screen.getByTestId('account-name-save');
    expect(save).toBeDisabled();

    await user.clear(screen.getByTestId('account-name-input'));
    await user.type(screen.getByTestId('account-name-input'), 'Grace Hopper');
    expect(save).toBeDisabled();

    await user.type(screen.getByTestId('account-current-password-input'), 'current-pw');
    expect(save).not.toBeDisabled();

    await user.click(save);

    expect(apiSendMock).toHaveBeenCalledWith('PATCH', '/api/account/profile', {
      name: 'Grace Hopper',
      currentPassword: 'current-pw',
    });
    expect(await refreshSessionUserMockCalled()).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  async function refreshSessionUserMockCalled(): Promise<boolean> {
    await Promise.resolve();
    return refreshSessionUserMock.mock.calls.length > 0;
  }

  it('shows the current-password field error on INVALID_CREDENTIAL', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'nope',
      issues: [{ path: '/currentPassword', message: 'wrong' }],
      unauthorized: false,
    });
    renderUi(<Harness field="name" />);

    await user.type(screen.getByTestId('account-current-password-input'), 'wrong-pw');
    await user.click(screen.getByTestId('account-name-save'));

    expect(await screen.findByText('Current password is incorrect.')).toBeVisible();
  });

  it('shows a Banner with the generic message for an unrouted failure', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({ ok: false, code: 'INTERNAL_ERROR', message: 'raw internal detail', unauthorized: false });
    renderUi(<Harness field="name" />);

    await user.type(screen.getByTestId('account-current-password-input'), 'pw');
    await user.click(screen.getByTestId('account-name-save'));

    expect(await screen.findByText('Something went wrong. Try again.')).toBeVisible();
    expect(screen.queryByText('raw internal detail')).not.toBeInTheDocument();
  });

  it('shows the retry-after Banner on a 429', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'REAUTH_LOCKED',
      message: 'locked',
      retryAfterSeconds: 90,
      unauthorized: false,
    });
    renderUi(<Harness field="name" />);

    await user.type(screen.getByTestId('account-current-password-input'), 'pw');
    await user.click(screen.getByTestId('account-name-save'));

    expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeVisible();
  });

  it('disables both inputs and shows loading while submitting', async () => {
    const user = userEvent.setup();
    let resolvePromise: (value: ApiResult<unknown>) => void = () => undefined;
    apiSendMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );
    renderUi(<Harness field="name" />);

    await user.type(screen.getByTestId('account-current-password-input'), 'pw');
    await user.click(screen.getByTestId('account-name-save'));

    expect(screen.getByTestId('account-name-input')).toBeDisabled();
    expect(screen.getByTestId('account-current-password-input')).toBeDisabled();
    expect(screen.getByTestId('account-name-save')).toHaveAttribute('aria-busy', 'true');

    resolvePromise({ ok: true, data: {} });
  });
});

describe('AccountProfileSheet — email', () => {
  it('renders the email sheet with its own testids and copy', () => {
    renderUi(<Harness field="email" />);

    expect(screen.getByTestId('account-email-sheet')).toBeInTheDocument();
    expect(screen.getByText('Edit email')).toBeInTheDocument();
    expect(screen.getByTestId('account-email-input')).toHaveValue('ada@example.test');
    expect(screen.getByTestId('account-email-input')).toHaveAttribute('type', 'email');
    expect(screen.getByTestId('account-email-input')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByTestId('account-email-save')).toHaveTextContent('Save email');
  });

  it('shows the domain-unresolvable error under Email', async () => {
    const user = userEvent.setup();
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'EMAIL_DOMAIN_UNRESOLVABLE',
      message: 'domain bad',
      unauthorized: false,
    });
    renderUi(<Harness field="email" />);

    await user.type(screen.getByTestId('account-current-password-input'), 'pw');
    await user.click(screen.getByTestId('account-email-save'));

    expect(
      await screen.findByText("We couldn't find a mail server for this domain. Check the address and try again."),
    ).toBeVisible();
  });
});

describe('AccountProfileSheet — focus and secrets', () => {
  it('clears the current-password field on close and returns focus to the trigger', () => {
    const triggerRef = { current: document.createElement('button') };
    document.body.appendChild(triggerRef.current);

    const { rerender } = renderUi(
      <AccountProfileSheet
        field="name"
        initialValue="Ada Lovelace"
        open
        onOpenChange={() => undefined}
        returnFocusRef={triggerRef}
      />,
    );

    rerender(
      <AccountProfileSheet
        field="name"
        initialValue="Ada Lovelace"
        open={false}
        onOpenChange={() => undefined}
        returnFocusRef={triggerRef}
      />,
    );

    expect(triggerRef.current).toHaveFocus();
  });

  it('never renders console output or the raw failure message', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    apiSendMock.mockResolvedValue({ ok: false, code: 'INTERNAL_ERROR', message: 'do-not-render-me', unauthorized: false });
    renderUi(<Harness field="name" />);

    await user.type(screen.getByTestId('account-current-password-input'), 'pw');
    await user.click(screen.getByTestId('account-name-save'));

    await screen.findByText('Something went wrong. Try again.');
    expect(screen.queryByText('do-not-render-me')).not.toBeInTheDocument();
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('do-not-render-me'));
    consoleSpy.mockRestore();
  });
});

describe('AccountProfileSheet — reopen resets fields', () => {
  it('reopening after a close shows the initial value again, not a stale edit', () => {
    const { rerender } = renderUi(
      <Harness field="name" open />,
    );

    rerender(<Harness field="name" open={false} />);
    rerender(<Harness field="name" open />);

    expect(screen.getByTestId('account-name-input')).toHaveValue('Ada Lovelace');
    expect(screen.getByTestId('account-current-password-input')).toHaveValue('');
  });
});
