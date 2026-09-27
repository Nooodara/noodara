'use client';

// The Change password Sheet (SET-03, 09-CONTEXT.md D-02/D-05/D-06, 09-UI-SPEC.md §1.2). Unlike
// AccountProfileSheet, a successful save does not touch the shared session store -- it reports
// `sessionsRevoked` to its caller (the Settings page, plan 09-12) via `onSaved`, which renders the
// D-06 Notice on the page itself, after this sheet has already closed. All three password fields
// live only in this component's own state and are cleared on every close, never logged, never
// rendered back (T-09-14).
import { useEffect, useState, type RefObject } from 'react';
import { Banner, Button, Field, Input, Sheet } from '@noodara/ui';
import { apiSend, type ApiFailure } from '../lib/api-client';
import { canSubmitPassword, confirmError, retryMessage } from '../lib/account-form';
import { ACCOUNT_GENERIC_ERROR, accountFieldErrors, type AccountFormField } from '../lib/error-copy';
import { requireSession } from '../lib/require-session';

export interface AccountPasswordSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called once the password change actually succeeds, with the number of other sessions the
   *  server revoked -- the caller (Settings) renders the D-06 Notice, not this sheet. */
  readonly onSaved: (sessionsRevoked: number) => void;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}

interface PasswordChangeResponse {
  readonly sessionsRevoked: number;
}

function isPasswordChangeResponse(value: unknown): value is PasswordChangeResponse {
  return typeof value === 'object' && value !== null && typeof (value as { sessionsRevoked?: unknown }).sessionsRevoked === 'number';
}

export function AccountPasswordSheet({ open, onOpenChange, onSaved, returnFocusRef }: AccountPasswordSheetProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<AccountFormField, string>>>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setFieldErrors({});
      setBannerMessage(null);
      setSubmitting(false);
    }
  }, [open]);

  // T-09-14: every password field is discarded the instant the sheet closes, and focus returns to
  // the row's own Change button (09-UI-SPEC.md §5.2).
  useEffect(() => {
    if (!open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      returnFocusRef.current?.focus();
    }
  }, [open, returnFocusRef]);

  const mismatch = confirmError(newPassword, confirmPassword);

  function handleFailure(failure: ApiFailure): void {
    if (failure.unauthorized) {
      void requireSession();
      return;
    }

    const mapped = accountFieldErrors(failure);
    if (Object.keys(mapped).length > 0) {
      setFieldErrors(mapped);
      return;
    }

    if (failure.retryAfterSeconds !== undefined) {
      setBannerMessage(retryMessage(failure.retryAfterSeconds));
      return;
    }

    setBannerMessage(ACCOUNT_GENERIC_ERROR);
  }

  async function handleSubmit(): Promise<void> {
    if (submitting || !canSubmitPassword({ currentPassword, newPassword, confirmPassword })) return;

    setFieldErrors({});
    setBannerMessage(null);
    setSubmitting(true);

    const result = await apiSend('POST', '/api/account/password', { currentPassword, newPassword });
    setSubmitting(false);

    if (!result.ok) {
      handleFailure(result);
      return;
    }

    const sessionsRevoked = isPasswordChangeResponse(result.data) ? result.data.sessionsRevoked : 0;
    onOpenChange(false);
    onSaved(sessionsRevoked);
  }

  const canSubmit = canSubmitPassword({ currentPassword, newPassword, confirmPassword });

  const footer = (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={submitting}
        onClick={() => {
          onOpenChange(false);
        }}
      >
        Cancel
      </Button>
      <Button
        type="button"
        variant="primary"
        data-testid="account-password-save"
        loading={submitting}
        disabled={!canSubmit}
        onClick={() => void handleSubmit()}
      >
        Save password
      </Button>
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Change password" data-testid="account-password-sheet" footer={footer}>
      {bannerMessage !== null ? <Banner message={bannerMessage} /> : null}
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Field
          label="Current password"
          {...(fieldErrors.currentPassword === undefined ? {} : { error: fieldErrors.currentPassword })}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              data-testid="account-current-password-input"
              type="password"
              autoFocus
              autoComplete="current-password"
              disabled={submitting}
              invalid={fieldErrors.currentPassword !== undefined}
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="New password"
          {...(fieldErrors.newPassword === undefined ? {} : { error: fieldErrors.newPassword })}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              data-testid="account-new-password-input"
              type="password"
              autoComplete="new-password"
              disabled={submitting}
              invalid={fieldErrors.newPassword !== undefined}
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Confirm new password" {...(mismatch === undefined ? {} : { error: mismatch })}>
          {(controlProps) => (
            <Input
              {...controlProps}
              data-testid="account-confirm-password-input"
              type="password"
              autoComplete="new-password"
              disabled={submitting}
              invalid={mismatch !== undefined}
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
              }}
            />
          )}
        </Field>
      </form>
    </Sheet>
  );
}
