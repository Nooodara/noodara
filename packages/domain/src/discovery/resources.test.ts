import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDiskUsage, parseMeminfo } from './resources.js';

function readFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('parseMeminfo', () => {
  it('converts the captured 22.04 MemTotal (8024176 kB) to whole MB', () => {
    const result = parseMeminfo(readFixture('./fixtures/ubuntu-22.04/memory.txt'));

    expect(result).toEqual({ ok: true, value: { ramMb: 7836 } });
  });

  // Pins an exact value computed by hand from the real 24.04 capture: 8024176 kB / 1024 = MB,
  // rounded to the nearest whole MB (Math.round) — 7836.109375 -> 7836.
  it('pins the exact ramMb value computed from the real 24.04 MemTotal capture', () => {
    const result = parseMeminfo(readFixture('./fixtures/ubuntu-24.04/memory.txt'));

    expect(result).toEqual({ ok: true, value: { ramMb: 7836 } });
  });

  it('fails when MemTotal is absent', () => {
    const result = parseMeminfo('MemFree:          212320 kB\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('MEMINFO_MISSING_MEMTOTAL');
  });

  it('fails when MemTotal is non-numeric', () => {
    const result = parseMeminfo('MemTotal:        notanumber kB\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('MEMINFO_MALFORMED');
  });

  it('fails when MemTotal is expressed in a unit other than kB', () => {
    const result = parseMeminfo('MemTotal:        8024176 MB\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('MEMINFO_UNEXPECTED_UNIT');
  });
});

describe('parseDiskUsage', () => {
  it('parses total and used MB from the captured 22.04 df -P -k / output', () => {
    const result = parseDiskUsage(readFixture('./fixtures/ubuntu-22.04/disk.txt'));

    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    // overlay 954976684 90525604 815867248 10% /
    expect(result).toEqual({ ok: true, value: { totalMb: 932594, usedMb: 88404 } });
  });

  it('parses total and used MB from the captured 24.04 df -P -k / output', () => {
    const result = parseDiskUsage(readFixture('./fixtures/ubuntu-24.04/disk.txt'));

    // overlay 954976684 90525784 815867068 10% /
    expect(result).toEqual({ ok: true, value: { totalMb: 932594, usedMb: 88404 } });
  });

  it('fails on header-only output', () => {
    const result = parseDiskUsage('Filesystem     1024-blocks     Used Available Capacity Mounted on\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('DISK_USAGE_MISSING_DATA_ROW');
  });

  it('fails on a data row with too few columns', () => {
    const result = parseDiskUsage(
      ['Filesystem     1024-blocks     Used Available Capacity Mounted on', 'overlay 954976684 90525604'].join(
        '\n',
      ),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('DISK_USAGE_MALFORMED_ROW');
  });

  it('fails on non-numeric columns', () => {
    const result = parseDiskUsage(
      [
        'Filesystem     1024-blocks     Used Available Capacity Mounted on',
        'overlay notanumber alsonotanumber 815867248 10% /',
      ].join('\n'),
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('DISK_USAGE_NON_NUMERIC_COLUMN');
  });

  // Synthetic: `-P` guarantees one line per filesystem even when the device name is long enough
  // to wrap under a non-POSIX `df` invocation — no captured fixture happens to have a long device
  // name, so this proves the whitespace-split column extraction still lands on the right columns.
  it('tolerates a long device name (the reason the template uses df -P)', () => {
    const result = parseDiskUsage(
      [
        'Filesystem                         1024-blocks     Used Available Capacity Mounted on',
        '/dev/mapper/a-very-long-volume-name    954976684 90525604 815867248      10% /',
      ].join('\n'),
    );

    expect(result).toEqual({ ok: true, value: { totalMb: 932594, usedMb: 88404 } });
  });
});
