import { useId, type ReactNode } from 'react';

// The props Field hands to its child control render prop -- id links the control to the
// label via htmlFor/id, aria-describedby composes whichever of help/error is present, and
// aria-invalid is only ever `true` (never a literal `false`) so the attribute is genuinely
// absent, not stringified, when there is no error (matches Button's aria-busy precedent,
// 05-22-PLAN.md).
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: true;
}

export interface FieldProps {
  readonly label: string;
  readonly help?: string;
  readonly error?: string;
  readonly children: (controlProps: FieldControlProps) => ReactNode;
}

// Field (skill SS4.5, 05-UI-SPEC.md Component Inventory) -- the label/control/help/error
// wrapper every form row in the product uses. A render-prop child (not cloneElement) keeps
// this component agnostic of which concrete control it wraps: a plain <input> in this file's
// own test, Input/Textarea in later tasks. Ids come from React's useId, never a hand-rolled
// counter, so they stay stable and collision-free across concurrent renders.
export function Field({ label, help, error, children }: FieldProps) {
  const controlId = useId();
  const helpId = useId();
  const errorId = useId();

  const describedByIds = [help ? helpId : null, error ? errorId : null].filter(
    (id): id is string => id !== null,
  );

  const controlProps: FieldControlProps = {
    id: controlId,
    ...(describedByIds.length > 0 ? { 'aria-describedby': describedByIds.join(' ') } : {}),
    ...(error ? { 'aria-invalid': true as const } : {}),
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={controlId} className="text-callout font-medium text-ink">
        {label}
      </label>
      {children(controlProps)}
      {help ? (
        <p id={helpId} className="text-caption text-ink-tertiary">
          {help}
        </p>
      ) : null}
      {error ? (
        // text-status-error-text, not text-status-error (05-33 continuation, WR-C-08 call-site
        // fix, 2026-09-20): the base token measured 3.54:1 on --surface-1 in light -- a real AA
        // failure on real inline error text, fixed by moving this call site to the pill-word
        // token, which clears 4.5:1 here too (measured, see contrast.test.ts).
        <p id={errorId} role="alert" className="text-caption text-status-error-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
