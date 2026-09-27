'use client';

// The Settings screen (SET-01, 05-UI-SPEC.md SS2.7) -- fetches the read-only `GET /api/config` on
// mount and renders SettingsGroups.tsx's four groups: Account, Appearance, Instance and Advanced.
// Account management itself (Name/Email/Password edit Sheets, the password-change Notice) lives
// entirely in SettingsGroups.tsx's own Account group (09-12-PLAN.md) -- this file's fetch/loading/
// error handling is unchanged, config-only, and does not gate or wait on the account/preferences
// data SettingsGroups reads through its own hooks. A failed `GET /api/config` fetch, including an
// expired credential state, renders through the same generic error banner as any other failure
// below -- this screen deliberately does not special-case that outcome with its own redirect.
import { useCallback, useEffect, useState } from 'react';
import { Banner, SkeletonRow } from '@noodara/ui';
import { Toolbar } from '../../../components/Toolbar';
import { SettingsGroups } from '../../../components/SettingsGroups';
import { apiGet, type ApiErrorCode } from '../../../lib/api-client';
import { copyForErrorCode } from '../../../lib/error-copy';
import type { ConfigResponse } from '../../../lib/settings-rows';

type SettingsPageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly code: string; readonly onRetry: () => void }
  | { readonly kind: 'ready'; readonly config: ConfigResponse };

// 2 Instance rows + 5 Advanced rows -- the loading state's own flat placeholder count, matching
// the total this screen ends up rendering once GET /api/config resolves.
const SETTINGS_SKELETON_ROW_COUNT = 7;

// Same NETWORK_ERROR carve-out every other screen's own fetch handler already established --
// api-client.ts already crafts a safe, non-raw message for a rejected fetch, so it is the one
// code rendered straight from `ApiFailure.message` rather than through `copyForErrorCode`.
function genericFailureMessage(code: ApiErrorCode, message: string): string {
  if (code === 'NETWORK_ERROR') return message;
  return copyForErrorCode(code);
}

export default function SettingsPage() {
  const [state, setState] = useState<SettingsPageState>({ kind: 'loading' });

  const fetchConfig = useCallback((): void => {
    setState({ kind: 'loading' });

    void apiGet<ConfigResponse>('/api/config').then((result) => {
      if (!result.ok) {
        setState({
          kind: 'error',
          message: `Couldn't load configuration. ${genericFailureMessage(result.code, result.message)}`,
          code: result.code,
          onRetry: fetchConfig,
        });
        return;
      }

      setState({ kind: 'ready', config: result.data });
    });
    // Self-referential (its own `error` branch stores itself as `onRetry`); an empty dependency
    // array is correct here, matching every other screen's own fetch-on-mount callback.
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  return (
    <>
      <Toolbar title="Settings" />
      <div className="mx-auto max-w-[1120px] p-8">
        {state.kind === 'loading' ? (
          <div data-testid="settings-loading" className="flex flex-col gap-1">
            {Array.from({ length: SETTINGS_SKELETON_ROW_COUNT }, (_, index) => (
              // A fixed-length, never-reordered placeholder list -- there is no stable identity to
              // key by before real data exists, matching servers/page.tsx's own precedent.
              <SkeletonRow key={index} data-testid={`settings-skeleton-row-${String(index)}`} />
            ))}
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <Banner
            data-testid="settings-error-banner"
            message={state.message}
            errorCode={state.code}
            action={{ label: 'Retry', onClick: state.onRetry }}
          />
        ) : null}

        {state.kind === 'ready' ? <SettingsGroups config={state.config} /> : null}
      </div>
    </>
  );
}
