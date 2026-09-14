// RAM and disk usage parsers (DISC-01). Both convert from the unit the underlying command
// reports (kB for /proc/meminfo, 1K-blocks for `df -P -k /`) to whole megabytes using the same
// rounding rule: MB = kilobytes / 1024, rounded to the nearest whole number with `Math.round`.
// The exact 24.04 fixture value (8024176 kB -> 7836 MB) is pinned in resources.test.ts so a
// future rounding-rule change fails a test rather than shipping silently.

import type { ValidationResult } from '../validators/network.js';
import { assertDefined, fail, ok } from '../validators/network.js';

const MEM_TOTAL_LINE_PATTERN = /^MemTotal:\s*(\d+)\s*(\S+)\s*$/;

export function parseMeminfo(stdout: string): ValidationResult<{ ramMb: number }> {
  const memTotalLine = stdout.split('\n').find((line) => line.trim().startsWith('MemTotal:'));

  if (memTotalLine === undefined) {
    return fail('MEMINFO_MISSING_MEMTOTAL', 'MemTotal line not found in /proc/meminfo output');
  }

  const match = MEM_TOTAL_LINE_PATTERN.exec(memTotalLine.trim());
  if (match === null) {
    return fail('MEMINFO_MALFORMED', `MemTotal line is malformed: "${memTotalLine.trim()}"`);
  }

  const kbValue = assertDefined(match[1]);
  const unit = assertDefined(match[2]);

  if (unit !== 'kB') {
    return fail('MEMINFO_UNEXPECTED_UNIT', `Expected MemTotal in kB, got unit "${unit}"`);
  }

  return ok({ ramMb: Math.round(Number(kbValue) / 1024) });
}

export function parseDiskUsage(
  stdout: string,
): ValidationResult<{ totalMb: number; usedMb: number }> {
  // `df -P -k /` (POSIX output format, 1K blocks): `-P` guarantees exactly one line of data per
  // filesystem, even when the device name is long enough that a non-POSIX `df` would otherwise
  // wrap it onto its own line — this whitespace-split column extraction only works because the
  // command template already asks for `-P`.
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return fail(
      'DISK_USAGE_MISSING_DATA_ROW',
      'Expected a header line and a data line in df output',
    );
  }

  const columns = assertDefined(lines[1]).trim().split(/\s+/);
  if (columns.length < 6) {
    return fail(
      'DISK_USAGE_MALFORMED_ROW',
      `Expected 6 columns in df data row, got ${columns.length.toString()}`,
    );
  }

  const totalBlocks = Number(assertDefined(columns[1]));
  const usedBlocks = Number(assertDefined(columns[2]));

  if (!Number.isFinite(totalBlocks) || !Number.isFinite(usedBlocks)) {
    return fail('DISK_USAGE_NON_NUMERIC_COLUMN', 'Total or used column is not numeric');
  }

  return ok({
    totalMb: Math.round(totalBlocks / 1024),
    usedMb: Math.round(usedBlocks / 1024),
  });
}
