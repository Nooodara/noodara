// The activity log screen's own list body (ACT-02, 05-UI-SPEC.md §2.6) -- renders exactly one of
// the three states (`loading`/`error`/`ready`), day-grouped rows under `--text-label` headers, and
// the D-13 ghost "Load older" button. `apps/web/src/app/(shell)/activity/page.tsx` owns the actual
// `GET /api/activity` fetch, pagination and the shared SSE resync registration -- this component
// only renders whatever state it is handed, mirroring `ServerList.tsx`'s own split.
import { useRef } from 'react';
import { Banner, Button, EmptyState, SkeletonRow } from '@noodara/ui';
import { ActivityRow } from './ActivityRow';
import { groupByDay } from '../lib/activity-groups';
import type { ActivityItem, ActivityLookups, ServerLookup } from '../lib/activity-copy';

const SKELETON_ROW_COUNT = 10;

// UI-07/D-11 (08-UI-SPEC.md §8.3, 08-16-PLAN.md Task 2): this screen's own one authored moment is
// the arrival itself -- no stagger (unlike the servers list's first-load stagger, deliberately
// different per §8.4). Only rows genuinely new since the previous render enter; the initial load
// (no previous render to diff against) never counts as an arrival.
const NO_ENTERING_IDS: ReadonlySet<string> = new Set();

/** A page-1 refresh (WR-B-05, `mergePage`'s `'refresh'` mode) *prepends* genuinely-new items
 *  before whatever was already loaded; "Load older" *appends* them after everything. Diffing by
 *  id alone cannot tell the two apart -- both add ids `previousItems` never had -- so this locates
 *  `previousItems`' own first-known id inside the new `items` array and only treats the ids
 *  strictly before it as arrivals. An append (Load older) never moves that first-known id, so its
 *  new ids sit entirely after it and are correctly excluded. */
function computeEnteringIds(items: readonly ActivityItem[], previousItems: readonly ActivityItem[]): ReadonlySet<string> {
  if (previousItems.length === 0) return NO_ENTERING_IDS;

  const firstKnownItem = previousItems[0];
  if (firstKnownItem === undefined) return NO_ENTERING_IDS;

  const firstKnownIndex = items.findIndex((item) => item.id === firstKnownItem.id);
  if (firstKnownIndex <= 0) return NO_ENTERING_IDS;

  const previousIds = new Set(previousItems.map((item) => item.id));
  const entering = new Set<string>();
  for (const item of items.slice(0, firstKnownIndex)) {
    if (!previousIds.has(item.id)) entering.add(item.id);
  }
  return entering;
}

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
  /** Project and service lookups forwarded to every row (13-09 A5); rows without a hit stay text. */
  readonly lookups?: ActivityLookups;
  /** The viewer's own time zone for day-header grouping (WR-B-06). Optional so tests can inject a
   *  fixed zone deterministically; defaults to the platform's own zone at runtime via
   *  `Intl.DateTimeFormat().resolvedOptions().timeZone` -- the one permitted platform-clock read
   *  in this screen family, kept here in the component layer and out of the pure
   *  `activity-groups.ts` module. */
  readonly timeZone?: string;
}

export function ActivityList({ state, now, lookupServer, lookups, timeZone }: ActivityListProps) {
  // Diffed against the previous *distinct* items array (never re-keyed, never remounted -- the
  // merge-not-reset contract this screen already guarantees); on the very first ready render
  // there is nothing to diff against, so nothing enters (the initial load is not an arrival).
  //
  // 08-19 iteration-15 nightly flake (activity.spec.ts @activity-entry reduced-motion,
  // ActivityList.test.tsx "keeps the entering row entering across an unrelated re-render"): the
  // original version advanced `previousItemsRef` in a deps-less `useEffect` that ran after EVERY
  // commit, not only when `state.items` actually changed. `ActivityPage`'s own `lookupServer`
  // identity (recreated whenever its `/api/servers` fetch resolves) and `now` prop cascade into a
  // re-render of this component that carries the exact same `items` array reference as the
  // arrival render right before it -- but by the time that re-render's own diff ran, the ref had
  // already been advanced to `items` by the *first* render's effect, so `computeEnteringIds` saw
  // `firstKnownIndex === 0` and reported no arrival at all, clearing `data-entering` a render or
  // two after it should still read "true". Recomputing (and advancing the ref) only when
  // `state.items` is a genuinely new reference -- directly during render, the React-sanctioned
  // "adjusting state while rendering" pattern -- makes the entering set stable across any number
  // of re-renders of the same items array, and only ever re-derived when a real fetch lands new
  // data.
  const previousItemsRef = useRef<readonly ActivityItem[] | null>(null);
  const lastSeenItemsRef = useRef<readonly ActivityItem[] | null>(null);
  const enteringIdsRef = useRef<ReadonlySet<string>>(NO_ENTERING_IDS);
  if (state.kind === 'ready' && state.items !== lastSeenItemsRef.current) {
    enteringIdsRef.current = previousItemsRef.current === null ? NO_ENTERING_IDS : computeEnteringIds(state.items, previousItemsRef.current);
    previousItemsRef.current = state.items;
    lastSeenItemsRef.current = state.items;
  }
  const enteringIds = state.kind === 'ready' ? enteringIdsRef.current : NO_ENTERING_IDS;

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
            <ActivityRow
              key={item.id}
              item={item}
              now={now}
              lookupServer={lookupServer}
              {...(lookups === undefined ? {} : { lookups })}
              entering={enteringIds.has(item.id)}
            />
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
