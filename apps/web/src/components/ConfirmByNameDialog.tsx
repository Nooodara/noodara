'use client';

// 13-10: the one "type the exact name" confirmation for destructive deploy-engine actions (project,
// environment and, in 13-12, service delete). Built on packages/ui's DestructiveConfirmDialog, whose
// confirm button stays disabled until isConfirmationMatch (exact, case and whitespace sensitive).
// This wrapper adds what every caller needs the same way:
// - one request per confirm: a ref drops a second click while the first is in flight;
// - fixed copy for failures, never the server's text (`deleteOutcome`);
// - a 404 counts as done: the resource was already deleted elsewhere;
// - focus goes back to the trigger on close (the shell has no Radix Trigger to return to).
// The typed name only ever travels in the request body; nothing here touches the URL.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DestructiveConfirmDialog } from '@noodara/ui';
import type { DeployApiErrorCode } from '../lib/api-client';
import type { DeployApiResult } from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';

export type ConfirmOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface ConfirmByNameDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly requiredName: string;
  /** Runs the delete with the typed name; `ok: true` closes the dialog, otherwise the message shows
   *  under the input. Map an API result with `deleteOutcome`. */
  readonly onConfirm: (typedName: string) => Promise<ConfirmOutcome>;
  /** Where focus goes on close. Defaults to the element focused when the dialog opened; pass this
   *  when that element goes away (a row menu item). */
  readonly returnFocusTo?: () => HTMLElement | null;
  readonly 'data-testid'?: string;
}

export const CONFIRM_MISMATCH_COPY = "The name doesn't match. Type it exactly as shown, including case.";
export const CONFIRM_FAILED_COPY = "Couldn't delete it. Check your connection and try again.";
export const CONFIRM_SESSION_COPY = 'Your session has expired. Sign in again to continue.';

/** Maps a delete result to the dialog's outcome. NOT_FOUND is success (already gone); `recovery`
 *  gives fixed copy for codes the caller can explain (e.g. ENVIRONMENT_NOT_EMPTY). */
export function deleteOutcome(
  result: DeployApiResult<unknown>,
  recovery: Partial<Record<DeployApiErrorCode, string>> = {},
): ConfirmOutcome {
  if (result.ok || result.code === 'NOT_FOUND') return { ok: true };
  if (result.unauthorized) {
    void requireSession();
    return { ok: false, message: CONFIRM_SESSION_COPY };
  }
  const known = recovery[result.code];
  if (known !== undefined) return { ok: false, message: known };
  if (result.code === 'DELETE_CONFIRMATION_MISMATCH' || result.code === 'CONFIRMATION_MISMATCH') {
    return { ok: false, message: CONFIRM_MISMATCH_COPY };
  }
  return { ok: false, message: CONFIRM_FAILED_COPY };
}

export function ConfirmByNameDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  requiredName,
  onConfirm,
  returnFocusTo,
  'data-testid': testId,
}: ConfirmByNameDialogProps) {
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Layout effect: runs before Radix moves focus into the dialog (its FocusScope uses useEffect),
  // so activeElement is still the trigger.
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      setError(undefined);
    }
    if (!open && wasOpen.current) {
      const target = returnFocusTo?.() ?? opener.current;
      opener.current = null;
      if (target?.isConnected === true) {
        // Again after Radix's own close handling (a 0ms timer), which focuses nothing without a
        // Trigger and would otherwise leave focus on <body>.
        target.focus();
        setTimeout(() => {
          if (target.isConnected) target.focus();
        }, 0);
      }
    }
    wasOpen.current = open;
  }, [open, returnFocusTo]);

  async function confirm(typed: string): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    let outcome: ConfirmOutcome;
    try {
      outcome = await onConfirm(typed);
    } catch {
      outcome = { ok: false, message: CONFIRM_FAILED_COPY };
    }
    inFlight.current = false;
    if (!mounted.current) return;
    if (outcome.ok) {
      onOpenChange(false);
      return;
    }
    setError(outcome.message);
  }

  return (
    <DestructiveConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      requiredName={requiredName}
      onConfirm={(typed) => void confirm(typed)}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      {...(error === undefined ? {} : { error })}
    />
  );
}
