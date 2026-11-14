// 36-03 A1/A4/H7: the contributor path. `pnpm verify` stays Docker-free and complete, the global
// setups run the tier preflight before anything else, and CONTRIBUTING.md / the CLAUDE.md commands
// table cannot drift from package.json scripts or the variables the code reads.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runE2eGlobalSetup } from '../../e2e/global-setup.js';
import { runIntegrationGlobalSetup, type IntegrationGlobalSetupDeps } from '../../integration/global-setup.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const scripts = pkg.scripts;

/** Commands that need a Docker daemon, a browser stack or a free port. */
const DOCKER_BACKED = /vitest\.(integration|installer|ai-evals)\.config|playwright|testcontainers|\bdocker\b|test:(e2e|integration|installer|boot)|security:scan-leaks/;

describe('pnpm verify (A1)', () => {
  it('runs lint, typecheck, unit tests and boundaries in order and stops at the first failure', () => {
    // `&&` short-circuits and the chain exits with the failing step's own exit code.
    expect(scripts.verify).toBe('pnpm lint && pnpm typecheck && pnpm test && pnpm boundaries');
  });

  it('every step is Docker-free and needs no pre-built output', () => {
    const steps = (scripts.verify ?? '').split('&&').map((s) => s.trim());
    for (const step of steps) {
      const name = /^pnpm (\S+)$/.exec(step)?.[1];
      expect(name, step).toBeDefined();
      const body = scripts[name as string];
      expect(body, `script ${String(name)}`).toBeDefined();
      expect(body).not.toMatch(DOCKER_BACKED);
      expect(body).not.toMatch(/--config/);
    }
  });

  it('exposes the read-only doctor', () => {
    expect(scripts['test:doctor']).toBe('node scripts/test-preflight.mjs');
  });
});

describe('global setups fail fast on missing tier prerequisites (A4)', () => {
  function integrationDeps(order: string[], preflightError?: Error): IntegrationGlobalSetupDeps {
    const step = (name: string, value?: unknown) => vi.fn(() => {
      order.push(name);
      return value;
    });
    return {
      preflight: vi.fn(() => {
        order.push('preflight');
        return preflightError === undefined ? Promise.resolve() : Promise.reject(preflightError);
      }),
      checkPort: step('checkPort', Promise.resolve({ success: true, port: 3000 })) as never,
      assertNoTestResources: step('assertNoTestResources', Promise.resolve()) as never,
      snapshotTestResources: step('snapshot', Promise.resolve({ containers: [], networks: [], volumes: [] })) as never,
      buildWorkspace: step('build') as never,
      assertNoLeakedTestResources: step('leakCheck', Promise.resolve()) as never,
      exit: vi.fn(() => {
        throw new Error('exit');
      }) as never,
    };
  }

  it('integration: a failed preflight touches no port, container or build', async () => {
    const order: string[] = [];
    const failure = new Error('PRECHECK FAILURE: 1 hard prerequisite(s) of the integration tier missing');
    await expect(runIntegrationGlobalSetup(integrationDeps(order, failure))).rejects.toBe(failure);
    expect(order).toEqual(['preflight']);
  });

  it('integration: the existing prechecks keep their order after the preflight', async () => {
    const order: string[] = [];
    const teardown = await runIntegrationGlobalSetup(integrationDeps(order));
    expect(order).toEqual(['preflight', 'checkPort', 'assertNoTestResources', 'snapshot', 'build']);
    await teardown();
    expect(order.at(-1)).toBe('leakCheck');
  });

  it('integration: the port 3000 precheck keeps its wording', () => {
    const source = readFileSync(path.join(ROOT, 'tests/integration/global-setup.ts'), 'utf8');
    expect(source).toContain("console.error('PRECHECK FAILURE: Port 3000 is unavailable');");
    expect(source).toContain("console.error('To skip this check, set: NOODARA_TEST_PORT_OVERRIDE=<alternative-port>');");
    expect(source).toContain("deps.assertNoTestResources('vitest globalSetup')");
  });

  it('e2e: a failed preflight starts nothing', async () => {
    const startRun = vi.fn(() => Promise.resolve());
    const failure = new Error('PRECHECK FAILURE');
    await expect(runE2eGlobalSetup({ preflight: () => Promise.reject(failure), startRun })).rejects.toBe(failure);
    expect(startRun).not.toHaveBeenCalled();
    const order: string[] = [];
    await runE2eGlobalSetup({
      preflight: () => Promise.resolve(void order.push('preflight')),
      startRun: () => Promise.resolve(void order.push('startRun')),
    });
    expect(order).toEqual(['preflight', 'startRun']);
  });

  it('both setups delegate to the shared preflight library', () => {
    for (const file of ['tests/integration/global-setup.ts', 'tests/e2e/global-setup.ts']) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      expect(source).toContain("'../../scripts/test-preflight-lib.mjs'");
      expect(source).toContain('assertTierPrerequisites(');
    }
  });
});

