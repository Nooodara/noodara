'use client';

// The activity log screen (ACT-02, 05-UI-SPEC.md §2.6). Fetches page 1 of `GET /api/activity` on
// mount, appends further pages via the opaque `nextCursor` on "Load older" (D-13), and refetches
// page 1 -- merging, never resetting scroll or already-loaded older pages -- on tab focus regain
// and on any `server.updated`/`server.deleted` SSE event, both coalesced through one debounce so
// an event burst never becomes a request storm (05-CONTEXT.md's discretion note, D-14). Also
// fetches the servers list once for `lookupServer`'s live-link resolution -- a row's server name
// only links when that server still exists.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Toolbar } from '../../../components/Toolbar';
import { ActivityList, type ActivityListState } from '../../../components/ActivityList';
import { apiGet, type ApiErrorCode, type ServerView } from '../../../lib/api-client';
import { copyForErrorCode } from '../../../lib/error-copy';
import { requireSession } from '../../../lib/require-session';
import { mergePage } from '../../../lib/activity-groups';
import type { ActivityItem, ServerLookup } from '../../../lib/activity-copy';
import { useShellContext } from '../../../lib/shell-context';

const PAGE_LIMIT = 50;
// Coalesces a burst of `server.updated`/`server.deleted` events (e.g. discovery finishing on
// several checks in quick succession) into a single refetch, rather than one request per event.
const REFRESH_DEBOUNCE_MS = 500;

interface ActivityResponse {
  readonly items: readonly ActivityItem[];
  readonly nextCursor: string | null;
}

interface ListServersResponse {
  readonly items: readonly ServerView[];
}

// Same NETWORK_ERROR carve-out apps/web/src/app/(shell)/servers/page.tsx already established --
// api-client.ts already crafts a safe, non-raw message for a rejected fetch, so it is the one
// code rendered straight from `ApiFailure.message` rather than through `copyForErrorCode`.
function genericFailureMessage(code: ApiErrorCode, message: string): string {
  if (code === 'NETWORK_ERROR') return message;
  return copyForErrorCode(code);
}

export default function ActivityPage() {
  const { subscribe, registerResync } = useShellContext();
  const [state, setState] = useState<ActivityListState>({ kind: 'loading' });
  const [servers, setServers] = useState<readonly ServerView[]>([]);
  // Read inside callbacks that must always see the current value, not the one from the render
  // that created them (registerResync/subscribe fire long after their own registration render) --
  // the same idiom apps/web/src/app/(shell)/servers/page.tsx already established.
  const stateRef = useRef(state);
  stateRef.current = state;
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Best-effort: a servers-list fetch failure degrades every row to its metadata-name/id-prefix
  // fallback (activity-copy.ts's own resolution rule) rather than failing the whole screen.
  useEffect(() => {
    void apiGet<ListServersResponse>('/api/servers').then((result) => {
      if (result.ok) {
        setServers(result.data.items);
      }
    });
  }, []);

  const lookupServer: ServerLookup = useCallback(
    (entityId) => {
      const match = servers.find((server) => server.id === entityId);
      return match === undefined ? null : { name: match.name, href: `/servers/${match.id}` };
    },
    [servers],
  );

  // loadOlder reads the current cursor via stateRef (never a stale closure) so it can be a stable,
  // empty-deps callback -- declared before fetchPage1 below so fetchPage1's own closure captures
  // an already-initialized binding rather than relying on hoisting order.
  const loadOlder = useCallback((): void => {
    const current = stateRef.current;
    if (current.kind !== 'ready' || current.nextCursor === null || current.loadingMore) return;
    const cursor = current.nextCursor;

    setState((prev) => (prev.kind === 'ready' ? { ...prev, loadingMore: true } : prev));

    // The cursor is opaque -- passed back exactly as the server returned it, URL-encoded, never
    // parsed or reconstructed client-side (05-15-PLAN.md security instructions).
    void apiGet<ActivityResponse>(`/api/activity?limit=${String(PAGE_LIMIT)}&cursor=${encodeURIComponent(cursor)}`).then(
      (result) => {
        if (!result.ok) {
          if (result.unauthorized) {
            void requireSession();
            return;
          }
          // A "Load older" failure keeps every already-loaded row on screen and simply re-enables
          // the button -- this plan's scope has no dedicated inline error affordance beyond the
          // initial-load banner.
          setState((prev) => (prev.kind === 'ready' ? { ...prev, loadingMore: false } : prev));
          return;
        }

        setState((prev) => {
          if (prev.kind !== 'ready') return prev;
          return {
            kind: 'ready',
            items: mergePage(prev.items, result.data.items, 'append'),
            nextCursor: result.data.nextCursor,
            loadingMore: false,
            onLoadOlder: loadOlder,
          };
        });
      },
    );
    // Self-referential (reads only stateRef.current, never a reactive closure value) -- an
    // empty dependency array is correct here, matching fetchPage1 below.
  }, []);

  // fetchPage1 is self-referential (its own `error` branch stores itself as `onRetry`) and reads
  // no reactive state directly (everything it needs comes from `setState`'s own updater, `stateRef`
  // or the already-defined `loadOlder` above), so an empty dependency array is correct, not a
  // staleness bug -- matching servers/page.tsx's own fetchServers.
  const fetchPage1 = useCallback((): void => {
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));

    void apiGet<ActivityResponse>(`/api/activity?limit=${String(PAGE_LIMIT)}`).then((result) => {
      if (!result.ok) {
        if (result.unauthorized) {
          void requireSession();
          return;
        }
        setState({
          kind: 'error',
          error: { message: `Couldn't load activity. ${genericFailureMessage(result.code, result.message)}`, code: result.code },
          onRetry: fetchPage1,
        });
        return;
      }

      setState((prev) => {
        if (prev.kind === 'ready') {
          // A page-1 refresh merges in new items without moving `nextCursor` -- that cursor marks
          // the boundary of whatever older page the user already loaded, and this fresh top-50
          // fetch says nothing about that boundary (05-UI-SPEC.md §2.6 Refresh).
          return {
            kind: 'ready',
            items: mergePage(prev.items, result.data.items, 'refresh'),
            nextCursor: prev.nextCursor,
            loadingMore: prev.loadingMore,
            onLoadOlder: prev.onLoadOlder,
          };
        }
        return {
          kind: 'ready',
          items: result.data.items,
          nextCursor: result.data.nextCursor,
          loadingMore: false,
          onLoadOlder: loadOlder,
        };
      });
    });
    // Self-referential (see comment above); loadOlder is a stable, empty-deps identity so
    // omitting it from this array changes nothing at runtime.
  }, []);

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      fetchPage1();
    }, REFRESH_DEBOUNCE_MS);
  }, [fetchPage1]);

  useEffect(() => {
    fetchPage1();
  }, [fetchPage1]);

  // Every stream reconnect resyncs from a fresh page 1, exactly like servers/page.tsx's own
  // registerResync -- there is no event replay (05-UI-SPEC.md §6 "Resync on reconnect").
  useEffect(() => registerResync(fetchPage1), [registerResync, fetchPage1]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'server.updated' || event.type === 'server.deleted') {
          scheduleRefresh();
        }
      }),
    [subscribe, scheduleRefresh],
  );

  useEffect(() => {
    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        scheduleRefresh();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [scheduleRefresh]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  return (
    <>
      <Toolbar title="Activity" />
      <div className="mx-auto max-w-[1120px] p-8">
        <ActivityList state={state} now={new Date()} lookupServer={lookupServer} />
      </div>
    </>
  );
}
