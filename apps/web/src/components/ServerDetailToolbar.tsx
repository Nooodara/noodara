'use client';

// The server detail screen's own toolbar (D-10, 05-UI-SPEC.md SS2.5): "← Servers" back link, the
// server name as the page title at `--text-display` with its `StatusPill` inline, and the single
// status-driven primary action from `apps/web/src/lib/detail-state.ts`'s `derivePrimaryAction`.
//
// Deliberately not built on the shared `apps/web/src/components/Toolbar.tsx` (every other screen's
// own chrome): that component's `title` prop is a plain `string` rendered at `--text-title`
// (20px) -- every other screen's static title ("Servers", "Activity", "Settings"). Server detail's
// title is data (the server's own name) at the larger `--text-display` (28px) with a `StatusPill`
// immediately inline, per 05-UI-SPEC.md SS2.5's explicit override of the generic shell rule. A
// present `backLink` always replaces the shell's own mobile hamburger-menu slot on this screen
// (Toolbar.tsx's own doc comment already anticipates this), so no mobile-nav fallback is needed
// here either.
import Link from 'next/link';
import { useState } from 'react';
import type { ServerStatus } from '@noodara/domain/server';
import { Button, StatusPill } from '@noodara/ui';
import type { PrimaryAction } from '../lib/detail-state';
import { apiSend, type ApiErrorCode } from '../lib/api-client';
import { copyForErrorCode, type ServiceErrorCode } from '../lib/error-copy';
import { useShellContext } from '../lib/shell-context';
import { StreamStatus } from './StreamStatus';

export interface ServerDetailToolbarProps {
  readonly serverId: string;
  readonly serverName: string;
  readonly status: ServerStatus;
  readonly primaryAction: PrimaryAction | null;
  /** Called once the toolbar's own POST settles (success, a swallowed 409, or a real failure) --
   *  this component never owns the server's data itself; the page refetches/patches in place. */
  readonly onActionSettled?: () => void;
}

function isServiceErrorCode(code: ApiErrorCode): code is ServiceErrorCode {
  return code !== 'NETWORK_ERROR';
}

/** `NETWORK_ERROR` has no `ServiceErrorCode` counterpart -- api-client.ts already crafted a safe,
 *  non-raw message for it, so it is rendered straight from `ApiFailure.message` rather than
 *  through `copyForErrorCode`, matching the same precedent `(shell)/servers/page.tsx` already
 *  established for this exact code. */
function toastMessage(code: ApiErrorCode, message: string): string {
  return isServiceErrorCode(code) ? copyForErrorCode(code) : message;
}

export function ServerDetailToolbar({ serverId, serverName, status, primaryAction, onActionSettled }: ServerDetailToolbarProps) {
  const { connected } = useShellContext();
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    if (primaryAction === null || primaryAction.disabled || pending) return;

    setPending(true);
    setErrorMessage(null);

    const result = await apiSend('POST', `/api/servers/${encodeURIComponent(serverId)}${primaryAction.endpoint}`);

    setPending(false);

    if (!result.ok) {
      // 05-UI-SPEC.md SS5.4/SS6: a stray click landing while a connect is already in flight is a
      // state confirmation, not an error -- never surfaced as a toast for this one code.
      if (result.code !== 'ALREADY_CONNECTING') {
        setErrorMessage(toastMessage(result.code, result.message));
      }
    }

    onActionSettled?.();
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="server-detail-toolbar"
        className="sticky top-0 z-30 flex h-[52px] items-center gap-3 border-b border-hairline bg-surface-1/90 px-4 backdrop-blur"
      >
        <Link href="/servers" className="shrink-0 text-callout text-ink-secondary hover:text-ink">
          ← Servers
        </Link>
        <div className="flex flex-1 items-center gap-3 truncate">
          <h1 className="truncate text-display font-semibold text-ink">{serverName}</h1>
          <StatusPill status={status} />
        </div>
        <StreamStatus connected={connected} />
        {primaryAction !== null ? (
          <Button
            type="button"
            variant="primary"
            data-testid="server-detail-primary-action"
            disabled={primaryAction.disabled || pending}
            loading={pending}
            onClick={() => void handleClick()}
          >
            {primaryAction.label}
          </Button>
        ) : null}
      </div>
      {/* No shared Toast primitive exists yet in packages/ui (Plans 05-17/05-19 will also need
          one) -- this inline, dismissible-by-nature (cleared on the next click) message is a
          deliberately minimal stand-in for 05-UI-SPEC.md SS5.4's toast requirement rather than new
          shared infrastructure this one plan has no mandate to build. */}
      {errorMessage !== null ? (
        <p data-testid="server-detail-toolbar-toast" className="px-4 text-caption text-status-error">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
