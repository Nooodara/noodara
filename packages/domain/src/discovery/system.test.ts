import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArch, parseCpuCores, parseHostname, parseUptimeSeconds } from './system.js';

function readFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('parseHostname', () => {
  it('trims the trailing newline from the captured 22.04 hostname output', () => {
    const result = parseHostname(readFixture('./fixtures/ubuntu-22.04/hostname.txt'));

    expect(result).toEqual({ ok: true, value: '0ab5f27aa728' });
  });

  it('trims the trailing newline from the captured 24.04 hostname output', () => {
    const result = parseHostname(readFixture('./fixtures/ubuntu-24.04/hostname.txt'));

    expect(result).toEqual({ ok: true, value: '5f9691abf409' });
  });

  it('rejects empty output', () => {
    const result = parseHostname('');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('HOSTNAME_EMPTY');
  });

  it('rejects output that is only whitespace', () => {
    const result = parseHostname('\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('HOSTNAME_EMPTY');
  });
});

describe('parseArch', () => {
  it('returns the trimmed architecture from the captured 22.04 output', () => {
    const result = parseArch(readFixture('./fixtures/ubuntu-22.04/arch.txt'));

    expect(result).toEqual({ ok: true, value: 'aarch64' });
  });

  it('returns the trimmed architecture from the captured 24.04 output', () => {
    const result = parseArch(readFixture('./fixtures/ubuntu-24.04/arch.txt'));

    expect(result).toEqual({ ok: true, value: 'aarch64' });
  });

  it('fails on empty input', () => {
    const result = parseArch('');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('ARCH_EMPTY');
  });
});

describe('parseCpuCores', () => {
  it('returns the positive integer from the captured 22.04 nproc output', () => {
    const result = parseCpuCores(readFixture('./fixtures/ubuntu-22.04/cpu.txt'));

    expect(result).toEqual({ ok: true, value: 14 });
  });

  it('returns the positive integer from the captured 24.04 nproc output', () => {
    const result = parseCpuCores(readFixture('./fixtures/ubuntu-24.04/cpu.txt'));

    expect(result).toEqual({ ok: true, value: 14 });
  });

  it('fails on 0 cores', () => {
    const result = parseCpuCores('0\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('CPU_CORES_NOT_A_POSITIVE_INTEGER');
  });

  it('fails on a negative number', () => {
    const result = parseCpuCores('-1\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('CPU_CORES_NOT_A_POSITIVE_INTEGER');
  });

  it('fails on a float', () => {
    const result = parseCpuCores('3.5\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('CPU_CORES_NOT_A_POSITIVE_INTEGER');
  });

  it('fails on non-numeric text', () => {
    const result = parseCpuCores('nproc: command not found\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('CPU_CORES_NOT_A_POSITIVE_INTEGER');
  });
});

describe('parseUptimeSeconds', () => {
  it('returns the floor of the first field from the captured 22.04 /proc/uptime output', () => {
    const result = parseUptimeSeconds(readFixture('./fixtures/ubuntu-22.04/uptime.txt'));

    expect(result).toEqual({ ok: true, value: 4948988 });
  });

  it('returns the floor of the first field from the captured 24.04 /proc/uptime output', () => {
    const result = parseUptimeSeconds(readFixture('./fixtures/ubuntu-24.04/uptime.txt'));

    expect(result).toEqual({ ok: true, value: 4948994 });
  });

  it('fails on a single-field input', () => {
    const result = parseUptimeSeconds('4948988.25\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('UPTIME_MALFORMED');
  });

  it('fails on a malformed (non-numeric) first field', () => {
    const result = parseUptimeSeconds('not-a-number 68558491.20\n');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('UPTIME_MALFORMED');
  });
});
