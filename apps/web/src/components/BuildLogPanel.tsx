'use client';

// 13-14: a deployment's build log in the inspector. The deployment is checked against the service
// first (a deployment outside this service, or gone, is a calm not-found state). Then the panel
// subscribes to its `deployment.log_chunk` events and reads `GET /logs` from the start; both feed
// foldBuildLog (13-04), which orders them, drops replays and asks for any missing range. A stream
// reconnect refetches from the cursor.
//
// Bounded (H1): chunks fold into a ref and the view re-renders at most once per flush window,
// showing only the last MAX_RENDERED_BUILD_LINES lines with a notice. Everything (log and
// deployment subscriptions, resync hook, flush timer, late fetches) is released on unmount or
// when the selection changes. The body is keyed by deployment id, so the previous deployment's
// text is never shown for the next one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, SkeletonRow } from '@noodara/ui';
import {
  buildLogText,
  createBuildLogState,
  foldBuildLog,
  type BuildLogResyncCursor,
  type BuildLogState,
} from '../lib/build-log';
import { getDeploymentLogs, getServiceDeployment, type DeploymentView } from '../lib/deploy-api';
import { deploymentWriteFromEvent } from '../lib/deploy-store';
import { requireSession } from '../lib/require-session';
import { deploymentStatusPresentation, shortSha } from '../lib/service-status-copy';
import type { DeployStreamApi, UseServerEventsResult } from '../lib/use-server-events';
import { LogView, tailLines, type TailedLines } from './LogView';
import { TonePill } from './ServiceToolbar';

export const MAX_RENDERED_BUILD_LINES = 2_000;
export const BUILD_LOG_FLUSH_MS = 50;
export const BUILD_LOG_NOT_FOUND_COPY =
  'This deployment no longer exists or does not belong to this service.';
export const BUILD_LOG_LOAD_FAILED_COPY =
  "Couldn't load the build log. Check your connection and try again.";
export const BUILD_LOG_STALLED_COPY = 'Part of the build log could not be loaded.';
export const BUILD_LOG_EMPTY_COPY = 'No build output yet.';

export type BuildLogStream = Pick<DeployStreamApi, 'subscribeDeploymentLog' | 'subscribeDeploy'> &
  Pick<UseServerEventsResult, 'registerResync'>;

export interface BuildLogPanelProps {
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly stream: BuildLogStream;
}

export function BuildLogPanel(props: BuildLogPanelProps) {
  return <BuildLogBody key={`${props.serviceId}/${props.deploymentId}`} {...props} />;
}

type LoadState = 'loading' | 'ready' | 'not-found' | 'error';

const START: BuildLogResyncCursor = { phase: 'prepare', since: 0 };
const EMPTY_VIEW: TailedLines = { lines: [], hidden: false };

function stamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function cursorOf(state: BuildLogState): BuildLogResyncCursor {
  return state.resync ?? { phase: state.cursor.phase, since: state.cursor.seq };
}

