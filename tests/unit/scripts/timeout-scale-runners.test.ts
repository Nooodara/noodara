// 36-01 (QA-25): every runner-level timeout default is derived from tests/support/timeout-scale.ts.
// With NOODARA_TEST_TIMEOUT_SCALE unset the resolved values must be exactly the historical ones;
// with a valid factor they scale; with an invalid value every config fails at load time, before
// any test, global setup, container or port is touched. CI never sets the variable, and product
// code never reads it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TIMEOUT_SCALE_ANNOUNCED_ENV,
  TIMEOUT_SCALE_CACHE_KEY,
  TIMEOUT_SCALE_ENV,
  TIMEOUT_SCALE_PROVIDE_KEY,
} from '../../support/timeout-scale.js';

interface VitestTimeouts {
  testTimeout?: number;
  hookTimeout?: number;
}

interface LoadedVitestConfig {
  test?: VitestTimeouts & {
    retry?: number;
    fileParallelism?: boolean;
    pool?: string;
    maxWorkers?: number;
    projects?: { test?: VitestTimeouts & { provide?: Record<string, unknown> } }[];
    provide?: Record<string, unknown>;
  };
}

interface LoadedPlaywrightConfig {
  timeout?: number;
  expect?: { timeout?: number };
  retries?: number;
  workers?: number;
  fullyParallel?: boolean;
}

const loaders = {
  unit: () => import('../../../vitest.config.js'),
  integration: () => import('../../../vitest.integration.config.js'),
  installer: () => import('../../../vitest.installer.config.js'),
  stateMachine: () => import('../../../vitest.state-machine.config.js'),
  aiEvals: () => import('../../../vitest.ai-evals.config.js'),
  playwright: () => import('../../../playwright.config.js'),
} as const;

type RunnerName = keyof typeof loaders;

const RUNNERS = Object.keys(loaders) as RunnerName[];

let stderrLines: string[] = [];

function clearProcessCache(): void {
  delete (globalThis as Record<symbol, unknown>)[TIMEOUT_SCALE_CACHE_KEY];
}

async function load(runner: RunnerName, scale: string | undefined): Promise<unknown> {
  clearProcessCache();
  vi.resetModules();
  vi.stubEnv(TIMEOUT_SCALE_ENV, scale);
  vi.stubEnv(TIMEOUT_SCALE_ANNOUNCED_ENV, undefined);
  vi.stubEnv('NOODARA_AI_EVAL_LIVE', undefined);
  const mod = (await loaders[runner]()) as { default: unknown };
  return mod.default;
}

function vitestTimeouts(config: unknown): { testTimeout: number | undefined; hookTimeout: number | undefined } {
  const test = (config as LoadedVitestConfig).test;
  return { testTimeout: test?.testTimeout, hookTimeout: test?.hookTimeout };
}

function playwrightTimeouts(config: unknown): { timeout: number | undefined; expectTimeout: number | undefined } {
  const pw = config as LoadedPlaywrightConfig;
  return { timeout: pw.timeout, expectTimeout: pw.expect?.timeout };
}

beforeEach(() => {
  stderrLines = [];
  const original = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes(TIMEOUT_SCALE_ENV)) {
      stderrLines.push(...text.split('\n').filter((line) => line.length > 0));
      return true;
    }
    return original(chunk, ...(rest as []));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProcessCache();
  vi.resetModules();
});

