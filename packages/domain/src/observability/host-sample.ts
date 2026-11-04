// Parser for the ADR 0012 HOST_SAMPLE output (A1): two `/proc/stat` CPU reads `$1` seconds apart,
// MemTotal / MemAvailable, `df -B1` per target and `/proc/uptime`. Pure and total: malformed,
// truncated or oversized input is a named error, never a throw, never NaN. Lines without a known
// prefix are stderr noise merged by `2>&1` and are ignored.

import { fail, ok, type ValidationResult } from '../validators/network.js';
import { boundedLines, safeUnsigned, type ParseOptions } from './output-bounds.js';

export interface CpuTimes {
  /** Sum of the first 8 fields: user nice system idle iowait irq softirq steal. */
  readonly total: number;
  /** idle + iowait. */
  readonly idle: number;
}

export interface FilesystemUsage {
  readonly target: string;
  readonly sizeBytes: number;
  readonly usedBytes: number;
  readonly availBytes: number;
}

export interface HostMemory {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
}

export interface HostSample {
  /** Busy share of the delta between the two reads; null when there is no valid delta. */
  readonly cpuPercent: number | null;
  /** The second read, for callers that chain samples. */
  readonly cpu: CpuTimes;
  readonly memory: HostMemory;
  readonly filesystems: readonly FilesystemUsage[];
  readonly uptimeSeconds: number;
}

const MALFORMED = 'HOST_SAMPLE_MALFORMED';
const INCOMPLETE = 'HOST_SAMPLE_INCOMPLETE';
const CPU_FIELDS = 8;
const MEM_LINE = /^(MemTotal|MemAvailable):\s+(\d+) kB$/;
const UP_LINE = /^(\d+(?:\.\d+)?) \d+(?:\.\d+)?$/;
const KIB = 1024;

/** The aggregate `cpu` line of `/proc/stat` (guest time is already counted in user). */
export function parseCpuLine(line: string): ValidationResult<CpuTimes> {
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < CPU_FIELDS + 1) {
    return fail(MALFORMED, 'CPU line is not an aggregate cpu line with 8 counters');
  }
  let total = 0;
  let idle = 0;
  for (let i = 1; i <= CPU_FIELDS; i += 1) {
    const value = safeUnsigned(fields[i] ?? '');
    if (value === null) return fail(MALFORMED, `CPU counter ${String(i)} is not an unsigned integer`);
    total += value;
    if (i === 4 || i === 5) idle += value;
  }
  return ok({ total, idle });
}

/**
 * CPU % = 100 * (Δtotal − Δidle) / Δtotal. No value (null), never a negative or NaN, on the first
 * sample (no previous read) or when the counters went backwards or did not move (wrap, reset).
 * Supersedes the ADR's "0 when Δtotal ≤ 0": 0 % would read as an idle host.
 */
export function cpuPercent(prev: CpuTimes | null, next: CpuTimes): number | null {
  if (prev === null) return null;
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return (100 * (total - idle)) / total;
}

interface Collected {
  cpu: CpuTimes[];
  memTotalKiB: number | null;
  memAvailableKiB: number | null;
  filesystems: FilesystemUsage[];
  uptimeSeconds: number | null;
}

type LineOutcome = string | null; // an error message, or null when the line was absorbed

function collectMem(rest: string, into: Collected): LineOutcome {
  const match = MEM_LINE.exec(rest);
  const kib = safeUnsigned(match?.[2] ?? '');
  if (match === null || kib === null) return 'MEM line is malformed';
  if (match[1] === 'MemTotal') {
    if (into.memTotalKiB !== null) return 'MemTotal appears twice';
    into.memTotalKiB = kib;
  } else {
    if (into.memAvailableKiB !== null) return 'MemAvailable appears twice';
    into.memAvailableKiB = kib;
  }
  return null;
}

const WS = /\s/;

