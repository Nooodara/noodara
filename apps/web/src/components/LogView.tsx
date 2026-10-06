'use client';

// 13-14: the shared log surface for the inspector (skill §4.7). Lines are plain React text, never
// markup: ANSI is already stripped server-side and nothing here parses it. The caller hands in a
// bounded list (tailLines caps it), so the DOM stays capped whatever the stream sends; each line is
// memoised by key, so an appended batch only renders the new lines.
//
// Auto-scroll follows the bottom while the user is there; scrolling up stops it and shows
// "Jump to bottom".
import { memo, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { Button, cn } from '@noodara/ui';

export interface LogViewLine {
  readonly key: string;
  readonly text: string;
  readonly timestamp?: string | null;
  readonly stream?: 'stdout' | 'stderr';
}

export interface TailedLines {
  readonly lines: readonly LogViewLine[];
  /** True when earlier lines were left out. */
  readonly hidden: boolean;
}

/** The last `max` lines of `text`, keyed by their start offset. Scans from the end, so the cost
 *  is the kept lines, not the whole text. */
export function tailLines(text: string, max: number): TailedLines {
  if (text.length === 0 || max <= 0) return { lines: [], hidden: text.length > 0 };
  let end = text.endsWith('\n') ? text.length - 1 : text.length;
  const out: LogViewLine[] = [];
  while (out.length < max) {
    const newline = end === 0 ? -1 : text.lastIndexOf('\n', end - 1);
    const start = newline + 1;
    out.push({ key: String(start), text: text.slice(start, end) });
    if (newline < 0) return { lines: out.reverse(), hidden: false };
    end = newline;
  }
  return { lines: out.reverse(), hidden: true };
}

const LogLine = memo(function LogLine({ line }: { readonly line: LogViewLine }) {
  return (
    <div data-stream={line.stream} className="whitespace-pre-wrap break-all">
      {line.timestamp ? <span className="mr-3 text-ink-tertiary">{line.timestamp}</span> : null}
      <span className={line.stream === 'stderr' ? 'text-status-error-text' : 'text-ink'}>
        {line.text}
      </span>
    </div>
  );
});

export interface LogViewProps {
  readonly label: string;
  readonly lines: readonly LogViewLine[];
  /** Shown above the lines when earlier ones were left out. */
  readonly hiddenNotice?: string | null;
  readonly emptyText?: string;
  readonly 'data-testid'?: string;
}

/** Pixels from the bottom that still count as "at the bottom". */
const BOTTOM_SLACK = 8;

export function LogView({
  label,
  lines,
  hiddenNotice,
  emptyText,
  'data-testid': testId,
}: LogViewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null && atBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [lines]);

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const el = event.currentTarget;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    atBottom.current = bottom;
    setShowJump(!bottom);
  }

  function jump(): void {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    scroller.scrollTop = scroller.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <div
        ref={scrollerRef}
        data-testid="log-scroller"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-canvas px-4 py-3"
      >
        {hiddenNotice ? (
          <p data-testid="log-hidden-notice" className="mb-2 text-caption text-ink-secondary">
            {hiddenNotice}
          </p>
        ) : null}
        <div
          role="log"
          aria-label={label}
          aria-live="off"
          className={cn('font-mono text-mono leading-[1.6]')}
        >
          {lines.length === 0 && emptyText ? (
            <p className="font-sans text-callout text-ink-secondary">{emptyText}</p>
          ) : null}
          {lines.map((line) => (
            <LogLine key={line.key} line={line} />
          ))}
        </div>
      </div>
      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="pointer-events-auto">
            <Button type="button" variant="secondary" onClick={jump} data-testid="log-jump">
              Jump to bottom
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
