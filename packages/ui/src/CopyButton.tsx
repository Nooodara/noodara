import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './Button.js';
import { Tooltip } from './Tooltip.js';

export interface CopyButtonProps {
  readonly value: string;
  readonly label?: string;
  readonly 'data-testid'?: string;
}

const CONFIRMATION_MS = 1500;
const ICON_PROPS = { 'aria-hidden': true, size: 16, strokeWidth: 1.5 } as const;

// CopyButton (05-UI-SPEC.md Component Inventory, T-5-37) -- an icon ghost Button that writes
// exactly the given `value` string to the OS clipboard via the Clipboard API's `writeText` method
// and no other channel. This must never be used for credential material -- its only intended callers
// are the fingerprint row (05-UI-SPEC.md SS2.5's Connection group), the public URL (SS2.7's
// Instance group) and the `ssh-keygen` verification command (SS5.2's first-trust notice); every
// one of those is a public/non-secret string. A rejected write (permission denied) or a missing
// API (an insecure/plain-HTTP context -- Noodara's own explicitly supported v0.1 deployment mode,
// where `navigator.clipboard` is `undefined`) is feature-detected up front and swallowed without
// throwing, without rendering a false "Copied" confirmation and without ever logging the value
// that failed to copy -- a copy failure is a UX gap, not something worth risking a
// credential-adjacent value over. (05-28-PLAN.md / VERIFICATION gap 4: the previous doc comment
// here claimed the missing-API case was already handled; `navigator.clipboard?.writeText` was in
// fact an unguarded member access that threw a synchronous TypeError before `.catch` could ever
// attach -- fixed by feature-detecting `writeText` before calling it.)
export function CopyButton({ value, label = 'Copy', 'data-testid': testId }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  const handleClick = () => {
    const writeText = navigator.clipboard?.writeText;
    if (typeof writeText !== 'function') {
      // Insecure context or an old/non-standard browser -- see doc comment above.
      return;
    }

    writeText
      .call(navigator.clipboard, value)
      .then(() => {
        if (timeoutRef.current !== undefined) {
          clearTimeout(timeoutRef.current);
        }
        setCopied(true);
        timeoutRef.current = setTimeout(() => {
          setCopied(false);
        }, CONFIRMATION_MS);
      })
      .catch(() => {
        // Deliberately empty: never throw, never confirm, never log the value (see doc comment).
      });
  };

  return (
    <Tooltip content={copied ? 'Copied' : label} {...(copied ? { open: true } : {})}>
      <Button type="button" variant="ghost" aria-label={label} data-testid={testId} onClick={handleClick}>
        {copied ? <Check {...ICON_PROPS} /> : <Copy {...ICON_PROPS} />}
      </Button>
    </Tooltip>
  );
}