const PNPM_BUILTINS = new Set(['install', 'exec', 'dlx', 'add', 'run', 'why', 'store']);

function pnpmScriptsNamed(text: string): string[] {
  return [...text.matchAll(/(?<![\w-])pnpm\s+([a-z][\w:-]*)/g)].map((m) => m[1] as string).filter((n) => !PNPM_BUILTINS.has(n));
}

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'unit') return [];
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return codeFiles(full);
    return /\.(ts|mts|mjs|js)$/.test(entry) ? [full] : [];
  });
}

describe('docs accuracy (H7)', () => {
  const contributing = readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');

  it('every pnpm script in CONTRIBUTING.md exists', () => {
    const named = pnpmScriptsNamed(contributing);
    expect(named).toEqual(expect.arrayContaining(['verify', 'test:doctor']));
    for (const name of named) expect(Object.keys(scripts), `pnpm ${name}`).toContain(name);
  });

  // CLAUDE.md is git-ignored: it exists in a maintainer's working copy but never in a clean
  // checkout (CI, a contributor's clone), where there is no commands table to keep accurate.
  const claudePath = path.join(ROOT, 'CLAUDE.md');
  let claudePresent = true;
  try { readFileSync(claudePath); } catch { claudePresent = false; }
  it.skipIf(!claudePresent)('every pnpm script in the CLAUDE.md commands table exists, including verify and test:doctor', () => {
    const claude = readFileSync(claudePath, 'utf8');
    const table = /### 3\.2 Comandos[\s\S]*?```bash\n([\s\S]*?)```/.exec(claude)?.[1];
    expect(table).toBeDefined();
    const named = pnpmScriptsNamed(table as string);
    expect(named).toEqual(expect.arrayContaining(['verify', 'test:doctor']));
    for (const name of named) expect(Object.keys(scripts), `pnpm ${name}`).toContain(name);
  });

  it('every NOODARA_TEST_* / NOODARA_E2E_* variable in CONTRIBUTING.md is read by the code', () => {
    const vars = [...new Set([...contributing.matchAll(/\bNOODARA_(?:TEST|E2E)_[A-Z0-9_]+/g)].map((m) => m[0]))];
    expect(vars).toEqual(expect.arrayContaining(['NOODARA_TEST_TIMEOUT_SCALE', 'NOODARA_TEST_PORT_OVERRIDE', 'NOODARA_E2E_WEB_PORT', 'NOODARA_E2E_API_PORT']));
    const code = [
      ...codeFiles(path.join(ROOT, 'tests')),
      ...codeFiles(path.join(ROOT, 'scripts')),
      path.join(ROOT, 'playwright.config.ts'),
    ]
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const v of vars) expect(code, v).toMatch(new RegExp(`\\b${v}\\b`));
  });

  it('documents the doctor exit codes', () => {
    expect(contributing).toMatch(/`0`[^\n]*ok/i);
    expect(contributing).toMatch(/`1`[^\n]*hard prerequisite/i);
    expect(contributing).toMatch(/`2`[^\n]*usage/i);
  });

  it('README links to CONTRIBUTING.md', () => {
    expect(readFileSync(path.join(ROOT, 'README.md'), 'utf8')).toMatch(/\]\(\.?\/?CONTRIBUTING\.md\)/);
  });
});
