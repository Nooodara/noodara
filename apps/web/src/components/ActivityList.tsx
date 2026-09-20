// The activity log screen's own list body (ACT-02, 05-UI-SPEC.md §2.6) -- renders exactly one of
// the three states (`loading`/`error`/`ready`), day-grouped rows under `--text-label` headers, and
// the D-13 ghost "Load older" button. `apps/web/src/app/(shell)/activity/page.tsx` owns the actual
// `GET /api/activity` fetch, pagination and the shared SSE resync registration -- this component
// only renders whatever state it is handed, mirroring `ServerList.tsx`'s own split.
import { Banner, Button, EmptyState, SkeletonRow } from '@noodara/ui';
import { ActivityRow } from './ActivityRow';
import { groupByDay } from '../lib/activity-groups';
import type { ActivityItem, ServerLookup } from '../lib/activity-copy';

const SKELETON_ROW_COUNT = 10;

export interface ActivityListErrorState {
  readonly message: string;
  readonly code: string;
}

export type ActivityListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ActivityListErrorState; readonly onRetry: () => void }
  | {
      readonly kind: 'ready';
      readonly items: readonly ActivityItem[];
      readonly nextCursor: string | null;
      readonly loadingMore: boolean;
      readonly onLoadOlder: () => void;
    };

export interface ActivityListProps {
  readonly state: ActivityListState;
  /** The caller's own clock, explicit -- threaded through to `groupByDay` and every row's
   *  `RelativeTime` (no platform clock read inside this component or its rows). */
  readonly now: Date;
  readonly lookupServer: ServerLookup;
  /** The viewer's own time zone for day-header grouping (WR-B-06). Optional so tests can inject a
   *  fixed zone deterministically; defaults to the platform's own zone at runtime via
   *  `Intl.DateTimeFormat().resolvedOptions().timeZone` -- the one permitted platform-clock read
   *  in this screen family, kept here in the component layer and out of the pure
   *  `activity-groups.ts` module. */
  readonly timeZone?: string;
}

export function ActivityList({ state, now, lookupServer, timeZone }: ActivityListProps) {
  if (state.kind === 'loading') {
    return (
      <div data-testid="activity-loading">
        <div data-testid="activity-skeleton-day-header" className="py-2 text-label uppercase tracking-wide text-ink-tertiary">
          <span className="inline-block h-3 w-16 rounded-sm bg-surface-2" aria-hidden="true" />
        </div>
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          // A fixed-length, never-reordered placeholder list -- there is no stable identity to
          // key by before real data exists, matching ServerList.tsx's own precedent.
          <SkeletonRow key={index} data-testid={`activity-skeleton-row-${String(index)}`} />
        ))}
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <Banner
        data-testid="activity-error-banner"
        message={state.error.message}
        errorCode={state.error.code}
        action={{ label: 'Retry', onClick: state.onRetry }}
      />
    );
  }

  if (state.items.length === 0) {
    return <EmptyState data-testid="activity-empty" title="No activity yet" body="Actions you take will show up here." />;
  }

  const viewerTimeZone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const groups = groupByDay(state.items, now, viewerTimeZone);

  return (
    <div data-testid="activity-list">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="py-2 text-label uppercase tracking-wide text-ink-tertiary">{group.label}</div>
          {group.items.map((item) => (
            <ActivityRow key={item.id} item={item} now={now} lookupServer={lookupServer} />
          ))}
        </div>
      ))}
      {state.nextCursor !== null ? (
        <div className="flex justify-center py-4">
          <Button
            type="button"
            variant="ghost"
            data-testid="activity-load-older"
            onClick={state.onLoadOlder}
            loading={state.loadingMore}
          >
            Load older
          </Button>
        </div>
      ) : null}
    </div>
  );
}
