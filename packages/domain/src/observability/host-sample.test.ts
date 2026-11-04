import { describe, expect, it } from 'vitest';
import { cpuPercent, parseCpuLine, parseHostSample, type CpuTimes } from './host-sample.js';
import { SAMPLE_OUTPUT_CAP_BYTES } from './output-bounds.js';

// Output shape of the ADR 0012 HOST_SAMPLE script (A1): two CPU reads, MEM, DF per target, UP.
const SAMPLE = [
  'CPU cpu  10000 0 5000 80000 1000 0 0 0 0 0',
  'CPU cpu  10060 0 5030 80100 1010 0 0 0 0 0',
  'MEM MemTotal:        4000000 kB',
  'MEM MemAvailable:    1000000 kB',
  'DF /                62725623808 12000000000 47500000000',
  'DF /var/lib/docker  62725623808 12000000000 47500000000',
  'UP 12345.67 40000.12',
  '',
].join('\n');

function replaceLine(index: number, line: string | null): string {
  const lines = SAMPLE.split('\n');
  if (line === null) lines.splice(index, 1);
  else lines[index] = line;
  return lines.join('\n');
}

describe('parseCpuLine', () => {
  it('sums the first 8 fields and counts idle + iowait as idle', () => {
    expect(parseCpuLine('cpu  1 2 3 4 5 6 7 8 9 10')).toEqual({ ok: true, value: { total: 36, idle: 9 } });
  });

  it.each([
    ['not the aggregate line', 'cpu0 1 2 3 4 5 6 7 8'],
    ['short line', 'cpu 1 2 3 4 5 6 7'],
    ['negative field', 'cpu 1 2 3 -4 5 6 7 8'],
    ['non-numeric field', 'cpu 1 2 3 x 5 6 7 8'],
    ['decimal field', 'cpu 1 2 3 4.5 5 6 7 8'],
    ['unsafe integer', 'cpu 1 2 3 99999999999999999999 5 6 7 8'],
    ['empty', ''],
  ])('rejects %s', (_name, line) => {
    expect(parseCpuLine(line)).toMatchObject({ ok: false, code: 'HOST_SAMPLE_MALFORMED' });
  });
});

describe('cpuPercent (H1: no value instead of a negative or NaN)', () => {
  const t = (total: number, idle: number): CpuTimes => ({ total, idle });

  it.each<[string, CpuTimes | null, CpuTimes, number | null]>([
    ['busy share of the delta', t(1000, 800), t(1200, 900), 50],
    ['fully idle', t(1000, 800), t(1100, 900), 0],
    ['fully busy', t(1000, 800), t(1100, 800), 100],
    ['first sample (no previous read)', null, t(1000, 800), null],
    ['counter wrap (total went backwards)', t(1000, 800), t(10, 5), null],
    ['no time elapsed', t(1000, 800), t(1000, 800), null],
    ['idle went backwards', t(1000, 800), t(1100, 700), null],
    ['idle grew more than total', t(1000, 800), t(1100, 950), null],
  ])('%s', (_name, prev, next, expected) => {
    expect(cpuPercent(prev, next)).toBe(expected);
  });
});

