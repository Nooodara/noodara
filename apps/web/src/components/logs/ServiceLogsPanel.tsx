'use client';

// 30-02: the unified logs view of one service (27-04 API). Source chips (build, deploy, runtime,
// activity), time window, level, search and Follow. Every line shows its mono timestamp and its
// source.
//
// Safety (H1): lines are React text nodes only. Nothing parses markup, ANSI or links, so a line
// with `<img onerror>`, an escape sequence or a `javascript:` URL renders inert. The list is
// virtualized (fixed row height), so 10k lines keep the DOM small. The search box is capped at the
// server's max length and control characters are stripped before it is sent.
//
// Follow (A2): one AbortController per follow. Turning Follow off, changing a filter and unmount
// (the view closes) all abort it, which cancels the fetch and its reader; nothing stays open.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { Banner, Button, cn, Input, Notice, SegmentedControl, SkeletonRow, Switch } from '@noodara/ui';
import {
  followServiceLogs,
  getServiceLogs,
  LOG_SEARCH_MAX_LENGTH,
  LOG_SOURCES,
  type LogEntryView,
  type LogFollowResult,
  type LogLevel,
  type LogSource,
  type LogsQuery,
} from '../../lib/api/logs-api';
import { requireSession } from '../../lib/require-session';
import {
  appendLines,
  bufferFromPage,
  cleanSearch,
  EMPTY_BUFFER,
  formatLogTime,
  SOURCE_LABELS,
  visibleRange,
  type LineBuffer,
  type LogLine,
} from './log-lines';

export const LOG_ROW_HEIGHT = 24;
const VIEWPORT_HEIGHT = 420;
const OVERSCAN = 20;
const SEARCH_DEBOUNCE_MS = 300;
const FLUSH_MS = 50;
const PAGE_LIMIT = 1000;
const BOTTOM_SLACK = 8;

export const LOG_WINDOWS = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
} as const;
type WindowKey = keyof typeof LOG_WINDOWS;
type LevelKey = 'all' | LogLevel;

export const LOGS_COPY = Object.freeze({
  empty: 'No log lines in this time range.',
  emptyFiltered: 'No log lines match these filters.',
  loadFailed: "Couldn't load the logs. Try again.",
  allUnavailable:
    "Noodara couldn't read any of the selected sources. The server may be offline; build, deploy and activity logs stay available when you select them.",
  unavailable: (sources: readonly LogSource[]): string =>
    `${sources.map((s) => SOURCE_LABELS[s]).join(', ')} ${sources.length === 1 ? 'is' : 'are'} unavailable right now: Noodara couldn't reach the server. Other sources are shown.`,
  truncated:
    'Showing the newest lines only: this range has more than one page. Narrow the time range or add a search to see older lines.',
  dropped: 'Older lines were dropped to keep the view fast.',
  lineTruncated: 'Line truncated',
  followLimit: 'Too many live log streams are open. Close one, then turn Follow on again.',
  followEnded: 'Follow stopped: no new lines for a while, or the stream reached its time limit.',
  followDropped: 'Follow stopped because the connection dropped. Turn Follow on again.',
  followShutdown: 'Follow stopped because Noodara is restarting. Turn Follow on again.',
});

const LEVEL_TONE: Readonly<Record<LogLevel, string>> = {
  info: 'text-ink-tertiary',
  warn: 'text-status-warn-text',
  error: 'text-status-error-text',
};

