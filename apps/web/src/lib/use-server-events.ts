'use client';

// The one EventSource the whole authenticated shell shares (05-12-PLAN.md Task 1/§6 Real-Time
// Behavior). `apps/web/src/app/(shell)/layout.tsx` is the only caller -- exactly one instance for
// the whole shell, provided to every child screen through a context, never one per screen.
//
// Every received frame is routed through `server-events.ts`'s `parseServerEventFrame`
// (T-5-50) before any listener ever sees it -- a rejected frame is silently dropped, never
// thrown, so one bad message can never break the stream for every other subscriber.
//
// No custom reconnect loop for an already-open-then-dropped connection: the browser's own
// `EventSource` reconnection honours the server's `retry: 5000` field
// (apps/control-plane/src/routes/events.ts) automatically. The one exception is the pre-open
// `503 SSE_LIMIT_REACHED` case (D-07/T-5-54): that response never reaches the `retry:` field (the
// server answers plain JSON before ever hijacking the connection), so the browser's own retry
// falls back to its UA-default interval with no backoff at all -- this file adds a bounded,
// explicit backoff only for that one repeated-pre-open-failure case, closing the dead connection
// and scheduling a fresh one itself rather than hammering an already-at-capacity server.
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
}

/** The single EventSource hook for the authenticated shell. */
export function useServerEvents(): UseServerEventsResult {
  const [connected, setConnected] = useState(false);
  const resyncCallbacksRef = useRef<Set<() => void>>(new Set());
  const listenersRef = useRef<Set<(event: ServerEvent) => void>>(new Set());
  const sourceRef = useRef<EventSource | null>(null);
  const closedByCallerRef = useRef(false);

  useEffect(() => {
    closedByCallerRef.current = false;
    let hasEverOpened = false;
    let preOpenFailures = 0;
    let backoffTimer: ReturnType<typeof setTimeout> | undefined;

    function teardown(source: EventSource): void {
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    }

    function connect(): void {
      if (closedByCallerRef.current) return;

      const source = new EventSource('/api/events');
      sourceRef.current = source;

      source.addEventListener('open', () => {
        hasEverOpened = true;
        preOpenFailures = 0;
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

        // T-5-54: only the never-successfully-opened case gets an explicit backoff here -- an
        // already-open connection that drops is left entirely to the browser's own native
        // reconnection (it already honours the server's `retry: 5000`).
        if (hasEverOpened || closedByCallerRef.current) return;

        preOpenFailures += 1;
        if (preOpenFailures < PRE_OPEN_FAILURE_THRESHOLD) return;

        teardown(source);
        const delay = Math.min(
          PRE_OPEN_BACKOFF_BASE_MS * 2 ** (preOpenFailures - PRE_OPEN_FAILURE_THRESHOLD),
          PRE_OPEN_BACKOFF_MAX_MS,
        );
        backoffTimer = setTimeout(connect, delay);
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
    setConnected(false);
  }, []);

  return { connected, subscribe, registerResync, close };
}
