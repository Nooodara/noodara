import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button } from './Button.js';
import { cn } from './cn.js';
import { Field } from './Field.js';
import { Input } from './Input.js';
import { isConfirmationMatch } from './confirm-match.js';
import { useCloseSource } from './use-close-source.js';

const OVERLAY_CLASSES = 'fixed inset-0 z-40 bg-canvas/72';

// UI-03 (08-06-PLAN.md Task 1, 08-UI-SPEC.md SS5.1/5.2): `--shadow-floating` applies to exactly
// four components -- Sheet, Dialog, RowMenu, AccountMenu (scripts/check-ui-safety.mjs's
// SHADOW_ALLOWLIST is the machine-checked gate that proves no other component ever gets one).
// The new surface-elevated alias (solid, no translucency -- Dialog is a modal, scrim-backed)
// replaces the old surface-1 background so dark mode sits one step lighter (surface-2); light
// stays byte-identical.
//
// UI-10 (08-06-PLAN.md Task 2, 08-UI-SPEC.md SS10): Dialog gets `contrast-more:` (Tailwind's
// built-in variant for `prefers-contrast: more`) swapping the hairline for the strong token --
// the one real boundary a low-contrast border could otherwise erase (T-08-19). No
// reduced-transparency override: Dialog is already solid, so there is nothing to drop.
const PANEL_CLASSES = cn(
  'fixed left-1/2 top-1/2 z-50 flex w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
  'rounded-lg border border-hairline bg-surface-elevated p-8 shadow-[var(--shadow-floating)]',
  'contrast-more:border-hairline-strong',
);

const ACTIONS_CLASSES = 'flex items-center justify-end gap-2';

// 08-20-PLAN.md Task 2 (UI-05/§9 #10, pitfall P14): appended to `PANEL_CLASSES` only while the
// in-flight close is keyboard-initiated (`useCloseSource`, owned by 08-04, imported read-only
// here). `!duration-0` mirrors Sheet.tsx's own identical override (08-12) -- Tailwind's `!`
// important-modifier wins the specificity fight against any un-flagged transition-duration
// utility a later plan (08-14, UI-07) composes into `PANEL_CLASSES`, so Radix's own
// CSS-transition-duration-based exit deferral sees a zero duration and unmounts the panel
// immediately for a keyboard close -- no `onEscapeKeyDown` override, no second keydown listener,
// the existing `check:ui-safety` gate for both stays green.
const INSTANT_CLOSE_CLASS = '!duration-0';

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
//
// 08-20-PLAN.md Task 2 (UI-05/§9 #10, pitfall P14): `useCloseSource` is called here, once, with
// this shell's own `open` prop and content ref -- the same externally-controlled-overlay shape
// `Sheet.tsx` (08-12) uses. Read directly at render time (not behind an effect+state pair): by
// the time Radix's own Escape handling calls `onOpenChange(false)` and this component re-renders
// with the new `open` value, the primitive's own capture-phase keydown listener has already run
// for that same event (fires before React's batched state update is ever applied -- see
// `use-close-source.ts`'s own header comment), so `closeSource()` already reports 'keyboard'
// during that very render -- no extra render pass needed to catch up. `ConfirmDialog` and
// `DestructiveConfirmDialog` both inherit this from this one place; neither declares its own.
function DialogShell({ open, onOpenChange, title, body, 'data-testid': testId, children }: DialogShellProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { closeSource } = useCloseSource(open, contentRef);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASSES} />
        <DialogPrimitive.Content
          ref={contentRef}
          className={cn(PANEL_CLASSES, closeSource() === 'keyboard' && INSTANT_CLOSE_CLASS)}
          data-testid={testId}
        >
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
