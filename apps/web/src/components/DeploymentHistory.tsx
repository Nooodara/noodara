'use client';

// 13-12: a service's deployment history. `useDeploymentHistory` owns the rows; `DeploymentHistory`
// renders them. Rows are merged by id across the first page, older cursor pages and
// `deployment.updated` events, so a row never shows twice and never disappears when a new
// deployment pushes it off the first page (that is why this keeps its own merge instead of
// useSyncedCollection, which replaces the list with each snapshot). Events go through
// deploymentWriteFromEvent (13-08): a patch for a row not shown yet refetches the first page.
// A cursor the server rejects (invalid or expired) resets the history to the first page.
// Commit SHA and trigger come from the server and are rendered as plain React text, never markup.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, InsetGroup, RelativeTime, SkeletonRow } from '@noodara/ui';
import { listDeployments, type DeploymentView } from '../lib/deploy-api';
import { deploymentWriteFromEvent } from '../lib/deploy-store';
import { requireSession } from '../lib/require-session';
import { deploymentStatusPresentation, formatDuration, shortSha, triggerWord } from '../lib/service-status-copy';
import type { SyncStream } from '../lib/use-server-events';
import { TonePill } from './ServiceToolbar';

export const DEPLOYMENT_PAGE_SIZE = 20;
export const HISTORY_EMPTY_COPY = 'No deployments yet. Deploy the service to see its history here.';
export const HISTORY_LOAD_FAILED_COPY = "Couldn't load the deployment history. Check your connection and try again.";
export const HISTORY_MORE_FAILED_COPY = "Couldn't load older deployments. Try again.";

function stamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newestFirst(a: DeploymentView, b: DeploymentView): number {
  const byCreated = stamp(b.createdAt) - stamp(a.createdAt);
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Upserts `incoming` into `current` by id; a row keeps its newer version (incoming wins a tie).
 *  The result is newest first and holds each id once. */
export function mergeDeployments(
  current: readonly DeploymentView[],
  incoming: readonly DeploymentView[],
): readonly DeploymentView[] {
  const byId = new Map<string, DeploymentView>();
  for (const row of current) byId.set(row.id, row);
  for (const row of incoming) {
    const held = byId.get(row.id);
    if (held === undefined || stamp(row.updatedAt) >= stamp(held.updatedAt)) byId.set(row.id, row);
  }
  return [...byId.values()].sort(newestFirst);
}

export interface DeploymentHistoryState {
  readonly rows: readonly DeploymentView[];
  readonly loaded: boolean;
  readonly loadFailed: boolean;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly loadMore: () => void;
  /** Shows a deployment this view just started or changed, before its event arrives. */
  readonly upsert: (deployment: DeploymentView) => void;
  readonly refresh: () => void;
}

export function useDeploymentHistory(
  serviceId: string,
  stream: SyncStream,
  pageSize: number = DEPLOYMENT_PAGE_SIZE,
): DeploymentHistoryState {
  const { subscribeDeploy, registerResync } = stream;
  const [rows, setRows] = useState<readonly DeploymentView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  const rowsRef = useRef<readonly DeploymentView[]>([]);
  const cursorRef = useRef<string | null>(null);
  // Bumped on every reset: a response from before it is dropped.
  const generation = useRef(0);
  const olderLoaded = useRef(false);
  const firstInFlight = useRef(false);
  const firstAgain = useRef(false);
  const moreInFlight = useRef(false);
  const loadedRef = useRef(false);

  const commitRows = useCallback((next: readonly DeploymentView[]): void => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const commitCursor = useCallback((next: string | null): void => {
    cursorRef.current = next;
    setNextCursor(next);
  }, []);

  const loadFirst = useCallback((): void => {
    if (firstInFlight.current) {
      firstAgain.current = true;
      return;
    }
    firstInFlight.current = true;
    const gen = generation.current;
    void listDeployments(serviceId, { limit: pageSize }).then((result) => {
      if (gen !== generation.current) return;
      firstInFlight.current = false;
      if (result.ok) {
        commitRows(mergeDeployments(rowsRef.current, result.data.items));
        if (!olderLoaded.current) commitCursor(result.data.nextCursor);
        loadedRef.current = true;
        setLoaded(true);
        setLoadFailed(false);
      } else if (result.unauthorized) {
        void requireSession();
      } else if (!loadedRef.current) {
        setLoadFailed(true);
      }
      if (firstAgain.current) {
        firstAgain.current = false;
        loadFirst();
      }
    });
  }, [serviceId, pageSize, commitRows, commitCursor]);

  const reset = useCallback((): void => {
    generation.current += 1;
    firstInFlight.current = false;
    firstAgain.current = false;
    moreInFlight.current = false;
    olderLoaded.current = false;
    loadedRef.current = false;
    commitRows([]);
    commitCursor(null);
    setLoaded(false);
    setLoadFailed(false);
    setLoadingMore(false);
    setMoreFailed(false);
  }, [commitRows, commitCursor]);

  const loadMore = useCallback((): void => {
    const cursor = cursorRef.current;
    if (moreInFlight.current || cursor === null) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    setMoreFailed(false);
    const gen = generation.current;
    void listDeployments(serviceId, { limit: pageSize, cursor }).then((result) => {
      if (gen !== generation.current) return;
      moreInFlight.current = false;
      setLoadingMore(false);
      if (result.ok) {
        olderLoaded.current = true;
        commitRows(mergeDeployments(rowsRef.current, result.data.items));
        commitCursor(result.data.nextCursor);
        return;
      }
      if (result.unauthorized) {
        void requireSession();
        return;
      }
      if (result.code === 'VALIDATION_FAILED') {
        // The cursor is invalid or expired: start over from the first page.
        reset();
        loadFirst();
        return;
      }
      setMoreFailed(true);
    });
  }, [serviceId, pageSize, commitRows, commitCursor, reset, loadFirst]);

  const upsert = useCallback(
    (deployment: DeploymentView): void => {
      if (deployment.serviceId !== serviceId) return;
      commitRows(mergeDeployments(rowsRef.current, [deployment]));
    },
    [serviceId, commitRows],
  );

  useEffect(() => {
    reset();
    loadFirst();
  }, [reset, loadFirst]);

  useEffect(
    () =>
      subscribeDeploy((event) => {
        const write = deploymentWriteFromEvent<DeploymentView>(event, serviceId);
        if (write === null) return;
        if (write.kind !== 'patch') return;
        const held = rowsRef.current.find((row) => row.id === write.id);
        if (held === undefined) {
          loadFirst();
          return;
        }
        if (stamp(write.updatedAt) < stamp(held.updatedAt)) return;
        commitRows(
          rowsRef.current.map((row) => (row.id === write.id ? { ...row, ...write.patch, updatedAt: write.updatedAt } : row)),
        );
      }),
    [subscribeDeploy, serviceId, loadFirst, commitRows],
  );

  useEffect(() => registerResync(loadFirst), [registerResync, loadFirst]);

  return {
    rows,
    loaded,
    loadFailed,
    hasMore: nextCursor !== null,
    loadingMore,
    moreFailed,
    loadMore,
    upsert,
    refresh: loadFirst,
  };
}

export interface DeploymentHistoryProps {
  readonly history: DeploymentHistoryState;
  readonly now: Date;
}

const SKELETON_ROWS = 3;

export function DeploymentHistory({ history, now }: DeploymentHistoryProps) {
  const { rows, loaded, loadFailed, hasMore, loadingMore, moreFailed, loadMore } = history;

  let body;
  if (!loaded && loadFailed) {
    body = (
      <p data-testid="deployment-history-error" className="px-4 py-3 text-callout text-status-error">
        {HISTORY_LOAD_FAILED_COPY}
      </p>
    );
  } else if (!loaded) {
    body = Array.from({ length: SKELETON_ROWS }, (_, index) => <SkeletonRow key={index} />);
  } else if (rows.length === 0) {
    body = (
      <p data-testid="deployment-history-empty" className="px-4 py-3 text-callout text-ink-secondary">
        {HISTORY_EMPTY_COPY}
      </p>
    );
  } else {
    body = rows.map((row) => {
      const status = deploymentStatusPresentation(row.status);
      return (
        <div
          key={row.id}
          data-testid={`deployment-row-${row.id}`}
          data-status={row.status}
          className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-callout"
        >
          <TonePill presentation={status} data-testid="deployment-status" />
          <span data-testid="deployment-trigger" className="text-ink">
            {triggerWord(row.trigger)}
          </span>
          <span data-testid="deployment-sha" className="font-mono text-ink-secondary" title={row.commitSha ?? undefined}>
            {shortSha(row.commitSha)}
          </span>
          <span data-testid="deployment-duration" className="font-mono tabular-nums text-ink-secondary">
            {formatDuration(row.durationMs)}
          </span>
          <span className="ml-auto text-caption text-ink-secondary">
            <RelativeTime value={row.createdAt} now={now} data-testid="deployment-time" />
          </span>
        </div>
      );
    });
  }

  return (
    <section aria-labelledby="deployment-history-title" className="flex flex-col gap-2" data-testid="deployment-history">
      <h2 id="deployment-history-title" className="px-4 text-title font-semibold text-ink">
        Deployments
      </h2>
      <InsetGroup data-testid="deployment-history-list">{body}</InsetGroup>
      {moreFailed ? (
        <p role="alert" className="px-4 text-caption text-status-error">
          {HISTORY_MORE_FAILED_COPY}
        </p>
      ) : null}
      {loaded && hasMore ? (
        <div className="px-4">
          <Button
            type="button"
            variant="secondary"
            data-testid="deployment-history-more"
            disabled={loadingMore}
            loading={loadingMore}
            onClick={loadMore}
          >
            Show older deployments
          </Button>
        </div>
      ) : null}
    </section>
  );
}
