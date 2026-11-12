// 36-01 (QA-25): NOODARA_TEST_TIMEOUT_SCALE is an opt-in, test-only multiplier for runner-level
// timeout defaults on slow contributor machines. These tests pin the parser's strictness (a typo
// must never shorten or unbound a timeout), the `scaled` helper's bounds, and the once-per-process
// resolution and announcement contract shared by the Vitest runners and Playwright.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NODE_TIMER_MAX_MS,
  RUNNER_TIMEOUT_DEFAULTS,
  TIMEOUT_SCALE_ANNOUNCED_ENV,
  TIMEOUT_SCALE_ENV,
  TIMEOUT_SCALE_MAX,
  TIMEOUT_SCALE_MIN,
  createTimeoutScale,
  parseTimeoutScale,
  resolveRunnerTimeoutScale,
  scaleTimeout,
} from '../../support/timeout-scale.js';
import { injectedTimeoutScale } from '../../support/vitest-provided.js';

describe('injectedTimeoutScale (36-02: the factor Vitest `provide`s to every unit worker)', () => {
  it('equals the factor this run resolved from the environment (exactly 1 when unset)', () => {
    const scale = injectedTimeoutScale();
    expect(scale.factor).toBe(parseTimeoutScale(process.env[TIMEOUT_SCALE_ENV]));
    expect(scale.scaled(30_000)).toBe(scaleTimeout(30_000, scale.factor));
  });

  it('fails loudly instead of defaulting when the factor was not provided or is out of range', () => {
    for (const bad of [undefined, 0, 0.5, 11, Number.NaN, '2']) {
      expect(() => injectedTimeoutScale(() => bad)).toThrow(/vitest\.config\.ts|NOODARA_TEST_TIMEOUT_SCALE/);
    }
  });
});

const RANGE_PATTERN = /NOODARA_TEST_TIMEOUT_SCALE.*\[1, 10\]/;

describe('parseTimeoutScale', () => {
  it('names the variable it parses', () => {
    expect(TIMEOUT_SCALE_ENV).toBe('NOODARA_TEST_TIMEOUT_SCALE');
    expect(TIMEOUT_SCALE_MIN).toBe(1);
    expect(TIMEOUT_SCALE_MAX).toBe(10);
  });

  it.each([
    [undefined, 1],
    ['', 1],
  ])('treats %j as exactly 1', (raw, expected) => {
    expect(parseTimeoutScale(raw)).toBe(expected);
  });

  it.each([
    ['1', 1],
    ['1.0', 1],
    ['1.5', 1.5],
    ['2', 2],
    ['3', 3],
    ['2.25', 2.25],
    ['9.999', 9.999],
    ['10', 10],
    ['10.0', 10],
  ])('accepts plain decimal %j as %d', (raw, expected) => {
    expect(parseTimeoutScale(raw)).toBe(expected);
  });

  it.each([
    ['0'],
    ['0.0'],
    ['0.5'],
    ['0.999'],
    ['-1'],
    ['-2'],
    ['+2'],
    ['10.0001'],
    ['11'],
    ['100'],
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['abc'],
    ['2x'],
    ['0x2'],
    ['1e1'],
    ['1E1'],
    ['2,5'],
    ['1_0'],
    ['.5'],
    ['2.'],
    ['1.2.3'],
    [' 2'],
    ['2 '],
    [' 2 '],
    ['\t2'],
    ['2\n'],
    [' '],
    ['   '],
    ['٣'],
    ['1' + '0'.repeat(400)],
  ])('rejects %j with an error naming the variable and the range', (raw) => {
    expect(() => parseTimeoutScale(raw)).toThrow(RANGE_PATTERN);
  });

  it('echoes a truncated, control-character-stripped copy of the rejected value', () => {
    const raw = `bad\u0000\u001b[31m\nvalue-${'x'.repeat(100)}`;
    let message = '';
    try {
      parseTimeoutScale(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(RANGE_PATTERN);
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const echoed = /got "([^"]*)"/.exec(message)?.[1];
    expect(echoed).toBeDefined();
    expect(echoed?.length).toBeLessThanOrEqual(32);
    expect(echoed?.startsWith('bad[31mvalue-')).toBe(true);
    expect(message).not.toContain('x'.repeat(40));
  });

  it('never echoes other environment content', () => {
    let message = '';
    try {
      parseTimeoutScale('oops');
    } catch (error) {
      message = (error as Error).message;
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (name === TIMEOUT_SCALE_ENV || value === undefined || value.length < 8) continue;
      expect(message).not.toContain(value);
    }
  });
});

