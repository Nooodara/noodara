'use client';

// 13-14: a service's runtime (container) logs in the inspector, loaded on demand. Opening the
// panel reads one tail (`GET .../logs?tail=`); Follow opens the bounded NDJSON stream from
// runtime-log-stream.ts (13-05) with the same tail.
//
// Follow lifecycle (H2): one AbortController per follow. Turning Follow off, changing the tail
// (which restarts the follow), and unmount (navigation, inspector close) all abort it, which ends
// the request and so the server-side `docker logs`. When the stream ends on its own (server limit,
// container exited, concurrent-follow limit, network), Follow returns to off and one notice says
// why; the notice is replaced, never appended. Failures show fixed copy, never the server's text.
//
// Bounded (H1): lines live in the reader's ring (at most 5,000); the view re-renders at most once
// per flush window and shows the last MAX_RENDERED_RUNTIME_LINES with a notice.
import { useEffect, useRef, useState } from 'react';
import { Button, SegmentedControl, SkeletonRow } from '@noodara/ui';
import type { DeployApiErrorCode } from '../lib/api-client';
import { getRuntimeLogs } from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';
import {
  followRuntimeLogs,
  type RuntimeLogFollowResult,
  type StreamedLogLine,
} from '../lib/runtime-log-stream';
import { LogView, type LogViewLine } from './LogView';

export const MAX_RENDERED_RUNTIME_LINES = 2_000;
export const RUNTIME_LOG_FLUSH_MS = 50;
export const RUNTIME_LOG_TAILS = ['100', '500', '1000'] as const;
type TailOption = (typeof RUNTIME_LOG_TAILS)[number];

export const RUNTIME_LOG_NOT_FOUND_COPY = 'This service no longer exists.';
export const NO_CONTAINER_COPY = 'This service has no container yet. Deploy it to see its logs.';
export const FOLLOW_LIMIT_COPY =
  'Too many log streams are open. Close another one, then turn Follow on again.';
export const FOLLOW_OFF_COPY = 'Follow stopped.';
const RUNTIME_LOGS_FAILED_COPY = "Couldn't read the container logs. Try again.";
const RUNTIME_LOGS_TIMEOUT_COPY = 'The server took too long to return the logs. Try again.';
const SERVER_UNREACHABLE_COPY =
  "Noodara couldn't reach the server. Check that it is online and try again.";
const NETWORK_COPY =
  'Follow stopped because the connection dropped. Check your connection and turn Follow on again.';

// 13-20: a service with no container yet is a state, not a failure -- its notice reads neutral.
function isFailureNotice(code: DeployApiErrorCode): boolean {
  return code !== 'CONTAINER_NOT_FOUND' && code !== 'SERVICE_NOT_DEPLOYED';
}

function failureCopy(code: DeployApiErrorCode): string {
  switch (code) {
    case 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED':
      return FOLLOW_LIMIT_COPY;
    case 'CONTAINER_NOT_FOUND':
    case 'SERVICE_NOT_DEPLOYED':
      return NO_CONTAINER_COPY;
    case 'RUNTIME_LOGS_TIMEOUT':
      return RUNTIME_LOGS_TIMEOUT_COPY;
    case 'SERVER_UNREACHABLE':
      return SERVER_UNREACHABLE_COPY;
    case 'NETWORK_ERROR':
      return NETWORK_COPY;
    default:
      return RUNTIME_LOGS_FAILED_COPY;
  }
}

/** Why a follow ended, as one sentence. Null for an abort the user asked for. */
export function followEndCopy(result: RuntimeLogFollowResult): string | null {
  if (!result.ok) return failureCopy(result.code);
  if (result.reason === 'aborted') return null;
  if (result.reason === 'max_duration' || result.serverReason === 'max_duration')
    return 'Follow stopped after 10 minutes, the longest a follow can run. Turn Follow on to continue.';
  switch (result.serverReason) {
    case 'container_exited':
      return 'Follow stopped because the container exited.';
    case 'output_limit':
      return 'Follow stopped after reaching the output limit. Turn Follow on to continue.';
    case 'connection_lost':
      return 'Follow stopped because the connection to the server was lost. Turn Follow on to try again.';
    case 'shutdown':
      return 'Follow stopped because Noodara is restarting. Turn Follow on to try again.';
    default:
      return FOLLOW_OFF_COPY;
  }
}

interface RuntimeView {
  readonly lines: readonly LogViewLine[];
  readonly hidden: boolean;
}

function toView(
  lines: readonly StreamedLogLine[],
  dropped: number,
  truncated: boolean,
): RuntimeView {
  const start = Math.max(0, lines.length - MAX_RENDERED_RUNTIME_LINES);
  return {
    lines: lines.slice(start).map((line, index) => ({
      key: String(dropped + start + index),
      text: line.text,
      timestamp: line.timestamp,
      stream: line.stream,
    })),
    hidden: truncated || dropped > 0 || start > 0,
  };
}

