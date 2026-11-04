import { describe, expect, it } from 'vitest';
import { parseContainerSample } from '@noodara/domain';
import { salvageContainerSample } from './container-salvage.js';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = 'c'.repeat(64);

function inspectLine(id: string, name: string, overrides: Record<string, unknown> = {}): string {
  return `I ${JSON.stringify({
    id,
    name: `/${name}`,
    status: 'running',
    running: true,
    restarting: false,
    restartCount: 0,
    oomKilled: false,
    exitCode: 0,
    startedAt: '2026-11-04T00:00:00.000000000Z',
    finishedAt: '0001-01-01T00:00:00Z',
    health: null,
    healthExitCodes: [],
    memoryLimit: 0,
    ...overrides,
  })}`;
}

const statsLine = (id: string) => `S ${id}\t1.50%\t10MiB / 1GiB`;

describe('salvageContainerSample (27-02 H2)', () => {
  it('keeps every well-formed container and reports the malformed one by id and name only', () => {
    const stdout = [
      inspectLine(ID_A, 'noodara-a'),
      statsLine(ID_A),
      inspectLine(ID_B, 'noodara-b', { restartCount: -4 }),
      inspectLine(ID_C, 'noodara-c'),
      statsLine(ID_C),
      'Error response from daemon: No such container',
    ].join('\n');
    expect(parseContainerSample(stdout).ok).toBe(false);

    const salvaged = salvageContainerSample(stdout);

    expect(salvaged.samples.map((s) => s.id)).toEqual([ID_A, ID_C]);
    expect(salvaged.samples[0]?.stats?.cpuPercent).toBe(1.5);
    expect(salvaged.failures).toEqual([{ containerId: ID_B, name: 'noodara-b' }]);
  });

  it('fails a container whose stats row is malformed, never its neighbours', () => {
    const stdout = [inspectLine(ID_A, 'noodara-a'), `S ${ID_A}\tlots\tnope`, inspectLine(ID_B, 'noodara-b')].join('\n');

    const salvaged = salvageContainerSample(stdout);

    expect(salvaged.samples.map((s) => s.id)).toEqual([ID_B]);
    expect(salvaged.failures).toEqual([{ containerId: ID_A, name: 'noodara-a' }]);
  });

  it('reports a line without a readable id or name as an anonymous failure', () => {
    const salvaged = salvageContainerSample(['I {"id":"XYZ"', inspectLine(ID_A, 'noodara-a')].join('\n'));

    expect(salvaged.samples.map((s) => s.id)).toEqual([ID_A]);
    expect(salvaged.failures).toEqual([{ containerId: null, name: null }]);
  });

  it('returns nothing for empty output', () => {
    expect(salvageContainerSample('')).toEqual({ samples: [], failures: [] });
  });
});