function BuildLogBody({ serviceId, deploymentId, stream }: BuildLogPanelProps) {
  const { subscribeDeploymentLog, subscribeDeploy, registerResync } = stream;
  const [load, setLoad] = useState<LoadState>('loading');
  const [deployment, setDeployment] = useState<DeploymentView | null>(null);
  const [view, setView] = useState<TailedLines>(EMPTY_VIEW);
  const [stalled, setStalled] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const retry = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    let started = false;
    let fetching = false;
    let state = createBuildLogState(deploymentId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeLog: (() => void) | null = null;

    const flush = (): void => {
      timer = null;
      if (disposed) return;
      setView(tailLines(buildLogText(state), MAX_RENDERED_BUILD_LINES));
      setStalled(state.stalled);
    };
    const schedule = (): void => {
      if (timer === null && !disposed) timer = setTimeout(flush, BUILD_LOG_FLUSH_MS);
    };

    const fetchFrom = (after: BuildLogResyncCursor): void => {
      if (fetching || disposed) return;
      fetching = true;
      void getDeploymentLogs(deploymentId, {
        phase: after.phase,
        since: after.since,
      }).then((result) => {
        fetching = false;
        if (disposed) return;
        if (!result.ok) {
          if (result.unauthorized) {
            void requireSession();
          } else if (result.code === 'NOT_FOUND' || result.code === 'VALIDATION_FAILED') {
            stop();
            setLoad('not-found');
          } else {
            setFetchFailed(true);
            setLoad((current) => (current === 'loading' ? 'ready' : current));
          }
          return;
        }
        setFetchFailed(false);
        state = foldBuildLog(state, {
          kind: 'page',
          after,
          items: result.data.items,
          hasMore: result.data.hasMore,
        });
        setLoad('ready');
        schedule();
        if (state.resync !== null) fetchFrom(state.resync);
      });
    };

    const stop = (): void => {
      unsubscribeLog?.();
      unsubscribeLog = null;
    };

    retry.current = () => {
      if (started) fetchFrom(cursorOf(state));
    };

    void getServiceDeployment(serviceId, deploymentId).then((result) => {
      if (disposed) return;
      if (!result.ok) {
        if (result.unauthorized) void requireSession();
        setLoad(
          result.code === 'NOT_FOUND' || result.code === 'VALIDATION_FAILED'
            ? 'not-found'
            : 'error',
        );
        return;
      }
      setDeployment(result.data);
      started = true;
      // Subscribe before reading the snapshot, so nothing written in between is missed.
      unsubscribeLog = subscribeDeploymentLog(deploymentId, (chunk) => {
        state = foldBuildLog(state, { kind: 'event', event: chunk });
        schedule();
        if (state.resync !== null) fetchFrom(state.resync);
      });
      fetchFrom(START);
    });

    const unregisterResync = registerResync(() => {
      if (started) fetchFrom(cursorOf(state));
    });

    return () => {
      disposed = true;
      stop();
      unregisterResync();
      retry.current = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  }, [serviceId, deploymentId, subscribeDeploymentLog, registerResync]);

  useEffect(
    () =>
      subscribeDeploy((event) => {
        const write = deploymentWriteFromEvent<DeploymentView>(event, serviceId);
        if (write?.kind !== 'patch' || write.id !== deploymentId) return;
        setDeployment((held) =>
          held === null || stamp(write.updatedAt) < stamp(held.updatedAt)
            ? held
            : { ...held, ...write.patch, updatedAt: write.updatedAt },
        );
      }),
    [subscribeDeploy, serviceId, deploymentId],
  );

  const onRetry = useCallback(() => {
    retry.current?.();
  }, []);

  if (load === 'not-found') {
    return (
      <p data-testid="build-log-not-found" className="px-4 py-3 text-callout text-ink-secondary">
        {BUILD_LOG_NOT_FOUND_COPY}
      </p>
    );
  }
  if (load === 'error') {
    return (
      <p
        data-testid="build-log-error"
        role="alert"
        className="px-4 py-3 text-callout text-status-error"
      >
        {BUILD_LOG_LOAD_FAILED_COPY}
      </p>
    );
  }

  const presentation = deployment === null ? null : deploymentStatusPresentation(deployment.status);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="build-log-panel">
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-2">
        {presentation !== null ? (
          <TonePill presentation={presentation} data-testid="build-log-status" />
        ) : null}
        {deployment !== null ? (
          <span
            className="font-mono text-caption text-ink-secondary"
            title={deployment.commitSha ?? undefined}
          >
            {shortSha(deployment.commitSha)}
          </span>
        ) : null}
      </div>
      {fetchFailed ? (
        <div className="flex items-center gap-3 px-4 py-2">
          <p role="alert" className="flex-1 text-caption text-status-error">
            {BUILD_LOG_LOAD_FAILED_COPY}
          </p>
          <Button type="button" variant="secondary" onClick={onRetry} data-testid="build-log-retry">
            Retry
          </Button>
        </div>
      ) : null}
      {stalled ? (
        <p className="px-4 py-2 text-caption text-ink-secondary">{BUILD_LOG_STALLED_COPY}</p>
      ) : null}
      {load === 'loading' ? (
        <div data-testid="build-log-loading">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : (
        <LogView
          label="Build log"
          lines={view.lines}
          emptyText={BUILD_LOG_EMPTY_COPY}
          hiddenNotice={
            view.hidden
              ? `Showing the last ${MAX_RENDERED_BUILD_LINES.toLocaleString('en-US')} lines.`
              : null
          }
        />
      )}
    </div>
  );
}
