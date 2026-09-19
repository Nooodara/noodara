// The servers-list screen's own list body (SERV-04, 05-UI-SPEC.md SS2.3) -- renders exactly one
// of the three states (`loading` / `error` / `ready`), never a spinner and never a card layout
// (D-09 explicitly rejects an alternate presentation for a small number of servers, asserted at a
// count of one). `apps/web/src/app/(shell)/servers/page.tsx` owns the actual `GET /api/servers`
// fetch, the shared SSE resync registration and the toolbar's own "Add server" action -- this
// component only renders whatever state it is handed.
import { Banner, EmptyState, SkeletonRow } from '@noodara/ui';
import type { ServerView } from '../lib/api-client';
import { ServerRow } from './ServerRow';

const SKELETON_ROW_COUNT = 5;

export interface ServerListErrorState {
  readonly message: string;
  readonly code: string;
}

export type ServerListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ServerListErrorState; readonly onRetry: () => void }
  | { readonly kind: 'ready'; readonly servers: readonly ServerView[] };

export interface ServerListProps {
  readonly state: ServerListState;
  /** The caller's own clock, explicit -- threaded straight through to every row's `RelativeTime`
   *  (no platform clock read inside this component or its rows). */
  readonly now: Date;
  readonly onAddServer: () => void;
}

// Plan 05-17 connects the real edit sheet and the destructive delete confirm dialog to each row's
// `...` menu -- this plan only builds the row and its menu, so both handlers are deliberate
// no-ops, named for the plan that replaces them rather than left unexplained.
function noopEditServer(): void {
  // Plan 05-17 opens the edit sheet for this server.
}
function noopDeleteServer(): void {
  // Plan 05-17 opens the destructive delete confirm dialog for this server.
}

export function ServerList({ state, now, onAddServer }: ServerListProps) {
  if (state.kind === 'loading') {
    return (
      <div data-testid="servers-loading">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          // A fixed-length, never-reordered placeholder list -- there is no stable identity to
          // key by before real data exists, so the index is a safe, stable key here.
          <SkeletonRow key={index} data-testid={`servers-skeleton-row-${String(index)}`} />
        ))}
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <Banner
        data-testid="servers-error-banner"
        message={state.error.message}
        errorCode={state.error.code}
        action={{ label: 'Retry', onClick: state.onRetry }}
      />
    );
  }

  if (state.servers.length === 0) {
    return (
      <EmptyState
        data-testid="servers-empty"
        title="No servers yet"
        body="Connect your first Ubuntu server to let Noodara discover it."
        action={{ label: 'Add server', onClick: onAddServer }}
      />
    );
  }

  return (
    <div data-testid="servers-list">
      {state.servers.map((server) => (
        <ServerRow key={server.id} server={server} now={now} onEdit={noopEditServer} onDelete={noopDeleteServer} />
      ))}
    </div>
  );
}
