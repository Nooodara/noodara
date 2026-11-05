import { describe, expect, it } from 'vitest';
import type { LogEntryView } from '../../lib/api/logs-api';
import { appendLines, bufferFromPage, cleanSearch, EMPTY_BUFFER, formatLogTime, visibleRange } from './log-lines';

function entry(text: string): LogEntryView {
  return { source: 'runtime', timestamp: '2026-11-05T10:00:00.000Z', level: 'info', stream: 'stdout', text, truncated: false };
}

describe('log-lines', () => {
  it('appends with stable increasing ids', () => {
    const a = appendLines(EMPTY_BUFFER, [entry('a'), entry('b')]);
    const b = appendLines(a, [entry('c')]);
    expect(b.lines.map((l) => [l.id, l.entry.text])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
    expect(b.dropped).toBe(false);
    expect(appendLines(b, [])).toBe(b);
  });

  it('keeps the newest lines under the cap and flags the drop', () => {
    const buffer = appendLines(EMPTY_BUFFER, [entry('1'), entry('2'), entry('3')], 2);
    expect(buffer.lines.map((l) => l.entry.text)).toEqual(['2', '3']);
    expect(buffer.dropped).toBe(true);
    expect(appendLines(buffer, [entry('4')], 2).dropped).toBe(true);
  });

  it('shows a newest-first page oldest first', () => {
    expect(bufferFromPage([entry('new'), entry('old')]).lines.map((l) => l.entry.text)).toEqual(['old', 'new']);
  });

  it('renders only the viewport plus overscan', () => {
    expect(visibleRange(10_000, 0, 420, 24, 20)).toEqual({ start: 0, end: 38 });
    expect(visibleRange(10_000, 24 * 5000, 420, 24, 20)).toEqual({ start: 4980, end: 5038 });
    expect(visibleRange(10, 24 * 9, 420, 24, 5)).toEqual({ start: 4, end: 10 });
    expect(visibleRange(0, 0, 420, 24, 20)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(5, -10, -1, 24, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(5, 0, 100, 0, 0)).toEqual({ start: 0, end: 0 });
  });

  it('formats timestamps with milliseconds and keeps a non-date as is', () => {
    expect(formatLogTime('2026-11-05T10:00:00.123Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.123$/);
    expect(formatLogTime('not a date')).toBe('not a date');
  });

  it('strips control characters and caps the search', () => {
    expect(cleanSearch('a\u0000b\u001bc\u007fd', 200)).toBe('abcd');
    expect(cleanSearch('x'.repeat(300), 200)).toHaveLength(200);
  });
});
