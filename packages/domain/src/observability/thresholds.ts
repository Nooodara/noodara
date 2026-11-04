// Threshold policies over parsed samples (A2, H1). Pure and total: a zero or unknown total is
// "no value" and never raises a flag, so no policy divides by zero. Percentages use the
// `used * 100 / total` order so an exact boundary (900 of 1000) is exactly 90.

import type { FilesystemUsage } from './host-sample.js';

export const HIGH_DISK_PERCENT = 90;
export const HIGH_MEMORY_PERCENT = 90;
/** highMemory needs the last N readings at or above the threshold (N × 60 s sample interval). */
export const HIGH_MEMORY_SUSTAINED_SAMPLES = 3;

export interface MemoryReading {
  readonly usedBytes: number;
  /** The container's limit, or the host MemTotal for a host reading; null or 0 means unlimited. */
  readonly limitBytes: number | null;
}

export interface NearFullDisk {
  readonly target: string;
  readonly usedPercent: number;
}

export function usagePercent(used: number, total: number): number | null {
  return total > 0 ? (used * 100) / total : null;
}

/** As df's Use%: used / (used + avail), so root-reserved blocks do not hide a full disk. */
export function diskUsedPercent(filesystem: FilesystemUsage): number | null {
  if (filesystem.sizeBytes === 0) return null;
  return usagePercent(filesystem.usedBytes, filesystem.usedBytes + filesystem.availBytes);
}

export function highDisk(filesystem: FilesystemUsage): boolean {
  const percent = diskUsedPercent(filesystem);
  return percent !== null && percent >= HIGH_DISK_PERCENT;
}

/** The fullest filesystem at or above HIGH_DISK_PERCENT (first wins a tie), or null. */
export function nearFullDisk(filesystems: readonly FilesystemUsage[]): NearFullDisk | null {
  let fullest: NearFullDisk | null = null;
  for (const filesystem of filesystems) {
    const percent = diskUsedPercent(filesystem);
    if (percent === null || percent < HIGH_DISK_PERCENT) continue;
    if (fullest === null || percent > fullest.usedPercent) {
      fullest = { target: filesystem.target, usedPercent: percent };
    }
  }
  return fullest;
}

/** A container without a limit (HostConfig.Memory = 0) is measured against the host total. */
export function memoryPercent(reading: MemoryReading, hostTotalBytes: number | null): number | null {
  const limit = reading.limitBytes !== null && reading.limitBytes > 0 ? reading.limitBytes : hostTotalBytes;
  return limit === null ? null : usagePercent(reading.usedBytes, limit);
}

export interface HighMemoryOptions {
  readonly hostTotalBytes?: number | null;
  readonly samples?: number;
}

/** True when each of the last N readings (oldest first) is at or above HIGH_MEMORY_PERCENT. */
export function highMemory(readings: readonly MemoryReading[], options: HighMemoryOptions = {}): boolean {
  const samples = options.samples ?? HIGH_MEMORY_SUSTAINED_SAMPLES;
  if (readings.length < samples) return false;
  const hostTotal = options.hostTotalBytes ?? null;
  return readings.slice(-samples).every((reading) => {
    const percent = memoryPercent(reading, hostTotal);
    return percent !== null && percent >= HIGH_MEMORY_PERCENT;
  });
}
