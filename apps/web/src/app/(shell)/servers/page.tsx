'use client';

// The servers list screen (SERV-04, 05-UI-SPEC.md SS2.3) -- the landing screen after login and
// the entry point of the critical path (D-09: rows, not cards; a row menu, not a column).
// Replaces Plan 05-12's minimal placeholder. Owns the one `GET /api/servers` fetch, the shared
// SSE subscription's fold through `applyServerEvent`, and the shell's `onResync` registration so
// a stream reconnect resyncs the list exactly like a fresh page load (05-UI-SPEC.md SS6). All
// three screen states (loading/error/ready incl. empty) are rendered by `ServerList`, which this
// page only feeds data -- `state` here is literally a `ServerListState`, so there is never a
// separate status/error/servers triple to keep in sync with it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@noodara/ui';
import { Toolbar } from '../../../components/Toolbar';
import { ServerList, type ServerListState } from '../../../components/ServerList';
import { ServerSheet } from '../../../components/ServerSheet';
import { DeleteServerDialog } from '../../../components/DeleteServerDialog';
import { apiGet, type ApiErrorCode, type ServerView } from '../../../lib/api-client';
import { copyForErrorCode } from '../../../lib/error-copy';
import { requireSession } from '../../../lib/require-session';
import { applyServerEvent } from '../../../lib/server-store';
import { useShellContext } from '../../../lib/shell-context';

const INITIAL_STATE: ServerListState = { kind: 'loading' };

// NETWORK_ERROR has no ServiceErrorCode counterpart (a rejected `fetch`, not a server response);
// api-client.ts already crafted a safe, non-raw message for it, so it is the one code rendered
// straight from `ApiFailure.message` rather than through `copyForErrorCode` -- same pattern
// login/page.tsx (05-11) already established for this exact code.
function genericFailureMessage(code: ApiErrorCode, message: string): string {
  if (code === 'NETWORK_ERROR') return message;
  return copyForErrorCode(code);
}

// 05-17-PLAN.md: the sheet's own open/mode/target-server state, owned by this page (not the
// sheet itself) -- `null` means closed. Both the toolbar's primary action and the empty state's
// own "Add server" button open the same create sheet.
type SheetState = { readonly mode: 'create'; readonly server: null } | { readonly mode: 'edit'; readonly server: ServerView };

interface ListServersResponse {
  readonly items: ServerView[];
}

export default function ServersPage() {
  const { subscribe, registerResync } = useShellContext();
  const [state, setState] = useState<ServerListState>(INITIAL_STATE);
  // Read inside the SSE subscription callback -- that callback is registered once (empty deps)
  // and must always see the current kind, not the kind from the render it was created in.
  const stateKindRef = useRef(state.kind);
  stateKindRef.current = state.kind;

  const fetchServers = useCallback((): void => {
    setState({ kind: 'loading' });

    void apiGet<ListServersResponse>('/api/servers').then((result) => {
      if (!result.ok) {
        if (result.unauthorized) {
          // The shell's own session guard owns the redirect (T-5-53) -- this screen never
          // navigates to /login itself.
          void requireSession();
          return;
        }
        setState({
          kind: 'error',
          error: {
            message: `Couldn't load servers. ${genericFailureMessage(result.code, result.message)}`,
            code: result.code,
          },
          onRetry: fetchServers,
        });
        return;
      }

      setState({ kind: 'ready', servers: result.data.items });
    });
    // fetchServers is self-referential (its own `error` branch stores itself as `onRetry`); it
    // reads no state/props, so an empty dependency array is correct, not a staleness bug.
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Every reconnect resyncs from a fresh GET /api/servers, exactly like a normal page load --
  // there is no event replay (05-UI-SPEC.md SS6 "Resync on reconnect").
  useEffect(() => registerResync(fetchServers), [registerResync, fetchServers]);

  useEffect(
    () =>
      subscribe((event) => {
        if (stateKindRef.current !== 'ready') return;
        setState((prev) => (prev.kind === 'ready' ? { kind: 'ready', servers: applyServerEvent(prev.servers, event) } : prev));
      }),
    [subscribe],
  );

  // The empty state (ServerList.tsx's own EmptyState) already renders the one "Add server"
  // action for that state -- the toolbar suppresses its own copy of the same action while empty
  // so the screen never shows two "Add server" buttons at once (05-UI-SPEC.md SS2.3's empty
  // state is explicit about "single button").
  const isEmpty = state.kind === 'ready' && state.servers.length === 0;

  const [sheetState, setSheetState] = useState<SheetState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerView | null>(null);

  function openCreateSheet(): void {
    setSheetState({ mode: 'create', server: null });
  }
  function openEditSheet(server: ServerView): void {
    setSheetState({ mode: 'edit', server });
  }

  return (
    <>
      <Toolbar
        title="Servers"
        primaryAction={
          isEmpty ? undefined : (
            <Button variant="primary" data-testid="servers-add-button" onClick={openCreateSheet}>
              Add server
            </Button>
          )
        }
      />
      <div className="mx-auto max-w-[1120px] p-8">
        <ServerList
          state={state}
          now={new Date()}
          onAddServer={openCreateSheet}
          onEditServer={openEditSheet}
          onDeleteServer={setDeleteTarget}
        />
      </div>
      <ServerSheet
        open={sheetState !== null}
        onOpenChange={(open) => {
          if (!open) setSheetState(null);
        }}
        mode={sheetState?.mode ?? 'create'}
        server={sheetState?.server ?? null}
        onSaved={fetchServers}
      />
      <DeleteServerDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        server={deleteTarget}
        onDeleted={fetchServers}
      />
    </>
  );
}
