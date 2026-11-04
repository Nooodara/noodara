// 27-04 (A1, A2, A4, H2): entry conversion, redaction before search, and backwards paging.
import { describe, expect, it } from 'vitest';
import { parseLogFilter, type LogFilter, type LogSource } from '@noodara/domain';
import { createRedactor } from '@noodara/domain/security';
import type { LogPosition } from './log-cursor.js';
import {
  activityEntry,
  chunkEntries,
  finalizeEntry,
  inferLogLevel,
  positionEntries,
  type PositionedEntry,
  type RawEntry,
} from './log-entries.js';
import { buildLogPage, type SourceScan } from './log-page.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const at = (second: number): string => new Date(NOW - 600_000 + second * 1000).toISOString();

function filterOf(query: Record<string, unknown> = {}): LogFilter {
  const parsed = parseLogFilter(query, NOW);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function entries(source: LogSource, seconds: readonly number[], text = (s: number) => `${source} ${String(s)}`): PositionedEntry[] {
  const redactor = createRedactor();
  return positionEntries(
    seconds.map((s) => finalizeEntry({ source, timestamp: at(s), stream: null, text: text(s) }, redactor)),
  );
}

const scan = (list: PositionedEntry[], boundary: LogPosition | null = null, capped = false): SourceScan => ({
  entries: list,
  boundary,
  capped,
});

describe('log entries (A1, A4)', () => {
  it('splits a chunk into lines and maps phases to build and deploy', () => {
    const createdAt = new Date(NOW);
    expect(chunkEntries({ phase: 'build', content: 'a\nb\n', createdAt }).map((e) => [e.source, e.text])).toEqual([
      ['build', 'a'],
      ['build', 'b'],
    ]);
    expect(chunkEntries({ phase: 'healthcheck', content: 'ok', createdAt })[0]?.source).toBe('deploy');
    expect(chunkEntries({ phase: 'prepare', content: 'clone', createdAt })[0]?.source).toBe('build');
  });

  it('renders activity from action and outcome only', () => {
    const occurredAt = new Date(NOW);
    expect(activityEntry({ occurredAt, action: 'service.crash_loop', outcome: 'failure', errorCode: 'OOM' })).toMatchObject({
      source: 'activity',
      text: 'service.crash_loop failed (OOM)',
      level: 'error',
    });
    expect(activityEntry({ occurredAt, action: 'deployment.succeeded', outcome: 'success', errorCode: null }).level).toBe('info');
  });

  it('adds an allowlisted observedState diagnosis and drops every other metadata value (27-06)', () => {
    const occurredAt = new Date(NOW);
    const row = { occurredAt, action: 'service.container_changed', outcome: 'success' as const, errorCode: null };
    expect(activityEntry({ ...row, metadata: { serverId: 'srv', observedState: 'out_of_memory' } })).toMatchObject({
      text: 'service.container_changed: out_of_memory',
      level: 'warn',
    });
    expect(activityEntry({ ...row, metadata: { observedState: 'crash_loop' } }).text).toBe('service.container_changed: crash_loop');
    for (const metadata of [{ observedState: 'canary-secret' }, { observedState: 'unknown' }, { observedState: 3 }, null, 'x', {}]) {
      expect(activityEntry({ ...row, metadata })).toMatchObject({ text: 'service.container_changed', level: 'info' });
    }
  });

  it('infers a level from words', () => {
    expect(inferLogLevel('Error: boom')).toBe('error');
    expect(inferLogLevel('npm WARN deprecated x')).toBe('warn');
    expect(inferLogLevel('listening on 3000')).toBe('info');
  });

  it('redacts registered values, strips control bytes and cuts long lines', () => {
    const redactor = createRedactor();
    redactor.register('canary-value-1234567890', 'app_secret');
    const raw: RawEntry = { source: 'runtime', timestamp: at(0), stream: 'stdout', text: '\u001b[31mkey=canary-value-1234567890\u001b[0m' };
    const entry = finalizeEntry(raw, redactor);
    expect(entry.text).not.toContain('canary-value');
    expect(entry.text).not.toContain('\u001b');
    const long = finalizeEntry({ ...raw, text: 'x'.repeat(9000) }, redactor);
    expect(long.text.length).toBe(8192);
    expect(long.truncated).toBe(true);
  });

  it('numbers entries that share an instant and drops unparseable timestamps', () => {
    const redactor = createRedactor();
    const list = positionEntries(
      [at(1), at(0), at(1), 'garbage'].map((timestamp, i) =>
        finalizeEntry({ source: 'runtime', timestamp, stream: 'stdout', text: String(i) }, redactor),
      ),
    );
    expect(list.map((e) => [e.text, e.seq])).toEqual([
      ['1', 0],
      ['0', 0],
      ['2', 1],
    ]);
  });
});

describe('buildLogPage (A1, A2, H1, H2)', () => {
  const base = { cursor: null, limit: 100, maxBytes: 1_000_000 };

  it('merges every source in timestamp order', () => {
    const page = buildLogPage({
      ...base,
      filter: filterOf(),
      scans: { build: scan(entries('build', [1, 4])), runtime: scan(entries('runtime', [2, 3])), activity: scan(entries('activity', [0])) },
    });
    expect(page.entries.map((e) => e.text)).toEqual(['activity 0', 'build 1', 'runtime 2', 'runtime 3', 'build 4']);
    expect(page.next).toBeNull();
    expect(page.truncated).toBe(false);
  });

  it('pages backwards with no overlap and no gap', () => {
    const scans = { runtime: scan(entries('runtime', [1, 2, 3, 4, 5])), build: scan(entries('build', [3])) };
    const first = buildLogPage({ ...base, limit: 3, filter: filterOf(), scans });
    expect(first.entries.map((e) => e.text)).toEqual(['runtime 3', 'runtime 4', 'runtime 5']);
    const second = buildLogPage({ ...base, limit: 3, cursor: first.next, filter: filterOf(), scans });
    expect(second.entries.map((e) => e.text)).toEqual(['runtime 1', 'runtime 2', 'build 3']);
    expect(second.next).toBeNull();
  });

  it('applies source, level and search filters', () => {
    const scans = {
      runtime: scan(entries('runtime', [1, 2], (s) => (s === 1 ? 'Error: disk' : 'all good'))),
      build: scan(entries('build', [3], () => 'error in build')),
    };
    expect(buildLogPage({ ...base, filter: filterOf({ sources: 'runtime', level: 'error' }), scans }).entries.map((e) => e.text)).toEqual([
      'Error: disk',
    ]);
    expect(buildLogPage({ ...base, filter: filterOf({ search: 'GOOD' }), scans }).entries.map((e) => e.text)).toEqual(['all good']);
  });

  it('H2: search never matches a redacted value', () => {
    const redactor = createRedactor();
    redactor.register('canary-value-1234567890', 'app_secret');
    const list = positionEntries([finalizeEntry({ source: 'runtime', timestamp: at(1), stream: 'stdout', text: 'secret canary-value-1234567890' }, redactor)]);
    const page = buildLogPage({ ...base, filter: filterOf({ search: 'cana' }), scans: { runtime: scan(list) } });
    expect(page.entries).toEqual([]);
  });

  it('stops below the highest boundary of a capped scan and resumes there', () => {
    const build = entries('build', [5, 6]);
    const boundary = { timestamp: at(5), source: 'build' as const, seq: 0 };
    const page = buildLogPage({
      ...base,
      filter: filterOf(),
      scans: { build: scan(build, boundary), runtime: scan(entries('runtime', [1, 7])) },
    });
    expect(page.entries.map((e) => e.text)).toEqual(['build 5', 'build 6', 'runtime 7']);
    expect(page.next).toEqual(boundary);
  });

  it('a source that cannot go below the cursor stops and flags the page truncated', () => {
    const runtime = entries('runtime', [5, 6]);
    const page = buildLogPage({
      ...base,
      cursor: { timestamp: at(4), source: 'runtime', seq: 0 },
      filter: filterOf(),
      scans: { runtime: scan(runtime, { timestamp: at(5), source: 'runtime', seq: 0 }), build: scan(entries('build', [1])) },
    });
    expect(page.entries.map((e) => e.text)).toEqual(['build 1']);
    expect(page.truncated).toBe(true);
    expect(page.next).toBeNull();
  });

  it('caps bytes with a truncated flag, and passes through a source cap', () => {
    const big = entries('runtime', [1, 2, 3], () => 'y'.repeat(600));
    const page = buildLogPage({ ...base, maxBytes: 1000, filter: filterOf(), scans: { runtime: scan(big, null, true) } });
    expect(page.entries).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.next).not.toBeNull();
  });
});
