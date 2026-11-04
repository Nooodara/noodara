// Parser for the ADR 0012 CONTAINER_SAMPLE output (A2): `I <json>` per managed container from the
// restricted inspect template and `S <id>\t<cpu%>\t<used> / <limit>` per running one from
// `docker stats`. Pure and total: any malformed line fails the whole sample with a named error
// (the next tick retries), never a throw, never NaN. The inspect shape is strict, so a template
// that started selecting more (for example `.Config.Env`) is rejected instead of carried along.
// Unprefixed lines are docker stderr merged by `2>&1` (a container removed mid-sample).

import { z } from 'zod';
import { DOCKER_CONTAINER_STATES, type DockerContainerState } from '../deployment/container-state.js';
import { fail, ok, type ValidationResult } from '../validators/network.js';
import { boundedLines, type ParseOptions } from './output-bounds.js';

export type ContainerHealthStatus = 'starting' | 'healthy' | 'unhealthy';

export interface ContainerStats {
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly memoryLimitBytes: number | null;
}

export interface ContainerSample {
  readonly id: string;
  /** Without Docker's leading `/`. */
  readonly name: string;
  readonly status: DockerContainerState;
  readonly running: boolean;
  readonly restarting: boolean;
  readonly restartCount: number;
  readonly oomKilled: boolean;
  readonly exitCode: number;
  /** null for Docker's zero time (never started / never finished). */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** null when the image has no HEALTHCHECK. */
  readonly health: ContainerHealthStatus | null;
  /** Exit codes of the retained health probes, oldest first; -1 is a probe timeout. */
  readonly healthExitCodes: readonly number[];
  /** null when HostConfig.Memory = 0 (unlimited); never the host total. */
  readonly memoryLimitBytes: number | null;
  /** null when the container was not running at sample time. */
  readonly stats: ContainerStats | null;
}

const MALFORMED = 'CONTAINER_SAMPLE_MALFORMED';
const DOCKER_ZERO_TIME = '0001-01-01T00:00:00Z';
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const MAX_HEALTH_LOG = 64;

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

const InspectLine = z.strictObject({
  id: z.string().regex(CONTAINER_ID),
  name: z.string().min(1).max(256),
  status: z.enum(DOCKER_CONTAINER_STATES),
  running: z.boolean(),
  restarting: z.boolean(),
  restartCount: z.int().min(0),
  oomKilled: z.boolean(),
  exitCode: z.int(),
  startedAt: timestamp,
  finishedAt: timestamp,
  health: z.enum(['none', 'starting', 'healthy', 'unhealthy']).nullable(),
  healthExitCodes: z.array(z.int()).max(MAX_HEALTH_LOG),
  memoryLimit: z.int().min(0),
});

type InspectRow = z.infer<typeof InspectLine>;

const SIZE_UNITS: Readonly<Record<string, number>> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  kB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
};
const DOCKER_SIZE = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/;
const CPU_PERCENT = /^(\d+(?:\.\d+)?)%$/;
const NO_VALUE = '--';

/** `docker stats` sizes (`4.5MiB`, `1.5kB`); null for `--` or anything unrecognised. */
export function parseDockerSize(value: string): number | null {
  const match = DOCKER_SIZE.exec(value.trim());
  const unit = match?.[2] === undefined ? undefined : SIZE_UNITS[match[2]];
  if (match?.[1] === undefined || unit === undefined) return null;
  const bytes = Math.round(Number(match[1]) * unit);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function parseInspectLine(json: string): InspectRow | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = InspectLine.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A stats column that is either `--` (no value) or must parse; undefined means malformed. */
function optional<T>(text: string, parse: (text: string) => T | null): T | null | undefined {
  if (text === NO_VALUE) return null;
  return parse(text) ?? undefined;
}

function parseCpu(text: string): number | null {
  const match = CPU_PERCENT.exec(text);
  const percent = Number(match?.[1] ?? NaN);
  return Number.isFinite(percent) ? percent : null;
}

function parseStatsLine(line: string): { readonly id: string; readonly stats: ContainerStats } | null {
  const [id, cpu, mem, extra] = line.split('\t');
  const [used, limit, rest] = mem?.split(' / ') ?? [];
  if (id === undefined || cpu === undefined || used === undefined || limit === undefined) return null;
  if (extra !== undefined || rest !== undefined) return null;
  const cpuPercent = optional(cpu, parseCpu);
  const memoryBytes = optional(used, parseDockerSize);
  const memoryLimitBytes = optional(limit, parseDockerSize);
  if (cpuPercent === undefined || memoryBytes === undefined || memoryLimitBytes === undefined) return null;
  return { id, stats: { cpuPercent, memoryBytes, memoryLimitBytes } };
}

function zeroTimeToNull(value: string): string | null {
  return value === DOCKER_ZERO_TIME ? null : value;
}

function toSample(row: InspectRow, stats: ContainerStats | undefined): ContainerSample {
  return {
    id: row.id,
    name: row.name.startsWith('/') ? row.name.slice(1) : row.name,
    status: row.status,
    running: row.running,
    restarting: row.restarting,
    restartCount: row.restartCount,
    oomKilled: row.oomKilled,
    exitCode: row.exitCode,
    startedAt: zeroTimeToNull(row.startedAt),
    finishedAt: zeroTimeToNull(row.finishedAt),
    health: row.health === 'none' ? null : row.health,
    healthExitCodes: row.healthExitCodes,
    memoryLimitBytes: row.memoryLimit === 0 ? null : row.memoryLimit,
    stats: stats ?? null,
  };
}

export function parseContainerSample(
  stdout: string,
  options: ParseOptions = {},
): ValidationResult<readonly ContainerSample[]> {
  const lines = boundedLines(stdout, options);
  if (!lines.ok) return lines;

  const rows = new Map<string, InspectRow>();
  const stats = new Map<string, ContainerStats>();
  for (const [index, line] of lines.value.entries()) {
    const where = `Line ${String(index + 1)}`;
    if (line.startsWith('I ')) {
      const row = parseInspectLine(line.slice(2));
      if (row === null) return fail(MALFORMED, `${where}: inspect state does not match the template`);
      if (rows.has(row.id)) return fail(MALFORMED, `${where}: container inspected twice`);
      rows.set(row.id, row);
    } else if (line.startsWith('S ')) {
      const parsed = parseStatsLine(line.slice(2));
      if (parsed === null) return fail(MALFORMED, `${where}: stats row does not match the template`);
      if (stats.has(parsed.id)) return fail(MALFORMED, `${where}: container has two stats rows`);
      stats.set(parsed.id, parsed.stats);
    }
  }

  // Stats for a container that was not inspected (started between the two `docker ps`) is dropped.
  return ok([...rows.values()].map((row) => toSample(row, stats.get(row.id))));
}
