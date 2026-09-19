'use client';

// The Settings screen (SET-01, 05-UI-SPEC.md SS2.7) -- fetches the read-only `GET /api/config` on
// mount and renders SettingsGroups.tsx's Instance/Advanced groups. D-15 keeps every account-
// management surface (a list of active credentials, a revoke-one/revoke-all control, "sign out
// everywhere") out of this phase entirely -- signing out stays reachable from the shell's own
// fixed bottom cluster on every authenticated screen (05-12-PLAN.md), never duplicated here, and
// this file adds no such control of its own. A failed fetch, including an expired credential
// state, renders through the same generic error banner as any other failure below -- this screen
// deliberately does not special-case that outcome with its own redirect, matching D-15's scope.
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
