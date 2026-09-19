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
    <div data-testid={testId} className={ROOT_CLASSES}>
      <p className="text-body text-ink">{message}</p>
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