function followEndCopy(result: LogFollowResult): string | null {
  if (result.ok) {
    if (result.reason === 'aborted') return null;
    return result.serverReason === 'shutdown' ? LOGS_COPY.followShutdown : LOGS_COPY.followEnded;
  }
  if (result.code === 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED') return LOGS_COPY.followLimit;
  return LOGS_COPY.followDropped;
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'all-unavailable' }
  | { readonly kind: 'error'; readonly code: string };

function LogRow({ line, top }: { readonly line: LogLine; readonly top: number }) {
  const { entry } = line;
  return (
    <div
      data-testid="log-line"
      data-source={entry.source}
      data-level={entry.level}
      className="absolute inset-x-0 flex items-center gap-3 whitespace-pre px-4"
      style={{ top, height: LOG_ROW_HEIGHT }}
    >
      <time dateTime={entry.timestamp} data-testid="log-line-time" className="shrink-0 text-ink-tertiary">
        {formatLogTime(entry.timestamp)}
      </time>
      <span data-testid="log-line-source" className="w-16 shrink-0 text-ink-secondary">
        {SOURCE_LABELS[entry.source]}
      </span>
      <span className={cn('w-10 shrink-0', LEVEL_TONE[entry.level])}>{entry.level}</span>
      <span
        data-testid="log-line-text"
        title={entry.text}
        className={cn('min-w-0 flex-1 truncate', entry.stream === 'stderr' ? 'text-status-error-text' : 'text-ink')}
      >
        {entry.text}
      </span>
      {entry.truncated ? (
        <span data-testid="log-line-truncated" className="shrink-0 font-sans text-caption text-ink-tertiary">
          {LOGS_COPY.lineTruncated}
        </span>
      ) : null}
    </div>
  );
}

export interface ServiceLogsPanelProps {
  readonly projectId: string;
  readonly serviceId: string;
}

export function ServiceLogsPanel({ projectId, serviceId }: ServiceLogsPanelProps) {
  const [sources, setSources] = useState<readonly LogSource[]>(LOG_SOURCES);
  const [windowKey, setWindowKey] = useState<WindowKey>('15m');
  const [level, setLevel] = useState<LevelKey>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [buffer, setBuffer] = useState<LineBuffer>(EMPTY_BUFFER);
  const [truncated, setTruncated] = useState(false);
  const [unavailable, setUnavailable] = useState<readonly LogSource[]>([]);
  const [followNotice, setFollowNotice] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(VIEWPORT_HEIGHT);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [searchInput]);

  const query = useCallback(
    (): LogsQuery => ({
      sources,
      level: level === 'all' ? null : level,
      search: search === '' ? null : search,
    }),
    [sources, level, search],
  );

  // One page for the current filters; a newer request supersedes an older one.
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    const since = new Date(Date.now() - LOG_WINDOWS[windowKey]).toISOString();
    void getServiceLogs(projectId, serviceId, { ...query(), since, limit: PAGE_LIMIT }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.ok) {
          atBottom.current = true;
          setShowJump(false);
          setBuffer(bufferFromPage(result.data.entries));
          setTruncated(result.data.truncated || result.data.nextCursor !== null);
          setUnavailable(result.data.unavailableSources);
          setState({ kind: 'ready' });
          return;
        }
        if (result.unauthorized) {
          void requireSession();
          return;
        }
        setBuffer(EMPTY_BUFFER);
        setTruncated(false);
        setUnavailable([]);
        setState(
          result.code === 'LOG_SOURCE_UNAVAILABLE' ? { kind: 'all-unavailable' } : { kind: 'error', code: result.code },
        );
      },
    );
    return () => {
      controller.abort();
    };
  }, [projectId, serviceId, windowKey, query]);

  // Follow: appended in batches; aborted on off, filter change and unmount.
  useEffect(() => {
    if (!follow) return;
    const controller = new AbortController();
    let pending: LogEntryView[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      const batch = pending;
      pending = [];
      setBuffer((prev) => appendLines(prev, batch));
    };
    setFollowNotice(null);
    void followServiceLogs({
      projectId,
      serviceId,
      query: query(),
      signal: controller.signal,
      onEntries: (entries) => {
        pending.push(...entries);
        timer ??= setTimeout(flush, FLUSH_MS);
      },
      onUnavailable: (source) => {
        setUnavailable((prev) => (prev.includes(source) ? prev : [...prev, source]));
      },
    }).then((result) => {
      if (timer !== null) {
        clearTimeout(timer);
        flush();
      }
      if (controller.signal.aborted) return;
      if (!result.ok && result.unauthorized) {
        void requireSession();
        return;
      }
      setFollowNotice(followEndCopy(result));
      setFollow(false);
    });
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [follow, projectId, serviceId, query]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    if (scroller.clientHeight > 0) setViewport(scroller.clientHeight);
    if (atBottom.current) {
      scroller.scrollTop = scroller.scrollHeight;
      setScrollTop(scroller.scrollTop);
    }
  }, [buffer]);

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const el = event.currentTarget;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    setShowJump(!atBottom.current);
    setScrollTop(el.scrollTop);
  }

  function toggleSource(source: LogSource): void {
    setSources((prev) => {
      if (prev.includes(source)) return prev.length === 1 ? prev : prev.filter((s) => s !== source);
      return LOG_SOURCES.filter((s) => s === source || prev.includes(s));
    });
  }

  const { lines } = buffer;
  const range = visibleRange(lines.length, scrollTop, viewport, LOG_ROW_HEIGHT, OVERSCAN);
  const filtered = level !== 'all' || search !== '' || sources.length < LOG_SOURCES.length;
  const visibleUnavailable = unavailable.filter((s) => sources.includes(s));

  return (
    <div className="flex flex-col gap-3" data-testid="service-logs-view">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Log sources">
        {LOG_SOURCES.map((source) => {
          const on = sources.includes(source);
          return (
            <button
              key={source}
              type="button"
              aria-pressed={on}
              data-testid={`log-source-${source}`}
              onClick={() => {
                toggleSource(source);
              }}
              className={cn(
                'inline-flex h-7 items-center rounded-pill border px-3 text-callout outline-none',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                on ? 'border-accent bg-accent-soft text-ink' : 'border-hairline text-ink-secondary',
              )}
            >
              {SOURCE_LABELS[source]}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl<WindowKey>
          data-testid="log-window"
          value={windowKey}
          onValueChange={setWindowKey}
          options={[
            { value: '15m', label: '15m' },
            { value: '1h', label: '1h' },
            { value: '6h', label: '6h' },
            { value: '24h', label: '24h' },
          ]}
        />
        <SegmentedControl<LevelKey>
          data-testid="log-level"
          value={level}
          onValueChange={setLevel}
          options={[
            { value: 'all', label: 'All' },
            { value: 'info', label: 'Info' },
            { value: 'warn', label: 'Warn' },
            { value: 'error', label: 'Error' },
          ]}
        />
        <div className="min-w-[200px] flex-1">
          <Input
            type="search"
            aria-label="Search logs"
            placeholder="Search"
            data-testid="log-search"
            maxLength={LOG_SEARCH_MAX_LENGTH}
            value={searchInput}
            onChange={(event) => {
              setSearchInput(cleanSearch(event.target.value, LOG_SEARCH_MAX_LENGTH));
            }}
          />
        </div>
        <Switch checked={follow} onCheckedChange={setFollow} label="Follow" data-testid="log-follow" />
      </div>

      {followNotice !== null ? (
        <Notice
          message={followNotice}
          data-testid="log-follow-notice"
          onDismiss={() => {
            setFollowNotice(null);
          }}
        />
      ) : null}
      {state.kind === 'ready' && visibleUnavailable.length > 0 ? (
        <Notice message={LOGS_COPY.unavailable(visibleUnavailable)} data-testid="log-unavailable" />
      ) : null}
      {state.kind === 'ready' && truncated ? <Notice message={LOGS_COPY.truncated} data-testid="log-truncated" /> : null}
      {buffer.dropped ? <Notice message={LOGS_COPY.dropped} data-testid="log-dropped" /> : null}

      {state.kind === 'loading' && !follow ? (
        <div data-testid="log-loading">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : state.kind === 'error' ? (
        <Banner message={LOGS_COPY.loadFailed} errorCode={state.code} data-testid="log-error" />
      ) : state.kind === 'all-unavailable' && lines.length === 0 ? (
        <Notice message={LOGS_COPY.allUnavailable} data-testid="log-all-unavailable" />
      ) : (
        <div className="relative">
          <div
            ref={scrollerRef}
            role="region"
            aria-label="Log output"
            // Focusable so keyboard users can scroll its overflow (axe scrollable-region-focusable).
            tabIndex={0}
            data-testid="log-scroller"
            onScroll={onScroll}
            className="overflow-auto rounded-md border border-hairline bg-canvas outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            style={{ height: VIEWPORT_HEIGHT }}
          >
            {lines.length === 0 ? (
              <p data-testid="log-empty" className="px-4 py-3 text-callout text-ink-secondary">
                {filtered ? LOGS_COPY.emptyFiltered : LOGS_COPY.empty}
              </p>
            ) : (
              <div
                role="log"
                aria-label="Service logs"
                aria-live="off"
                data-count={lines.length}
                data-testid="log-list"
                className="relative font-mono text-mono"
                style={{ height: lines.length * LOG_ROW_HEIGHT }}
              >
                {lines.slice(range.start, range.end).map((line, offset) => (
                  <LogRow key={line.id} line={line} top={(range.start + offset) * LOG_ROW_HEIGHT} />
                ))}
              </div>
            )}
          </div>
          {showJump && lines.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <span className="pointer-events-auto">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="log-jump"
                  onClick={() => {
                    const scroller = scrollerRef.current;
                    if (scroller === null) return;
                    scroller.scrollTop = scroller.scrollHeight;
                    atBottom.current = true;
                    setShowJump(false);
                    setScrollTop(scroller.scrollTop);
                  }}
                >
                  Jump to bottom
                </Button>
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
