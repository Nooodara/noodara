import { describe, expect, it } from 'vitest';
import {
  HIGH_DISK_PERCENT,
  HIGH_MEMORY_PERCENT,
  HIGH_MEMORY_SUSTAINED_SAMPLES,
  diskUsedPercent,
  highDisk,
  highMemory,
  memoryPercent,
  nearFullDisk,
  usagePercent,
  type MemoryReading,
} from './thresholds.js';
import type { FilesystemUsage } from './host-sample.js';

const fs = (target: string, usedBytes: number, availBytes: number, sizeBytes = usedBytes + availBytes): FilesystemUsage => ({
  target,
  sizeBytes,
  usedBytes,
  availBytes,
});

const reading = (usedBytes: number, limitBytes: number | null): MemoryReading => ({ usedBytes, limitBytes });

describe('threshold constants', () => {
  it('are the documented values', () => {
    expect(HIGH_DISK_PERCENT).toBe(90);
    expect(HIGH_MEMORY_PERCENT).toBe(90);
    expect(HIGH_MEMORY_SUSTAINED_SAMPLES).toBe(3);
  });
});

describe('usagePercent', () => {
  it.each<[number, number, number | null]>([
    [50, 200, 25],
    [0, 10, 0],
    [5, 0, null],
    [5, -1, null],
  ])('%d of %d', (used, total, expected) => {
    expect(usagePercent(used, total)).toBe(expected);
  });
});

describe('highDisk / diskUsedPercent (A2, H1)', () => {
  it.each<[string, FilesystemUsage, number | null, boolean]>([
    ['below the threshold', fs('/', 899, 101), 89.9, false],
    ['at the threshold', fs('/', 900, 100), 90, true],
    ['above the threshold', fs('/', 901, 99), 90.1, true],
    ['reserved blocks: percent of used + avail, as df Use%', fs('/', 900, 100, 1100), 90, true],
    ['a filesystem with 0 blocks', fs('/proc/x', 0, 0, 0), null, false],
    ['0 blocks but non-zero counters', fs('/odd', 5, 5, 0), null, false],
    ['blocks but no used + avail', fs('/odd', 0, 0, 10), null, false],
  ])('%s', (_name, filesystem, percent, flag) => {
    expect(diskUsedPercent(filesystem)).toBe(percent);
    expect(highDisk(filesystem)).toBe(flag);
  });
});

describe('nearFullDisk (A2)', () => {
  it('returns the fullest filesystem at or above the threshold with its percentage', () => {
    expect(nearFullDisk([fs('/', 950, 50), fs('/var/lib/docker', 990, 10), fs('/boot', 10, 90)])).toEqual({
      target: '/var/lib/docker',
      usedPercent: 99,
    });
  });

  it('keeps the first of two filesystems with the same percentage', () => {
    expect(nearFullDisk([fs('/', 900, 100), fs('/var/lib/docker', 900, 100)])?.target).toBe('/');
  });

  it.each<[string, FilesystemUsage[]]>([
    ['none listed', []],
    ['all below', [fs('/', 899, 101)]],
    ['only a zero-block filesystem', [fs('/proc/x', 0, 0, 0)]],
  ])('returns null when %s', (_name, filesystems) => {
    expect(nearFullDisk(filesystems)).toBeNull();
  });
});

describe('memoryPercent (H1: unlimited container falls back to host MemTotal)', () => {
  it.each<[string, MemoryReading, number | null, number | null]>([
    ['own limit', reading(45, 50), 1000, 90],
    ['limit null (HostConfig.Memory = 0) uses host total', reading(900, null), 1000, 90],
    ['limit 0 uses host total', reading(900, 0), 1000, 90],
    ['no limit and no host total: no value', reading(900, null), null, null],
    ['no limit and host total 0: no value, no division by zero', reading(900, 0), 0, null],
  ])('%s', (_name, r, hostTotal, expected) => {
    expect(memoryPercent(r, hostTotal)).toBe(expected);
  });
});

describe('highMemory (A2: sustained over N samples)', () => {
  const at = (percent: number): MemoryReading => reading(percent * 10, 1000);

  it.each<[string, MemoryReading[], boolean]>([
    ['last N at the threshold', [at(90), at(90), at(90)], true],
    ['last N above the threshold', [at(91), at(95), at(99)], true],
    ['one of the last N below', [at(91), at(89.9), at(95)], false],
    ['last N below', [at(89.9), at(89.9), at(89.9)], false],
    ['an old low reading outside the last N', [at(10), at(90), at(90), at(90)], true],
    ['fewer than N readings', [at(99), at(99)], false],
    ['no readings', [], false],
  ])('%s', (_name, readings, expected) => {
    expect(highMemory(readings)).toBe(expected);
  });

  it('honours a custom sample count', () => {
    expect(highMemory([at(95)], { samples: 1 })).toBe(true);
  });

  it('falls back to the host total for an unlimited container (H1)', () => {
    const unlimited = [reading(950, null), reading(950, 0), reading(950, null)];
    expect(highMemory(unlimited, { hostTotalBytes: 1000 })).toBe(true);
    expect(highMemory(unlimited, { hostTotalBytes: 2000 })).toBe(false);
    expect(highMemory(unlimited)).toBe(false);
    expect(highMemory(unlimited, { hostTotalBytes: 0 })).toBe(false);
  });
});
