import { useEffect, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button } from './Button.js';
import { cn } from './cn.js';
import { Field } from './Field.js';
import { Input } from './Input.js';
import { isConfirmationMatch } from './confirm-match.js';

const OVERLAY_CLASSES = 'fixed inset-0 z-40 bg-canvas/72';

const PANEL_CLASSES = cn(
  'fixed left-1/2 top-1/2 z-50 flex w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
  'rounded-lg border border-hairline bg-surface-1 p-8',
);

const ACTIONS_CLASSES = 'flex items-center justify-end gap-2';

interface DialogShellProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: string;
  readonly 'data-testid'?: string | undefined;
  readonly children: ReactNode;
}

// Shared panel/overlay/Title/Description scaffold both dialog variants below sit on. Used for
// delete AND trust-new-fingerprint confirmation (D-03), so it owns no delete-specific copy of
// its own -- every string is a caller-supplied prop.
function DialogShell({ open, onOpenChange, title, body, 'data-testid': testId, children }: DialogShellProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASSES} />
        <DialogPrimitive.Content className={PANEL_CLASSES} data-testid={testId}>
          <DialogPrimitive.Title className="text-title font-semibold text-ink">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-body text-ink-secondary">{body}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly 'data-testid'?: string;
}

// ConfirmDialog (05-UI-SPEC.md Component Inventory's generic "confirm" Dialog variant, skill
// SS4.5) -- a non-destructive confirmation with no typed-name gate. Title/body wire to the
// primitive's own Title/Description so the dialog's accessible name and description come from
// Radix, not a hand-rolled aria-label.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  'data-testid': testId,
}: ConfirmDialogProps) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={title} body={body} data-testid={testId}>
      <div className={ACTIONS_CLASSES}>
        <DialogPrimitive.Close asChild>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </DialogPrimitive.Close>
        <Button type="button" variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </DialogShell>
  );
}

export interface DestructiveConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly requiredName: string;
  readonly onConfirm: (typedValue: string) => void;
  readonly error?: string;
  /** Optional extra content rendered between the description and the type-the-name input --
   *  05-19-PLAN.md's trust-new-fingerprint dialog (D-03) repeats both fingerprints in mono here
   *  (SS5.7: "fingerprints repeated in mono above the input"), so the admin never has to scroll
   *  back up to the banner while confirming. `undefined` renders nothing extra, matching every
   *  existing caller (delete-server) unchanged. */
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
}

// DestructiveConfirmDialog (05-UI-SPEC.md SS5.7, D-03) -- used for both delete-server and
// trust-new-fingerprint, the two "type the name to confirm" flows this phase needs. The typed
// value is local, uncontrolled state reset every time the dialog opens; isConfirmationMatch is
// the same pure predicate confirm-match.ts exports, so this component and its own unit tests
// agree on exactly one definition of "matches." The confirm button stays disabled until it
// does -- the API's own CONFIRMATION_MISMATCH error is what actually enforces this server-side;
// the optional `error` prop is where that response's message surfaces, rendered by Field's
// existing role="alert" error slot rather than a second, bespoke error element.
export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  requiredName,
  onConfirm,
  error,
  children,
  'data-testid': testId,
}: DestructiveConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) {
      setTyped('');
    }
  }, [open]);

  const matches = isConfirmationMatch(requiredName, typed);

  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title={title} body={body} data-testid={testId}>
      {children}
      <Field label="Type the name to confirm" {...(error === undefined ? {} : { error })}>
        {(controlProps) => (
          <Input
            {...controlProps}
            mono
            autoComplete="off"
            placeholder={requiredName}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        )}
      </Field>
      <div className={ACTIONS_CLASSES}>
        <DialogPrimitive.Close asChild>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </DialogPrimitive.Close>
        <Button
          type="button"
          variant="destructive"
          filled
          disabled={!matches}
          onClick={() => {
            onConfirm(typed);
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </DialogShell>
  );
}
