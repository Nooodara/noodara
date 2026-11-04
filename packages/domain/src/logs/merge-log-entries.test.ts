import { describe, expect, it } from 'vitest';
import { mergeLogEntries, type LogEntriesBySource } from './merge-log-entries.js';

// 26-03 A5 (LOG-05): one deterministic timeline from several sources.

interface Line {
  readonly timestamp: string;
  readonly text: string;
}
const line = (timestamp: string, text: string): Line => ({ timestamp, text });

describe('mergeLogEntries (A5)', () => {
  const bySource: LogEntriesBySource<Line> = {
    activity: [
      line('2026-11-03T12:00:00.000Z', 'deploy started'),
      line('2026-11-03T12:00:03Z', 'deploy ok'),
    ],
    runtime: [
      line('2026-11-03T12:00:02.000000001Z', 'listening'),
      line('2026-11-03T12:00:00Z', 'out-of-order but same ts as activity'),
      line('2026-11-03T12:00:00Z', 'second line, same ts'),
    ],
    build: [line('2026-11-03T12:00:00.000000000Z', 'step 1')],
    deploy: [line('2026-11-03T12:00:01+00:00', 'container started')],
  };

  it('orders by timestamp, then source order, then position within its source', () => {
    expect(mergeLogEntries(bySource).map((e) => `${e.source}: ${e.text}`)).toEqual([
      'build: step 1',
      'runtime: out-of-order but same ts as activity',
      'runtime: second line, same ts',
      'activity: deploy started',
      'deploy: container started',
      'runtime: listening',
      'activity: deploy ok',
    ]);
  });

  it('does not depend on the key order of its input', () => {
    const reversed = Object.fromEntries(
      Object.entries(bySource).reverse(),
    ) as LogEntriesBySource<Line>;
    expect(JSON.stringify(mergeLogEntries(reversed))).toBe(
      JSON.stringify(mergeLogEntries(bySource)),
    );
  });

  it('tags each entry with its source and leaves the input untouched', () => {
    const input = {
      runtime: [{ timestamp: '2026-11-03T12:00:00Z', text: 'x', source: 'build' }],
    };
    expect(mergeLogEntries(input)).toEqual([
      { timestamp: '2026-11-03T12:00:00Z', text: 'x', source: 'runtime' },
    ]);
    expect(input.runtime[0]?.source).toBe('build');
  });

  it('puts unparseable timestamps last, still in source and position order', () => {
    const merged = mergeLogEntries<Line>({
      runtime: [line('bad-2', 'r-bad'), line('2026-11-03T12:00:00Z', 'r-ok')],
      build: [line('bad-1', 'b-bad'), line('2026-11-03T12:00:05Z', 'b-ok')],
    });
    expect(merged.map((e) => e.text)).toEqual(['r-ok', 'b-ok', 'b-bad', 'r-bad']);
  });

  it('returns an empty timeline for no entries', () => {
    expect(mergeLogEntries({})).toEqual([]);
    expect(mergeLogEntries({ runtime: [] })).toEqual([]);
  });
});
