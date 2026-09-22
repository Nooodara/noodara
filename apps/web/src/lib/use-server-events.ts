'use client';

// The one EventSource the whole authenticated shell shares (05-12-PLAN.md Task 1/§6 Real-Time
// Behavior). `apps/web/src/app/(shell)/layout.tsx` is the only caller -- exactly one instance for
// the whole shell, provided to every child screen through a context, never one per screen.
//
// Every received frame is routed through `server-events.ts`'s `parseServerEventFrame`
// (T-5-50) before any listener ever sees it -- a rejected frame is silently dropped, never
// thrown, so one bad message can never break the stream for every other subscriber.
//
// Reconnection depends on HOW the browser reports the failure:
//
// - A network-level drop leaves the EventSource in CONNECTING -- the browser is already retrying on
//   its own, honouring the server's `retry: 5000` field (apps/control-plane/src/routes/events.ts).
//   Nothing is done here for an already-open stream.
// - An HTTP-level rejection (any non-200 answer: the control plane's pre-open
//   `503 SSE_LIMIT_REACHED`, D-07/T-5-54, or the proxy's own 503 while the API is unreachable)
//   makes the browser FAIL the connection for good (HTML spec): readyState CLOSED, exactly one
//   `error`, never a native retry. This file then owns the retry, with a bounded exponential
//   backoff so an at-capacity server is never hammered.
// - A stream that never opened and keeps failing at network level gets the same backoff once it
//   has failed repeatedly, instead of the UA-default retry interval with no backoff at all.
import { useCallback, useEffect, useRef, useState } from 'react';
import { KNOWN_EVENT_TYPES, parseServerEventFrame, type ServerEvent } from './server-events';

const PRE_OPEN_FAILURE_THRESHOLD = 3;
const PRE_OPEN_BACKOFF_BASE_MS = 5000;
const PRE_OPEN_BACKOFF_MAX_MS = 60_000;

export interface UseServerEventsResult {
  /** `false` whenever the stream is not currently open -- drives the reconnecting indicator. */
  readonly connected: boolean;
  /** Subscribes `listener` to every well-formed frame this hook decodes. Returns an unsubscribe
   *  function; a screen calls it on unmount. */
  readonly subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** Registers `fn` to run on every `open` (including a reconnect) -- since there is no event
   *  replay, a fresh connection means a full resync fetch, never a partial catch-up. Returns an
   *  unregister function. */
  readonly registerResync: (fn: () => void) => () => void;
  /** Closes the shared stream immediately -- `SignOutButton` calls this before posting
   *  `/api/auth/sign-out`, rather than waiting for the server's own heartbeat to notice. */
  readonly close: () => void;
  /** `true` once `close()` was called on the current stream: a drop this tab asked for. The shell
   *  layout re-runs its session guard only on a drop the server caused -- re-running it here
   *  would race the sign-out's own navigation with the guard's `/login?redirect=...` redirect. */
  readonly closedByCaller: boolean;
}

/** The single EventSource hook for the authenticated shell. */
export function useServerEvents(): UseServerEventsResult {
  const [connected, setConnected] = useState(false);
  const [closedByCaller, setClosedByCaller] = useState(false);
  const resyncCallbacksRef = useRef<Set<() => void>>(new Set());
  const listenersRef = useRef<Set<(event: ServerEvent) => void>>(new Set());
  const sourceRef = useRef<EventSource | null>(null);
  const closedByCallerRef = useRef(false);

  useEffect(() => {
    closedByCallerRef.current = false;
    setClosedByCaller(false);
    let hasEverOpened = false;
    let preOpenFailures = 0;
    let rejections = 0;
    let backoffTimer: ReturnType<typeof setTimeout> | undefined;

    function teardown(source: EventSource): void {
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    }

    /** Replaces `source` with a fresh connection after `base * 2^step`, capped. */
    function scheduleReconnect(source: EventSource, step: number): void {
      teardown(source);
      const delay = Math.min(PRE_OPEN_BACKOFF_BASE_MS * 2 ** step, PRE_OPEN_BACKOFF_MAX_MS);
      if (backoffTimer !== undefined) {
        clearTimeout(backoffTimer);
      }
      backoffTimer = setTimeout(connect, delay);
    }

    function connect(): void {
      if (closedByCallerRef.current) return;

      const source = new EventSource('/api/events');
      sourceRef.current = source;

      source.addEventListener('open', () => {
        hasEverOpened = true;
        preOpenFailures = 0;
        rejections = 0;
        setConnected(true);
        for (const resync of resyncCallbacksRef.current) {
          try {
            resync();
          } catch {
            // One screen's own resync failure must never stop every other screen's resync.
          }
        }
      });

      source.addEventListener('error', () => {
        setConnected(false);
        if (closedByCallerRef.current) return;

        // The browser gave up (HTTP-level rejection): no further `error` will ever come from this
        // source, so waiting for a threshold here would wait forever.
        if (source.readyState === EventSource.CLOSED) {
          rejections += 1;
          scheduleReconnect(source, rejections - 1);
          return;
        }

        // Still CONNECTING: the browser is retrying natively. Only the never-successfully-opened
        // case gets an explicit backoff -- an already-open connection that drops is left entirely
        // to the browser's own reconnection.
        if (hasEverOpened) return;

        preOpenFailures += 1;
        if (preOpenFailures < PRE_OPEN_FAILURE_THRESHOLD) return;
        scheduleReconnect(source, preOpenFailures - PRE_OPEN_FAILURE_THRESHOLD);
      });

      for (const type of KNOWN_EVENT_TYPES) {
        source.addEventListener(type, (rawEvent) => {
          const messageEvent = rawEvent as MessageEvent<string>;
          const result = parseServerEventFrame(type, messageEvent.data);
          if (!result.ok) return;
          for (const listener of listenersRef.current) {
            listener(result.event);
          }
        });
      }
    }

    connect();

    return () => {
      closedByCallerRef.current = true;
      if (backoffTimer !== undefined) {
        clearTimeout(backoffTimer);
      }
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, []);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const registerResync = useCallback((fn: () => void) => {
    resyncCallbacksRef.current.add(fn);
    return () => {
      resyncCallbacksRef.current.delete(fn);
    };
  }, []);

  const close = useCallback(() => {
    closedByCallerRef.current = true;
    sourceRef.current?.close();
    sourceRef.current = null;
    setClosedByCaller(true);
    setConnected(false);
  }, []);

  return { connected, subscribe, registerResync, close, closedByCaller };
}