export interface RuntimeLogPanelProps {
  readonly projectId: string;
  readonly serviceId: string;
}

type LoadState = 'loading' | 'ready' | 'not-found';

export function RuntimeLogPanel({ projectId, serviceId }: RuntimeLogPanelProps) {
  const [tail, setTail] = useState<TailOption>('100');
  const [following, setFollowing] = useState(false);
  const [load, setLoad] = useState<LoadState>('loading');
  const [view, setView] = useState<RuntimeView>({ lines: [], hidden: false });
  const [notice, setNotice] = useState<{
    readonly text: string;
    readonly error: boolean;
  } | null>(null);
  // Read by the tail effect, so a tail change while following restarts the follow instead.
  const followingRef = useRef(false);

  // One tail on demand: on open and whenever the tail changes while not following.
  useEffect(() => {
    if (followingRef.current) return;
    let disposed = false;
    void getRuntimeLogs(projectId, serviceId, { tail: Number(tail) }).then((result) => {
      if (disposed || followingRef.current) return;
      if (result.ok) {
        setView(
          toView(
            result.data.lines.map((line) => ({ ...line, truncated: false })),
            0,
            result.data.truncated,
          ),
        );
        setLoad('ready');
        return;
      }
      if (result.unauthorized) void requireSession();
      if (result.code === 'NOT_FOUND' || result.code === 'VALIDATION_FAILED') {
        setLoad('not-found');
        return;
      }
      setLoad('ready');
      setNotice({ text: failureCopy(result.code), error: isFailureNotice(result.code) });
    });
    return () => {
      disposed = true;
    };
  }, [projectId, serviceId, tail]);

  // The follow: aborted by its own cleanup (off, tail change, unmount).
  useEffect(() => {
    if (!following) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const follow = followRuntimeLogs({
      projectId,
      serviceId,
      tail: Number(tail),
      signal: controller.signal,
      onLines: () => {
        if (timer === null && !controller.signal.aborted)
          timer = setTimeout(flush, RUNTIME_LOG_FLUSH_MS);
      },
    });
    function flush(): void {
      timer = null;
      if (controller.signal.aborted) return;
      const snapshot = follow.snapshot();
      setView(toView(snapshot.lines, snapshot.droppedLines, false));
      setLoad('ready');
    }
    void follow.done.then((result: RuntimeLogFollowResult) => {
      if (controller.signal.aborted) return;
      if (timer !== null) clearTimeout(timer);
      flush();
      if (!result.ok && result.unauthorized) void requireSession();
      const text = followEndCopy(result);
      setNotice(text === null ? null : { text, error: !result.ok && isFailureNotice(result.code) });
      followingRef.current = false;
      setFollowing(false);
    });
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  }, [following, projectId, serviceId, tail]);

  function toggleFollow(): void {
    if (following) {
      followingRef.current = false;
      setFollowing(false);
      setNotice({ text: FOLLOW_OFF_COPY, error: false });
      return;
    }
    setNotice(null);
    followingRef.current = true;
    setFollowing(true);
  }

  if (load === 'not-found') {
    return (
      <p data-testid="runtime-log-not-found" className="px-4 py-3 text-callout text-ink-secondary">
        {RUNTIME_LOG_NOT_FOUND_COPY}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="runtime-log-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-2">
        <span className="text-caption text-ink-secondary">Last lines</span>
        <SegmentedControl<TailOption>
          value={tail}
          onValueChange={setTail}
          data-testid="runtime-log-tail"
          options={[
            { value: '100', label: '100' },
            { value: '500', label: '500' },
            { value: '1000', label: '1,000' },
          ]}
        />
        <span className="ml-auto">
          <Button
            type="button"
            variant={following ? 'primary' : 'secondary'}
            aria-pressed={following}
            data-testid="runtime-log-follow"
            onClick={toggleFollow}
          >
            Follow
          </Button>
        </span>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={
          notice === null
            ? 'sr-only'
            : notice.error
              ? 'px-4 py-2 text-caption text-status-error-text'
              : 'px-4 py-2 text-caption text-ink-secondary'
        }
      >
        {notice !== null ? <span data-testid="runtime-log-notice">{notice.text}</span> : null}
      </p>
      {load === 'loading' ? (
        <div data-testid="runtime-log-loading">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : (
        <LogView
          label="Runtime logs"
          lines={view.lines}
          emptyText="No log output."
          hiddenNotice={view.hidden ? `Showing the last ${String(view.lines.length)} lines.` : null}
        />
      )}
    </div>
  );
}
