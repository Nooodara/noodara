// The servers-list screen's own list body (SERV-04, 05-UI-SPEC.md SS2.3) -- renders exactly one
// of the three states (`loading` / `error` / `ready`), never a spinner and never a card layout
// (D-09 explicitly rejects an alternate presentation for a small number of servers, asserted at a
// count of one). `apps/web/src/app/(shell)/servers/page.tsx` owns the actual `GET /api/servers`
// fetch, the shared SSE resync registration and the toolbar's own "Add server" action -- this
// component only renders whatever state it is handed.
import { useEffect, useRef } from 'react';
import { Banner, EmptyState, InsetGroup, SkeletonRow } from '@noodara/ui';
import type { ServerView } from '../lib/api-client';
import { ServerRow } from './ServerRow';

const SKELETON_ROW_COUNT = 5;

// UI-07 (08-UI-SPEC.md §7.4/§8.3, D-11, 08-16-PLAN.md Task 1): the servers list's own one
// authored moment is a 40ms-per-index stagger on first load only -- capped at 8 rows' worth
// (320ms), a typical above-the-fold row count, so a list of 40 servers does not leave its last
// row waiting nearly a third of a second longer than an 8-row list would. Mirrors the identical
// "state the cap and the reasoning" convention DiscoveryStep.tsx (08-18-PLAN.md) already
// established for its own raw-checks stagger. `ServerRow` renders the already-computed delay; the
// 40ms math itself lives here as the single source of truth.
const ROW_STAGGER_STEP_MS = 40;
const ROW_STAGGER_MAX_ROWS = 8;
const ROW_STAGGER_MAX_DELAY_MS = ROW_STAGGER_MAX_ROWS * ROW_STAGGER_STEP_MS;

function rowStaggerDelayMs(index: number): number {
  return Math.min(index * ROW_STAGGER_STEP_MS, ROW_STAGGER_MAX_DELAY_MS);
}

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
  /** 05-17-PLAN.md: opens the real edit sheet / destructive delete confirm dialog for the given
   *  row -- this component owns no dialog/sheet state itself, only forwards the row menu's
   *  selection up to whichever screen composes it. */
  readonly onEditServer: (server: ServerView) => void;
  readonly onDeleteServer: (server: ServerView) => void;
}

export function ServerList({ state, now, onAddServer, onEditServer, onDeleteServer }: ServerListProps) {
  // UI-07/D-11 (08-16-PLAN.md Task 1): the first-load stagger plays exactly once -- on the first
  // render that actually has data -- never on a later re-render (a clock tick, an SSE-driven
  // status change) and never on a server added afterwards. `hasEnteredRef` flips to `true` in an
  // effect (after commit), so this render's own `isFirstLoad` read is still the pre-flip value;
  // the ref is never mutated during render itself and rows are never re-keyed on anything that
  // changes, so an entering row keeps its identity (and its focus) across every later render.
  const hasEnteredRef = useRef(false);
  const isFirstLoad = !hasEnteredRef.current;
  useEffect(() => {
    if (state.kind === 'ready' && state.servers.length > 0) {
      hasEnteredRef.current = true;
    }
  });

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

  return (
    <InsetGroup data-testid="servers-list">
      {state.servers.length === 0 ? (
        <EmptyState
          data-testid="servers-empty"
          title="No servers yet"
          body="Connect your first Ubuntu server to let Noodara discover it."
          action={{ label: 'Add server', onClick: onAddServer }}
        />
      ) : (
        state.servers.map((server, index) => (
          <ServerRow
            key={server.id}
            server={server}
            now={now}
            onEdit={onEditServer}
            onDelete={onDeleteServer}
            delayMs={rowStaggerDelayMs(index)}
            entering={isFirstLoad}
          />
        ))
      )}
    </InsetGroup>
  );
}