describe('scaleTimeout / createTimeoutScale', () => {
  it('returns the input unchanged at factor 1', () => {
    const scale = createTimeoutScale(1);
    expect(scale.factor).toBe(1);
    for (const ms of [0, 1, 5000, 10_000, 15_000, 60_000, 120_000, 900_000]) {
      expect(scale.scaled(ms)).toBe(ms);
    }
  });

  it('multiplies and rounds up to an integer number of milliseconds', () => {
    expect(scaleTimeout(5000, 3)).toBe(15_000);
    expect(scaleTimeout(1001, 1.5)).toBe(1502);
    expect(scaleTimeout(1, 1.1)).toBe(2);
    expect(scaleTimeout(1.5, 1)).toBe(2);
    expect(Number.isInteger(scaleTimeout(333, 2.345))).toBe(true);
  });

  it.each([1, 1.0001, 1.5, 2.345, 3, 7.77, 10])('never returns less than its input at factor %d', (factor) => {
    for (const ms of [0, 1, 7, 999, 5000, 15_000, 123_457, 900_000]) {
      const result = scaleTimeout(ms, factor);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(ms);
    }
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [-1], [-0.5], ['5000'], [null], [undefined], [{}]])(
    'rejects the argument %j',
    (ms) => {
      expect(() => scaleTimeout(ms as number, 2)).toThrow(/ms/);
    },
  );

  it('throws instead of returning a value above the Node timer limit', () => {
    expect(NODE_TIMER_MAX_MS).toBe(2_147_483_647);
    expect(scaleTimeout(NODE_TIMER_MAX_MS, 1)).toBe(NODE_TIMER_MAX_MS);
    expect(() => scaleTimeout(NODE_TIMER_MAX_MS, 1.0001)).toThrow(/2147483647/);
    expect(() => scaleTimeout(NODE_TIMER_MAX_MS + 1, 1)).toThrow(/2147483647/);
    expect(() => scaleTimeout(300_000_000, 10)).toThrow(/2147483647/);
  });

  it.each([[0], [0.99], [10.01], [Number.NaN], [Number.POSITIVE_INFINITY], [-3]])('rejects factor %d', (factor) => {
    expect(() => createTimeoutScale(factor)).toThrow(RANGE_PATTERN);
    expect(() => scaleTimeout(1000, factor)).toThrow(RANGE_PATTERN);
  });

  it('keeps the largest runner default times the maximum factor below the Node timer limit', () => {
    const all = Object.values(RUNNER_TIMEOUT_DEFAULTS).flatMap((group) => Object.values(group));
    const largest = Math.max(...all);
    expect(largest).toBeGreaterThanOrEqual(RUNNER_TIMEOUT_DEFAULTS.installer.testTimeout);
    expect(RUNNER_TIMEOUT_DEFAULTS.installer.testTimeout).toBe(900_000);
    expect(900_000 * TIMEOUT_SCALE_MAX).toBeLessThan(NODE_TIMER_MAX_MS);
    expect(largest * TIMEOUT_SCALE_MAX).toBeLessThan(NODE_TIMER_MAX_MS);
    for (const ms of all) expect(() => scaleTimeout(ms, TIMEOUT_SCALE_MAX)).not.toThrow();
  });
});

