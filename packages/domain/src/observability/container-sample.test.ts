import { describe, expect, it } from 'vitest';
import { parseContainerSample, parseDockerSize } from './container-sample.js';
import { SAMPLE_OUTPUT_CAP_BYTES } from './output-bounds.js';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

function inspect(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: ID_A,
    name: '/noodara-svc_a',
    status: 'running',
    running: true,
    restarting: false,
    restartCount: 0,
    oomKilled: false,
    exitCode: 0,
    startedAt: '2026-11-03T18:37:14.689777509Z',
    finishedAt: '0001-01-01T00:00:00Z',
    health: 'healthy',
    healthExitCodes: [0, 0],
    memoryLimit: 67108864,
    ...overrides,
  });
}

const SAMPLE = [
  `I ${inspect()}`,
  `I ${inspect({ id: ID_B, name: '/noodara-svc_b', status: 'exited', running: false, exitCode: 137, oomKilled: true, health: null, healthExitCodes: [], memoryLimit: 0, finishedAt: '2026-11-03T18:40:00.1Z' })}`,
  `S ${ID_A}\t12.34%\t4.5MiB / 64MiB`,
  '',
].join('\n');

describe('parseDockerSize', () => {
  it.each<[string, number | null]>([
    ['0B', 0],
    ['512B', 512],
    ['1KiB', 1024],
    ['4.5MiB', 4_718_592],
    ['2GiB', 2_147_483_648],
    ['1TiB', 1_099_511_627_776],
    ['1.5kB', 1500],
    ['3MB', 3_000_000],
    ['1GB', 1_000_000_000],
    [' 7MiB ', 7_340_032],
    ['7 MiB', 7_340_032],
    ['--', null],
    ['12XB', null],
    ['MiB', null],
    ['1.2.3MiB', null],
    ['', null],
  ])('%s', (input, expected) => {
    expect(parseDockerSize(input)).toBe(expected);
  });
});

describe('parseContainerSample', () => {
  it('joins inspect state and stats into typed ContainerSample values', () => {
    const result = parseContainerSample(SAMPLE);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: ID_A,
          name: 'noodara-svc_a',
          status: 'running',
          running: true,
          restarting: false,
          restartCount: 0,
          oomKilled: false,
          exitCode: 0,
          startedAt: '2026-11-03T18:37:14.689777509Z',
          finishedAt: null,
          health: 'healthy',
          healthExitCodes: [0, 0],
          memoryLimitBytes: 67108864,
          stats: { cpuPercent: 12.34, memoryBytes: 4_718_592, memoryLimitBytes: 67_108_864 },
        },
        {
          id: ID_B,
          name: 'noodara-svc_b',
          status: 'exited',
          running: false,
          restarting: false,
          restartCount: 0,
          oomKilled: true,
          exitCode: 137,
          startedAt: '2026-11-03T18:37:14.689777509Z',
          finishedAt: '2026-11-03T18:40:00.1Z',
          health: null,
          healthExitCodes: [],
          memoryLimitBytes: null, // HostConfig.Memory = 0: unlimited, never the host total
          stats: null,
        },
      ],
    });
  });

  it('returns an empty list when no managed container exists', () => {
    expect(parseContainerSample('')).toEqual({ ok: true, value: [] });
  });

  it('maps health "none" to no healthcheck and "--" stats to no value', () => {
    const stdout = `I ${inspect({ health: 'none' })}\nS ${ID_A}\t--\t-- / --\n`;
    const result = parseContainerSample(stdout);
    expect(result.ok && result.value[0]?.health).toBeNull();
    expect(result.ok && result.value[0]?.stats).toEqual({ cpuPercent: null, memoryBytes: null, memoryLimitBytes: null });
  });

  it('ignores stats for a container that was not inspected and unprefixed stderr noise', () => {
    const stdout = `Error: No such container: x\nI ${inspect()}\nS ${ID_B}\t1%\t1MiB / 2MiB\n`;
    const result = parseContainerSample(stdout);
    expect(result.ok && result.value.map((c) => c.stats)).toEqual([null]);
  });

  it.each([
    ['inspect that is not JSON', `I {"id":\n`],
    ['inspect that is a JSON array', `I []\n`],
    ['inspect with an extra key (e.g. Config.Env)', `I ${inspect({ env: ['A=1'] })}\n`],
    ['inspect missing a key', `I ${JSON.stringify({ id: ID_A })}\n`],
    ['inspect with an unknown status', `I ${inspect({ status: 'zombie' })}\n`],
    ['inspect with a negative restart count', `I ${inspect({ restartCount: -1 })}\n`],
    ['inspect with a fractional exit code', `I ${inspect({ exitCode: 1.5 })}\n`],
    ['inspect with a bad timestamp', `I ${inspect({ startedAt: 'yesterday' })}\n`],
    ['inspect with an unknown health status', `I ${inspect({ health: 'meh' })}\n`],
    ['inspect with a malformed id', `I ${inspect({ id: 'not-an-id' })}\n`],
    ['inspect with a duplicated id', `I ${inspect()}\nI ${inspect()}\n`],
    ['inspect with too many health exit codes', `I ${inspect({ healthExitCodes: Array.from({ length: 65 }, () => 0) })}\n`],
    ['a stats row with too few columns', `I ${inspect()}\nS ${ID_A}\t1%\n`],
    ['a stats row with a bad CPU percentage', `I ${inspect()}\nS ${ID_A}\tlots\t1MiB / 2MiB\n`],
    ['a stats row with a negative CPU percentage', `I ${inspect()}\nS ${ID_A}\t-1%\t1MiB / 2MiB\n`],
    ['a stats row with a bad memory usage', `I ${inspect()}\nS ${ID_A}\t1%\t1MiB\n`],
    ['a stats row with a bad memory unit', `I ${inspect()}\nS ${ID_A}\t1%\t1MiB / 2XB\n`],
    ['a duplicated stats row', `I ${inspect()}\nS ${ID_A}\t1%\t1MiB / 2MiB\nS ${ID_A}\t1%\t1MiB / 2MiB\n`],
  ])('returns CONTAINER_SAMPLE_MALFORMED for %s', (_name, stdout) => {
    expect(parseContainerSample(stdout)).toMatchObject({ ok: false, code: 'CONTAINER_SAMPLE_MALFORMED' });
  });

  it('returns OUTPUT_TRUNCATED for a cut last line and at the cap, OUTPUT_TOO_LARGE above it', () => {
    expect(parseContainerSample(SAMPLE.slice(0, -10))).toMatchObject({ ok: false, code: 'OUTPUT_TRUNCATED' });
    const atCap = SAMPLE + 'x'.repeat(SAMPLE_OUTPUT_CAP_BYTES - SAMPLE.length - 1) + '\n';
    expect(parseContainerSample(atCap)).toMatchObject({ ok: false, code: 'OUTPUT_TRUNCATED' });
    expect(parseContainerSample('x'.repeat(SAMPLE_OUTPUT_CAP_BYTES * 2))).toMatchObject({
      ok: false,
      code: 'OUTPUT_TOO_LARGE',
    });
  });

  it('never echoes raw output in its error message', () => {
    const result = parseContainerSample(`I ${inspect({ name: 'canary-s3cret', status: 'zombie' })}\n`);
    expect(JSON.stringify(result)).not.toContain('canary-s3cret');
  });
});
