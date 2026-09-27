'use client';

// The Name/Email account edit Sheet (SET-02, 09-CONTEXT.md D-01/D-02/D-04, 09-UI-SPEC.md §1.2).
// One component, two field configurations -- the per-field copy/testid table below is the only
// thing that differs between "Edit name" and "Edit email", following ServerSheet.tsx's own
// reset-on-open pattern for the rest. The current-password value never leaves this component's
// own state except as part of the one PATCH /api/account/profile request body
// (apps/web/src/lib/account-form.ts's buildProfileRequest) -- it is cleared the instant the sheet
// closes (Cancel, Esc, outside click, or a successful save), never logged, never rendered back.
import { useEffect, useState, type RefObject } from 'react';
import { Banner, Button, Field, Input, Sheet } from '@noodara/ui';
import { apiSend, type ApiFailure } from '../lib/api-client';
import { buildProfileRequest, canSubmitProfile, retryMessage } from '../lib/account-form';
import { ACCOUNT_GENERIC_ERROR, accountFieldErrors, type AccountFormField } from '../lib/error-copy';
import { requireSession } from '../lib/require-session';
import { refreshSessionUser } from '../lib/session-user';

export type AccountProfileField = 'name' | 'email';

export interface AccountProfileSheetProps {
  readonly field: AccountProfileField;
  /** The field's current value, shown pre-filled -- the sheet never fetches it itself. */
  readonly initialValue: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Captured by the row's own `onClick`, before `onOpenChange(true)` (09-UI-SPEC.md §5.2) --
   *  focus returns here on close. */
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}

interface ProfileFieldCopy {
  readonly sheetTestId: string;
  readonly title: string;
  readonly label: string;
  readonly inputTestId: string;
  readonly inputType: 'text' | 'email';
  readonly autoComplete: string;
  readonly saveTestId: string;
  readonly saveLabel: string;
}

const FIELD_COPY: Record<AccountProfileField, ProfileFieldCopy> = {
  name: {
    sheetTestId: 'account-name-sheet',
    title: 'Edit name',
    label: 'Name',
    inputTestId: 'account-name-input',
    inputType: 'text',
    autoComplete: 'name',
    saveTestId: 'account-name-save',
    saveLabel: 'Save name',
  },
  email: {
    sheetTestId: 'account-email-sheet',
    title: 'Edit email',
    label: 'Email',
    inputTestId: 'account-email-input',
    inputType: 'email',
    autoComplete: 'email',
    saveTestId: 'account-email-save',
    saveLabel: 'Save email',
  },
};

export function AccountProfileSheet({ field, initialValue, open, onOpenChange, returnFocusRef }: AccountProfileSheetProps) {
  const copy = FIELD_COPY[field];
  const [value, setValue] = useState(initialValue);
  const [currentPassword, setCurrentPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<AccountFormField, string>>>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-initializes every time the sheet transitions to open, mirroring ServerSheet.tsx's own
  // reset-on-open effect -- never on a stray re-render, and never on every keystroke.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setCurrentPassword('');
      setFieldErrors({});
      setBannerMessage(null);
      setSubmitting(false);
    }
  }, [open, field, initialValue]);

  // T-09-14: the moment the sheet closes -- Cancel, Esc, outside click or a successful save --
  // the current password is discarded and focus returns to whichever row's Edit button opened
  // this sheet (09-UI-SPEC.md §5.2).
  useEffect(() => {
    if (!open) {
      setCurrentPassword('');
      returnFocusRef.current?.focus();
    }
  }, [open, returnFocusRef]);

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
    if (submitting || !canSubmitProfile({ value, currentPassword })) return;

    setFieldErrors({});
    setBannerMessage(null);
    setSubmitting(true);

    const body = buildProfileRequest(field, value, currentPassword);
    const result = await apiSend('PATCH', '/api/account/profile', body);
    setSubmitting(false);

    if (!result.ok) {
      handleFailure(result);
      return;
    }

    // D-04: revalidate the shared session store so AccountMenu/Settings re-render the new value
    // without a reload, then close.
    await refreshSessionUser();
    onOpenChange(false);
  }

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
        data-testid={copy.saveTestId}
        loading={submitting}
        disabled={!canSubmitProfile({ value, currentPassword })}
        onClick={() => void handleSubmit()}
      >
        {copy.saveLabel}
      </Button>
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={copy.title} data-testid={copy.sheetTestId} footer={footer}>
      {bannerMessage !== null ? <Banner message={bannerMessage} /> : null}
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Field label={copy.label} {...(fieldErrors[field] === undefined ? {} : { error: fieldErrors[field] })}>
          {(controlProps) => (
            <Input
              {...controlProps}
              data-testid={copy.inputTestId}
              type={copy.inputType}
              autoFocus
              autoComplete={copy.autoComplete}
              disabled={submitting}
              invalid={fieldErrors[field] !== undefined}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Current password"
          {...(fieldErrors.currentPassword === undefined ? {} : { error: fieldErrors.currentPassword })}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              data-testid="account-current-password-input"
              type="password"
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
      </form>
    </Sheet>
  );
}