describe('parseHostSample', () => {
  it('parses the ADR 0012 host sample into a typed HostSample', () => {
    const result = parseHostSample(SAMPLE);
    expect(result).toEqual({
      ok: true,
      value: {
        cpuPercent: 45,
        cpu: { total: 96200, idle: 81110 },
        memory: { totalBytes: 4_096_000_000, availableBytes: 1_024_000_000, usedBytes: 3_072_000_000 },
        filesystems: [
          { target: '/', sizeBytes: 62725623808, usedBytes: 12000000000, availBytes: 47500000000 },
          { target: '/var/lib/docker', sizeBytes: 62725623808, usedBytes: 12000000000, availBytes: 47500000000 },
        ],
        uptimeSeconds: 12345.67,
      },
    });
  });

  it('reports only / when Docker is down (one DF line)', () => {
    const result = parseHostSample(replaceLine(5, null));
    expect(result.ok && result.value.filesystems.map((f) => f.target)).toEqual(['/']);
  });

  it('keeps a target that contains spaces', () => {
    const result = parseHostSample(replaceLine(5, 'DF /mnt/my disk  100 10 90'));
    expect(result.ok && result.value.filesystems[1]?.target).toBe('/mnt/my disk');
  });

  it('ignores unprefixed stderr noise merged by 2>&1', () => {
    const noisy = `df: /mnt/gone: No such file or directory\n${SAMPLE}`;
    expect(parseHostSample(noisy).ok).toBe(true);
  });

  it('gives no CPU value when the counters wrapped between the two reads', () => {
    const wrapped = replaceLine(1, 'CPU cpu  1 0 1 1 0 0 0 0');
    const result = parseHostSample(wrapped);
    expect(result.ok && result.value.cpuPercent).toBeNull();
  });

  it('accepts a zero-block filesystem (policies decide it carries no flag)', () => {
    const result = parseHostSample(replaceLine(4, 'DF /proc/x 0 0 0'));
    expect(result.ok && result.value.filesystems[0]?.sizeBytes).toBe(0);
  });

  it.each([
    ['a third CPU read', `${SAMPLE}CPU cpu  1 2 3 4 5 6 7 8\n`],
    ['a malformed CPU read', replaceLine(0, 'CPU cpu 1 2')],
    ['a malformed MEM line', replaceLine(2, 'MEM MemTotal: lots kB')],
    ['a MEM line for another key', replaceLine(2, 'MEM SwapTotal: 10 kB')],
    ['a duplicated MemTotal', replaceLine(3, 'MEM MemTotal:        4000000 kB')],
    ['MemAvailable above MemTotal', replaceLine(3, 'MEM MemAvailable:    5000000 kB')],
    ['MemTotal of zero', replaceLine(2, 'MEM MemTotal: 0 kB')],
    ['MemTotal overflowing 64-bit safe bytes', replaceLine(2, 'MEM MemTotal: 99999999999999999 kB')],
    ['a malformed DF line', replaceLine(4, 'DF / big 1 2')],
    ['a DF line with an unsafe integer', replaceLine(4, 'DF / 99999999999999999999 1 2')],
    ['a malformed UP line', replaceLine(6, 'UP soon')],
    ['a duplicated UP line', `${SAMPLE}UP 1.0 2.0\n`],
  ])('returns HOST_SAMPLE_MALFORMED for %s', (_name, stdout) => {
    expect(parseHostSample(stdout)).toMatchObject({ ok: false, code: 'HOST_SAMPLE_MALFORMED' });
  });

  it.each([
    ['one CPU read', replaceLine(1, null)],
    ['no CPU read', replaceLine(1, null).split('\n').slice(1).join('\n')],
    ['no MemAvailable', replaceLine(3, null)],
    ['no MemTotal', replaceLine(2, null)],
    ['no DF line', replaceLine(5, null).replace(/^DF .*\n/m, '')],
    ['no UP line', replaceLine(6, null)],
    ['empty output', ''],
  ])('returns HOST_SAMPLE_INCOMPLETE for %s', (_name, stdout) => {
    expect(parseHostSample(stdout)).toMatchObject({ ok: false, code: 'HOST_SAMPLE_INCOMPLETE' });
  });

  it('returns OUTPUT_TRUNCATED when the last line has no newline (cut mid-line)', () => {
    expect(parseHostSample(SAMPLE.slice(0, -5))).toMatchObject({ ok: false, code: 'OUTPUT_TRUNCATED' });
  });

  it('returns OUTPUT_TRUNCATED at exactly the head -c cap', () => {
    const atCap = SAMPLE + 'x'.repeat(SAMPLE_OUTPUT_CAP_BYTES - SAMPLE.length - 1) + '\n';
    expect(parseHostSample(atCap)).toMatchObject({ ok: false, code: 'OUTPUT_TRUNCATED' });
  });

  it('returns OUTPUT_TOO_LARGE above the cap, counting UTF-8 bytes', () => {
    expect(parseHostSample('x'.repeat(SAMPLE_OUTPUT_CAP_BYTES + 1))).toMatchObject({
      ok: false,
      code: 'OUTPUT_TOO_LARGE',
    });
    const multibyte = 'é'.repeat(40_000) + '\n'; // 40 001 chars, 80 001 bytes
    expect(parseHostSample(multibyte)).toMatchObject({ ok: false, code: 'OUTPUT_TOO_LARGE' });
  });

  it('honours a smaller cap from the caller', () => {
    expect(parseHostSample(SAMPLE, { capBytes: 64 })).toMatchObject({ ok: false, code: 'OUTPUT_TOO_LARGE' });
  });

  it('never echoes raw output in its error message', () => {
    const result = parseHostSample(replaceLine(2, 'MEM MemTotal: canary-s3cret kB'));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('canary-s3cret');
  });
});