describe('resolveRunnerTimeoutScale', () => {
  function harness(env: Record<string, string | undefined>, pid = 100, ppid = 1) {
    const lines: string[] = [];
    const store: Record<symbol, unknown> = {};
    const resolve = (runner = 'vitest') =>
      resolveRunnerTimeoutScale(runner, { env, store, pid, ppid, write: (line) => lines.push(line) });
    return { lines, store, resolve, env };
  }

  it('is silent and returns factor 1 when the variable is unset', () => {
    const h = harness({});
    expect(h.resolve().factor).toBe(1);
    expect(h.lines).toEqual([]);
    expect(h.env[TIMEOUT_SCALE_ANNOUNCED_ENV]).toBeUndefined();
  });

  it('is silent for an explicit 1', () => {
    const h = harness({ [TIMEOUT_SCALE_ENV]: '1.0' });
    expect(h.resolve().factor).toBe(1);
    expect(h.lines).toEqual([]);
  });

  it('prints exactly one line with the active factor, and nothing from the environment', () => {
    const h = harness({ [TIMEOUT_SCALE_ENV]: '3', SOME_TOKEN: 'super-secret-token-value' });
    expect(h.resolve('vitest').scaled(5000)).toBe(15_000);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/NOODARA_TEST_TIMEOUT_SCALE=3/);
    expect(h.lines[0]).toMatch(/not CI/i);
    expect(h.lines[0]).not.toContain('super-secret-token-value');
    expect(h.lines[0]).not.toContain('\n');
  });

  it('resolves once per process: later env changes and repeat config loads reuse the first factor', () => {
    const h = harness({ [TIMEOUT_SCALE_ENV]: '3' });
    expect(h.resolve().factor).toBe(3);
    h.env[TIMEOUT_SCALE_ENV] = '7';
    expect(h.resolve().factor).toBe(3);
    h.env[TIMEOUT_SCALE_ENV] = 'garbage';
    expect(h.resolve().factor).toBe(3);
    expect(h.lines).toHaveLength(1);
  });

  it('does not reprint in a worker forked by the announcing runner (env marker carries the runner pid)', () => {
    const env: Record<string, string | undefined> = { [TIMEOUT_SCALE_ENV]: '2' };
    const main = harness(env, 4242, 1);
    expect(main.resolve('playwright').factor).toBe(2);
    expect(main.lines).toHaveLength(1);
    expect(env[TIMEOUT_SCALE_ANNOUNCED_ENV]).toBe('4242');

    const workerEnv = { ...env };
    const worker = harness(workerEnv, 5000, 4242);
    expect(worker.resolve('playwright').factor).toBe(2);
    expect(worker.lines).toEqual([]);
  });

  it('still announces in an unrelated runner that inherited a stale marker', () => {
    const h = harness({ [TIMEOUT_SCALE_ENV]: '2', [TIMEOUT_SCALE_ANNOUNCED_ENV]: '999' }, 7000, 6999);
    h.resolve();
    expect(h.lines).toHaveLength(1);
    expect(h.env[TIMEOUT_SCALE_ANNOUNCED_ENV]).toBe('7000');
  });

  it('throws on an invalid value and never caches it', () => {
    const h = harness({ [TIMEOUT_SCALE_ENV]: '0' });
    expect(() => h.resolve()).toThrow(RANGE_PATTERN);
    expect(Object.getOwnPropertySymbols(h.store)).toHaveLength(0);
    expect(h.lines).toEqual([]);
  });

  it('gives the same factor in a real child process and prints the line only in the parent', () => {
    const moduleUrl = pathToFileURL(path.resolve('tests/support/timeout-scale.ts')).href;
    const script = `
      import { spawnSync } from 'node:child_process';
      const { resolveRunnerTimeoutScale } = await import(${JSON.stringify(moduleUrl)});
      const role = process.argv[1];
      const scale = resolveRunnerTimeoutScale('probe');
      process.stdout.write(role + ':' + scale.factor + ':' + scale.scaled(60000) + '\\n');
      if (role === 'main') {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', process.argv[2], 'worker', process.argv[2]], { encoding: 'utf8' });
        process.stdout.write(child.stdout);
        process.stderr.write(child.stderr);
      }
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, [TIMEOUT_SCALE_ENV]: '2.5' };
    delete env[TIMEOUT_SCALE_ANNOUNCED_ENV];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, 'main', script], {
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['main:2.5:150000', 'worker:2.5:150000']);
    const announced = result.stderr.split('\n').filter((line) => line.includes(TIMEOUT_SCALE_ENV));
    expect(announced).toHaveLength(1);
  });
});