describe('runner timeout defaults derive from the single timeout-scale module', () => {
  const EXPECTED_VITEST: Record<Exclude<RunnerName, 'playwright'>, { testTimeout: number; hookTimeout: number }> = {
    unit: { testTimeout: 5000, hookTimeout: 10_000 },
    integration: { testTimeout: 120_000, hookTimeout: 120_000 },
    installer: { testTimeout: 900_000, hookTimeout: 900_000 },
    stateMachine: { testTimeout: 5000, hookTimeout: 10_000 },
    aiEvals: { testTimeout: 30_000, hookTimeout: 120_000 },
  };

  describe.each(Object.keys(EXPECTED_VITEST) as (keyof typeof EXPECTED_VITEST)[])('%s', (runner) => {
    it('resolves exactly the historical values with the scale unset, and prints nothing', async () => {
      expect(vitestTimeouts(await load(runner, undefined))).toEqual(EXPECTED_VITEST[runner]);
      expect(stderrLines).toEqual([]);
    });

    it('resolves exactly the historical values with an empty scale', async () => {
      expect(vitestTimeouts(await load(runner, ''))).toEqual(EXPECTED_VITEST[runner]);
    });

    it('multiplies both values by 3 with NOODARA_TEST_TIMEOUT_SCALE=3 and prints one line', async () => {
      const expected = EXPECTED_VITEST[runner];
      expect(vitestTimeouts(await load(runner, '3'))).toEqual({
        testTimeout: expected.testTimeout * 3,
        hookTimeout: expected.hookTimeout * 3,
      });
      expect(stderrLines).toHaveLength(1);
      expect(stderrLines[0]).toContain(`${TIMEOUT_SCALE_ENV}=3`);
    });
  });

  it('unit projects inherit the root timeouts instead of overriding them', async () => {
    const config = (await load('unit', '3')) as LoadedVitestConfig;
    const projects = config.test?.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      expect(project.test?.testTimeout).toBeUndefined();
      expect(project.test?.hookTimeout).toBeUndefined();
    }
  });

  // 36-02: tests inside a workspace package cannot import tests/support (pnpm boundaries), so the
  // root unit config hands them the factor through Vitest `provide`, resolved by the same module.
  it('the unit config provides exactly factor 1 to every project when the scale is unset', async () => {
    const config = (await load('unit', undefined)) as LoadedVitestConfig;
    expect(config.test?.provide).toEqual({ [TIMEOUT_SCALE_PROVIDE_KEY]: 1 });
    for (const project of config.test?.projects ?? []) {
      expect(project.test?.provide).toBeUndefined();
    }
  });

  it('the unit config provides the resolved factor when the scale is set', async () => {
    const config = (await load('unit', '2.5')) as LoadedVitestConfig;
    expect(config.test?.provide).toEqual({ [TIMEOUT_SCALE_PROVIDE_KEY]: 2.5 });
  });

  it('ai-evals live budgets keep their historical 4h values when unscaled', async () => {
    clearProcessCache();
    vi.resetModules();
    vi.stubEnv(TIMEOUT_SCALE_ENV, undefined);
    vi.stubEnv('NOODARA_AI_EVAL_LIVE', '1');
    const mod = (await loaders.aiEvals()) as { default: unknown };
    expect(vitestTimeouts(mod.default)).toEqual({ testTimeout: 4 * 3600_000, hookTimeout: 4 * 3600_000 });
  });

  describe('playwright', () => {
    it('resolves exactly timeout 60000 and expect.timeout 15000 with the scale unset', async () => {
      expect(playwrightTimeouts(await load('playwright', undefined))).toEqual({ timeout: 60_000, expectTimeout: 15_000 });
      expect(stderrLines).toEqual([]);
    });

    it('multiplies both by 3 with NOODARA_TEST_TIMEOUT_SCALE=3 and prints one line', async () => {
      expect(playwrightTimeouts(await load('playwright', '3'))).toEqual({ timeout: 180_000, expectTimeout: 45_000 });
      expect(stderrLines).toHaveLength(1);
    });

    it('keeps retries 0, one worker and no full parallelism', async () => {
      const config = (await load('playwright', '3')) as LoadedPlaywrightConfig;
      expect(config.retries).toBe(0);
      expect(config.workers).toBe(1);
      expect(config.fullyParallel).toBe(false);
    });
  });

  it('keeps integration and installer pools and file parallelism unchanged when scaled', async () => {
    for (const runner of ['integration', 'installer'] as const) {
      const test = ((await load(runner, '3')) as LoadedVitestConfig).test;
      expect(test?.pool).toBe('forks');
      expect(test?.fileParallelism).toBe(false);
      expect(test?.retry).toBeUndefined();
    }
  });
});

