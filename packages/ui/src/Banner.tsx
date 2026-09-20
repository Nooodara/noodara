import type { ReactNode } from 'react';
import { Button } from './Button.js';
import { cn } from './cn.js';

export interface BannerAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface BannerProps {
  readonly message: string;
  readonly errorCode?: string;
  readonly action?: BannerAction;
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
}

const ROOT_CLASSES = cn('flex flex-col gap-3 rounded-md border border-hairline bg-status-error-soft px-5 py-4');

// Banner (skill SS5 "Error", 05-UI-SPEC.md Component Inventory + SS10) -- the one place a
// failure state reaches the DOM: a hairline-bordered block on a `--status-error-soft` background,
// a `message` at `--text-body`, an optional `errorCode` in `--text-mono` carrying `data-mono`, and
// at most one action `Button`. `message` and `errorCode` are always two separate props, never
// composed into one string -- 05-UI-SPEC.md SS10 names this component's own contract: the only
// permitted message source is the API's own `message` field, never a stack trace or a serialized
// request payload. `children` lets the `HOST_KEY_CHANGED` banner (a later plan) stack extra mono
// rows below the message without this component needing to know their shape.
export function Banner({ message, errorCode, action, children, 'data-testid': testId }: BannerProps) {
  const hasFooter = action !== undefined || errorCode !== undefined;

  return (
    <div data-testid={testId} role="alert" className={ROOT_CLASSES}>
      <p className="text-body text-ink">{message}</p>
      {children}
      {hasFooter ? (
        <div className="flex items-center justify-between gap-4">
          {action ? (
            <Button type="button" variant="ghost" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : (
            <span />
          )}
          {errorCode !== undefined ? (
            // text-ink-secondary, not text-ink-tertiary (05-33 continuation, D3 call-site fix,
            // 2026-09-20): --ink-tertiary on this banner's own --status-error-soft-over-
            // --surface-1 tint measured 1.83:1 light / 2.83:1 dark -- both real AA failures.
            // --ink-secondary clears 4.5:1 here in both themes (measured, see contrast.test.ts).
            <span data-mono="true" className="text-mono text-ink-secondary">
              {errorCode}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
