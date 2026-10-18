'use client';

// 19-04: confirms a manual rollback to a retained known-good deployment. The dialog names the target
// commit and sends one Idempotency-Key per open (crypto.randomUUID), reused on every retry, so a
// double click or a retry after a lost response creates a single rollback deployment. The confirm
// button is disabled while the request is in flight. The shared Dialog from @noodara/ui has no
// disabled-confirm or inline-error slot, so this is a small modal of its own (role="dialog",
// aria-modal, Escape closes unless a request is in flight).
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@noodara/ui';
import { rollbackService, type DeploymentView } from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';
import { serviceActionCopy, shortSha } from '../lib/service-status-copy';

export const ROLLBACK_IN_PROGRESS_DIALOG_COPY =
  'A deployment is already running for this service. Wait for it to finish or cancel it, then roll back.';
export const ROLLBACK_TARGET_UNAVAILABLE_COPY =
  "This version can't be rolled back to any more: its image is no longer on the server. Close this and pick another version.";

export interface RollbackDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly serviceId: string;
  /** The known-good deployment to return to; null while closed. */
  readonly target: DeploymentView | null;
  /** The queued rollback deployment, once the request is accepted. */
  readonly onRolledBack: (deployment: DeploymentView) => void;
}

export function RollbackDialog({ open, onOpenChange, serviceId, target, onRolledBack }: RollbackDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const submittingRef = useRef(false);

  // One key per open: generated here, kept across retries, dropped on close.
  useEffect(() => {
    if (open) {
      keyRef.current = crypto.randomUUID();
      submittingRef.current = false;
      setSubmitting(false);
      setError(null);
    } else {
      keyRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submittingRef.current) onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const shown = open && target !== null;

  // Focus moves into the dialog on open, Tab wraps inside it, and focus returns to the trigger on close.
  useEffect(() => {
    if (!shown) return undefined;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = (): HTMLElement[] =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    (focusables()[0] ?? dialogRef.current)?.focus();
    const onTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const active = document.activeElement;
      if (!(dialogRef.current?.contains(active) ?? false)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      if (trigger?.isConnected === true) trigger.focus();
    };
  }, [shown]);

  if (!open || target === null) return null;

  const sha = target.commitSha === null ? null : shortSha(target.commitSha);

  async function confirm(): Promise<void> {
    if (target === null || submittingRef.current) return;
    const key = keyRef.current ?? crypto.randomUUID();
    keyRef.current = key;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const result = await rollbackService(serviceId, target.id, key);
    submittingRef.current = false;
    setSubmitting(false);
    if (result.ok) {
      onRolledBack(result.data);
      onOpenChange(false);
      return;
    }
    if (result.unauthorized) {
      void requireSession();
      return;
    }
    if (result.code === 'DEPLOYMENT_IN_PROGRESS') {
      setError(ROLLBACK_IN_PROGRESS_DIALOG_COPY);
    } else if (result.code === 'ROLLBACK_TARGET_UNAVAILABLE') {
      setError(ROLLBACK_TARGET_UNAVAILABLE_COPY);
    } else {
      setError(serviceActionCopy(result.code));
    }
  }

  return (
    <div data-testid="rollback-dialog-root">
      <div className="fixed inset-0 z-40 bg-canvas/72" aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="rollback-dialog"
        className="fixed left-1/2 top-1/2 z-50 flex w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-hairline bg-surface-elevated p-8"
      >
        <h2 id={titleId} className="text-title font-semibold text-ink">
          {sha === null ? 'Roll back to this version?' : `Roll back to ${sha}?`}
        </h2>
        <p id={bodyId} className="text-body text-ink-secondary">
          {sha === null
            ? 'Noodara will run the retained image of this version again. Nothing is rebuilt.'
            : `Noodara will run the retained image built from commit ${sha} again. Nothing is rebuilt.`}
        </p>
        {error === null ? null : (
          <p role="alert" data-testid="rollback-error" className="text-callout text-status-error">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
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
            data-testid="rollback-confirm"
            disabled={submitting}
            loading={submitting}
            onClick={() => {
              void confirm();
            }}
          >
            Roll back
          </Button>
        </div>
      </div>
    </div>
  );
}