describe('an invalid NOODARA_TEST_TIMEOUT_SCALE fails every runner at config-load time', () => {
  describe.each(RUNNERS)('%s', (runner) => {
    it.each(['0', '-2', '0.5', '11', 'NaN', 'Infinity', 'abc', '1e1', '0x2', ' 3 '])('rejects %j', async (raw) => {
      await expect(load(runner, raw)).rejects.toThrow(/NOODARA_TEST_TIMEOUT_SCALE.*\[1, 10\]/);
      expect(stderrLines).toEqual([]);
    });
  });

  it('every runner config resolves the scale at module top level, before exporting the config', () => {
    for (const file of [
      'vitest.config.ts',
      'vitest.integration.config.ts',
      'vitest.installer.config.ts',
      'vitest.state-machine.config.ts',
      'vitest.ai-evals.config.ts',
      'playwright.config.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/from '\.\/tests\/support\/timeout-scale\.js'/);
      expect(source, file).toMatch(/^const timeouts = resolveRunnerTimeoutScale\(/m);
      const resolveAt = source.search(/^const timeouts = resolveRunnerTimeoutScale\(/m);
      expect(resolveAt, file).toBeLessThan(source.indexOf('export default'));
      // No literal runner-level timeout survives outside the shared module.
      expect(source, file).not.toMatch(/(testTimeout|hookTimeout|timeout):\s*[\d_]+\s*[,}]/);
    }
  });
});

describe('CI budgets stay unscaled', () => {
  it('no workflow under .github/workflows sets NOODARA_TEST_TIMEOUT_SCALE', () => {
    const dir = '.github/workflows';
    const files = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile());
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((name) => /\.ya?ml$/.test(name))).toBe(true);
    for (const name of files) {
      const source = readFileSync(path.join(dir, name), 'utf8');
      expect(source.includes(TIMEOUT_SCALE_ENV), `${name} must not set ${TIMEOUT_SCALE_ENV}`).toBe(false);
      expect(/TIMEOUT_SCALE/i.test(source), `${name} must not reference a timeout scale`).toBe(false);
    }
  });
});

describe('the timeout scale is test-only', () => {
  function walk(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(c|m)?(t|j)sx?$/.test(entry.name) && !/\.(test|spec)\.(c|m)?(t|j)sx?$/.test(entry.name)) out.push(full);
    }
  }

  function productionSources(): string[] {
    const out: string[] = [];
    for (const root of ['apps', 'packages']) {
      for (const workspace of readdirSync(root, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue;
        const src = path.join(root, workspace.name, 'src');
        try {
          if (statSync(src).isDirectory()) walk(src, out);
        } catch {
          // A workspace without src/ has no production source to scan.
        }
      }
    }
    return out;
  }

  it('no production source under apps/*/src or packages/*/src imports the module or reads the variable', () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes(TIMEOUT_SCALE_ENV) || /timeout-scale(\.js|\.ts)?['"]/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  function workspaceTestFiles(): string[] {
    const out: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (/\.(test|spec)\.(c|m)?(t|j)sx?$/.test(entry.name)) out.push(full);
      }
    };
    for (const root of ['apps', 'packages']) {
      for (const workspace of readdirSync(root, { withFileTypes: true })) {
        const src = path.join(root, workspace.name, 'src');
        if (workspace.isDirectory() && statSync(src, { throwIfNoEntry: false })?.isDirectory()) visit(src);
      }
    }
    return out;
  }

  it('workspace tests read the factor through inject, never by importing tests/support (pnpm boundaries)', () => {
    const files = workspaceTestFiles();
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => /['"][./]*tests\/support\//.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
    const injecting = files.filter((file) => readFileSync(file, 'utf8').includes(`inject('${TIMEOUT_SCALE_PROVIDE_KEY}')`));
    // Each injecting test declares the same ProvidedContext key (it cannot import the shared one).
    for (const file of injecting) {
      expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`interface ProvidedContext \\{\\s*${TIMEOUT_SCALE_PROVIDE_KEY}: number;`));
    }
    expect(injecting.map((file) => path.relative('.', file).split(path.sep).join('/'))).toContain(
      'apps/control-plane/src/services/legacy-log-redactor.test.ts',
    );
  });
});