/** Splits off the last whitespace-delimited token in linear time; no regex backtracking. */
function popToken(text: string): { head: string; token: string } | null {
  let end = text.length;
  while (end > 0 && WS.test(text.charAt(end - 1))) end -= 1;
  if (end === 0) return null;
  let begin = end;
  while (begin > 0 && !WS.test(text.charAt(begin - 1))) begin -= 1;
  return { head: text.slice(0, begin), token: text.slice(begin, end) };
}

function collectDf(rest: string, into: Collected): LineOutcome {
  const nums: number[] = [];
  let head = rest;
  for (let i = 0; i < 3; i += 1) {
    const popped = popToken(head);
    const value = popped === null || !/^\d+$/.test(popped.token) ? null : safeUnsigned(popped.token);
    if (popped === null || value === null) return 'DF line is malformed';
    nums.unshift(value);
    head = popped.head;
  }
  const target = head.trim();
  const [size, used, avail] = nums;
  if (target === '' || head === head.trimEnd() || size === undefined || used === undefined || avail === undefined) {
    return 'DF line is malformed';
  }
  into.filesystems.push({ target, sizeBytes: size, usedBytes: used, availBytes: avail });
  return null;
}

function collectLine(line: string, into: Collected): LineOutcome {
  const space = line.indexOf(' ');
  if (space < 0) return null;
  const prefix = line.slice(0, space);
  const rest = line.slice(space + 1);
  switch (prefix) {
    case 'CPU': {
      if (into.cpu.length === 2) return 'More than two CPU reads';
      const cpu = parseCpuLine(rest);
      if (!cpu.ok) return cpu.message;
      into.cpu.push(cpu.value);
      return null;
    }
    case 'MEM':
      return collectMem(rest, into);
    case 'DF':
      return collectDf(rest, into);
    case 'UP': {
      const match = UP_LINE.exec(rest);
      const seconds = Number(match?.[1] ?? NaN);
      if (!Number.isFinite(seconds)) return 'UP line is malformed';
      if (into.uptimeSeconds !== null) return 'UP appears twice';
      into.uptimeSeconds = seconds;
      return null;
    }
    default:
      return null;
  }
}

function toMemory(totalKiB: number, availableKiB: number): ValidationResult<HostMemory> {
  const totalBytes = totalKiB * KIB;
  const availableBytes = availableKiB * KIB;
  if (!Number.isSafeInteger(totalBytes) || totalKiB === 0 || availableKiB > totalKiB) {
    return fail(MALFORMED, 'MemTotal must be positive, in range and not below MemAvailable');
  }
  return ok({ totalBytes, availableBytes, usedBytes: totalBytes - availableBytes });
}

export function parseHostSample(stdout: string, options: ParseOptions = {}): ValidationResult<HostSample> {
  const lines = boundedLines(stdout, options);
  if (!lines.ok) return lines;

  const collected: Collected = {
    cpu: [],
    memTotalKiB: null,
    memAvailableKiB: null,
    filesystems: [],
    uptimeSeconds: null,
  };
  for (const [index, line] of lines.value.entries()) {
    const error = collectLine(line, collected);
    if (error !== null) return fail(MALFORMED, `Line ${String(index + 1)}: ${error}`);
  }

  const [first, second] = collected.cpu;
  const { memTotalKiB, memAvailableKiB, uptimeSeconds, filesystems } = collected;
  if (
    first === undefined ||
    second === undefined ||
    memTotalKiB === null ||
    memAvailableKiB === null ||
    uptimeSeconds === null ||
    filesystems.length === 0
  ) {
    return fail(INCOMPLETE, 'Host sample needs two CPU reads, MemTotal, MemAvailable, a DF line and UP');
  }

  const memory = toMemory(memTotalKiB, memAvailableKiB);
  if (!memory.ok) return memory;

  return ok({
    cpuPercent: cpuPercent(first, second),
    cpu: second,
    memory: memory.value,
    filesystems,
    uptimeSeconds,
  });
}
