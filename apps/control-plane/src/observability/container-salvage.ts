// 27-02 (H2): per-container fallback for the all-or-nothing CONTAINER_SAMPLE parser. When the
// whole sample is unparseable, each `I ` line is re-parsed with its own `S ` rows, so one
// malformed container is reported by id/name and never discards the others of the tick.
// Only the container id and name ever leave this module; no raw line does.
import { parseContainerSample, type ContainerSample } from '@noodara/domain';

export interface ContainerSampleFailure {
  /** The full id when the malformed line still carried one; otherwise null. */
  readonly containerId: string | null;
  /** Docker name without the leading `/`, when it could be read. */
  readonly name: string | null;
}

export interface SalvagedContainers {
  readonly samples: readonly ContainerSample[];
  readonly failures: readonly ContainerSampleFailure[];
}

const ID_FIELD = /"id":"([0-9a-f]{12,64})"/;
const NAME_FIELD = /"name":"\/?([A-Za-z0-9][A-Za-z0-9_.-]{0,255})"/;
const STATS_ID = /^S ([0-9a-f]{12,64})\t/;

export function salvageContainerSample(stdout: string): SalvagedContainers {
  const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''));
  const statsById = new Map<string, string[]>();
  for (const line of lines) {
    const id = STATS_ID.exec(line)?.[1];
    if (id === undefined) continue;
    statsById.set(id, [...(statsById.get(id) ?? []), line]);
  }

  const samples: ContainerSample[] = [];
  const failures: ContainerSampleFailure[] = [];
  for (const line of lines) {
    if (!line.startsWith('I ')) continue;
    const id = ID_FIELD.exec(line)?.[1] ?? null;
    const name = NAME_FIELD.exec(line)?.[1] ?? null;
    const own = [line, ...(id === null ? [] : (statsById.get(id) ?? []))].join('\n');
    const parsed = parseContainerSample(own);
    if (parsed.ok && parsed.value.length === 1 && parsed.value[0] !== undefined) {
      samples.push(parsed.value[0]);
    } else {
      failures.push({ containerId: id, name });
    }
  }
  return { samples, failures };
}
