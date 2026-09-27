import type { ReactNode } from 'react';
import { Button } from './Button.js';
import { cn } from './cn.js';

export interface NoticeProps {
  readonly message: string;
  readonly onDismiss?: () => void;
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
}

const ROOT_CLASSES = cn('flex flex-col gap-3 rounded-md border border-hairline bg-surface-1 px-5 py-4');

// Notice (skill SS4.5 "Neutral" variant, 05-UI-SPEC.md SS5.2's D-02 first-trust notice) -- the
// deliberately neutral, dismissible surface. Default surface colour, no semantic tone anywhere in
// this file: a first-trust notice is not an error or a warning, so it never carries Banner's
// `--status-error-soft` treatment or a `data-tone` attribute. Dismissal is entirely caller-owned
// -- this component tracks no dismissed boolean of its own, it only ever invokes the supplied
// `onDismiss` once per click and lets the caller decide what "dismissed" means (05-UI-SPEC.md
// persists that decision client-side, keyed by server id). `children` carries mono content such
// as the verification command and the fingerprint itself.
export function Notice({ message, onDismiss, children, 'data-testid': testId }: NoticeProps) {
  return (
    // 09-UI-SPEC.md SS5.3 (09-10-PLAN.md Task 3): role="status" is an implicit polite live
    // region -- a screen reader announces this content the moment it mounts, with no focus move
    // required. Every existing caller of Notice gets this for free, not just the password-change
    // ones that first depended on it.
    <div data-testid={testId} className={ROOT_CLASSES} role="status">
      {/* UI-09 (08-15-PLAN.md Task 1): a 70ch measure cap plus normal-nums -- this is prose, not
          a value that must line up in a column, so it opts out of the page-wide tabular-nums
          default declared in apps/web/src/app/globals.css. */}
      <p className="max-w-[70ch] text-body text-ink normal-nums">{message}</p>
      {children}
      {onDismiss ? (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}
