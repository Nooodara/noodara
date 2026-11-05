// 29-04: the AI eval baseline policy (scripts/ai-baseline-check.mjs) and its CI/nightly wiring.
// Workflow checks are static reads of the real files, same job-block regex as
// tests/unit/scripts/proxy-workflows.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BASELINE_PATH,
  MIN_SCENARIOS,
  baselineUpdateProblems,
  cassetteDirs,
  cassetteProblems,
  envProblems,
  justificationPath,
  metricRegressions,
  replayProblems,
  updateCheck,
} from '../../scripts/ai-baseline-check.mjs';

const SCRIPT = join(import.meta.dirname, '../../scripts/ai-baseline-check.mjs');

const METRICS = {
  scenarios: 65,
  entitySelection: 0.96,
  evidenceGrounding: 1,
  diagnosisAccuracy: 0.97,
  hallucinatedResources: 0,
  secretLeakage: 0,
  unauthorizedWrites: 0,
};

type Metrics = Record<string, number>;

function live(metrics: Metrics = METRICS, digest = 'a'.repeat(64)) {
  return {
    schemaVersion: 1,
    source: 'live',
    provider: 'anthropic',
    model: 'claude-test',
    datasetVersion: '1.0.0',
    date: '2026-11-05',
    temperature: null,
    metrics,
    thresholdFailures: [],
    cassetteDigest: digest,
  };
}

const NONE = { schemaVersion: 1, source: 'none', note: 'no key' };

const JUSTIFICATION =
  'diagnosisAccuracy dropped because the pinned model was upgraded and now answers two ambiguous ' +
  'crash-loop scenarios with the restart diagnosis; the dataset labels are under review in a follow-up.';

describe('metricRegressions', () => {
  it('flags a drop in a higher-is-better metric and a rise in a lower-is-better one', () => {
    const after = { ...METRICS, entitySelection: 0.95, hallucinatedResources: 0.004 };
    expect(metricRegressions(METRICS, after).map((r: { metric: string; reason: string }) => [r.metric, r.reason])).toEqual([
      ['entitySelection', 'dropped'],
      ['hallucinatedResources', 'rose'],
    ]);
  });

  it('accepts equal or better metrics, including a new metric with a known direction', () => {
    const { evidenceGrounding: _dropped, ...older } = METRICS;
    expect(metricRegressions(older, { ...METRICS, diagnosisAccuracy: 1, scenarios: 70 })).toEqual([]);
    expect(metricRegressions(METRICS, METRICS)).toEqual([]);
  });

  it('counts fewer scenarios, a removed metric and an unranked metric as regressions', () => {
    const { secretLeakage: _removed, ...after } = { ...METRICS, scenarios: 49 };
    const problems = metricRegressions({ ...METRICS, brandNew: 1 }, after).map((r: { metric: string; reason: string }) => `${r.metric} ${r.reason}`);
    expect(problems).toEqual(['scenarios dropped', 'secretLeakage was removed', 'brandNew has no direction in METRIC_DIRECTIONS']);
  });
});

describe('baselineUpdateProblems (A3)', () => {
  const none = () => null;

  it('has nothing to compare without a live baseline at the base revision', () => {
    expect(baselineUpdateProblems(null, live({ ...METRICS, entitySelection: 0 }), none)).toEqual([]);
    expect(baselineUpdateProblems(NONE, live({ ...METRICS, entitySelection: 0 }), none)).toEqual([]);
  });

  it('accepts an unchanged or improved baseline without a justification', () => {
    expect(baselineUpdateProblems(live(), live(METRICS, 'b'.repeat(64)), none)).toEqual([]);
    expect(baselineUpdateProblems(live(), live({ ...METRICS, entitySelection: 0.99 }), none)).toEqual([]);
  });

  it('refuses dropping the live baseline back to source none', () => {
    expect(baselineUpdateProblems(live(), NONE, none)).toEqual([
      'baseline.json drops the live baseline from 2026-11-05; re-record it live instead',
    ]);
  });

  it('refuses a lowered metric without a justification keyed by the new cassette digest', () => {
    const digest = 'c'.repeat(64);
    const asked: string[] = [];
    const problems = baselineUpdateProblems(live(), live({ ...METRICS, diagnosisAccuracy: 0.92 }, digest), (path: string) => {
      asked.push(path);
      return null;
    });
    expect(asked).toEqual([`tests/ai/evals/baseline-justifications/${digest}.md`]);
    expect(problems).toEqual([`baseline.json lowers diagnosisAccuracy dropped (0.97 -> 0.92); add ${justificationPath(digest)} explaining why`]);
  });

  it('refuses a justification that skips a lowered metric or explains nothing', () => {
    const head = live({ ...METRICS, diagnosisAccuracy: 0.92, unauthorizedWrites: 1 });
    expect(baselineUpdateProblems(live(), head, () => JUSTIFICATION)).toEqual([
      `${justificationPath(head.cassetteDigest)} does not name unauthorizedWrites`,
    ]);
    expect(baselineUpdateProblems(live(), head, () => 'diagnosisAccuracy unauthorizedWrites: model change')).toEqual([
      `${justificationPath(head.cassetteDigest)} needs at least 20 words of explanation, has 4`,
    ]);
  });

  it('accepts a lowered metric the change justifies', () => {
    expect(baselineUpdateProblems(live(), live({ ...METRICS, diagnosisAccuracy: 0.92 }), () => JUSTIFICATION)).toEqual([]);
  });
});

describe('replayProblems (A1)', () => {
  const report = (metrics: Metrics = METRICS, extra: Partial<{ thresholdFailures: string[]; scenarios: unknown[] }> = {}) => ({
    metrics,
    thresholdFailures: extra.thresholdFailures ?? [],
    scenarios: extra.scenarios ?? [{ id: 'ok', miss: null, error: null }],
  });

  it('passes a replay that matches the baseline', () => {
    expect(replayProblems(live(), report())).toEqual([]);
  });

  it('fails when a replayed metric is worse than baseline.json, even above the thresholds', () => {
    expect(replayProblems(live(), report({ ...METRICS, entitySelection: 0.955 }))).toEqual([
      'below baseline.json: entitySelection dropped (0.96 -> 0.955)',
    ]);
  });

  it('fails under a threshold, on a miss, on a crash and with fewer than 50 scenarios', () => {
    const problems = replayProblems(
      live({ ...METRICS, scenarios: 10 }),
      report(
        { ...METRICS, scenarios: 10 },
        {
          thresholdFailures: ['entity selection 80.0% < 95.0%'],
          scenarios: [
            { id: 'miss-1', miss: { turn: 1, key: 'k' }, error: null },
            { id: 'boom', miss: null, error: 'provider_error' },
          ],
        },
      ),
    );
    expect(problems).toEqual([
      '1 cassette miss(es): miss-1',
      'boom crashed: provider_error',
      `only 10 scenarios replayed, needs ${MIN_SCENARIOS}+`,
      'threshold: entity selection 80.0% < 95.0%',
    ]);
  });

  it('fails without a live baseline to compare against', () => {
    expect(replayProblems(NONE, report())).toEqual(['baseline.json has no live run to compare against']);
  });
});

describe('envProblems (H1)', () => {
  it('accepts a replay environment', () => {
    expect(envProblems({ PATH: '/usr/bin', ANTHROPIC_API_KEY: '' })).toEqual([]);
  });

  it('requires NOODARA_AI_EVAL_LIVE to be unset, not merely empty, and no provider key', () => {
    expect(envProblems({ NOODARA_AI_EVAL_LIVE: '' })).toEqual(['NOODARA_AI_EVAL_LIVE must be unset in the replay job']);
    expect(envProblems({ NOODARA_AI_EVAL_LIVE: '1', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', NOODARA_AI_EVAL_API_KEY: 'k' })).toEqual([
      'NOODARA_AI_EVAL_LIVE must be unset in the replay job',
      'ANTHROPIC_API_KEY must not reach the replay job',
      'OPENAI_API_KEY must not reach the replay job',
      'NOODARA_AI_EVAL_API_KEY must not reach the replay job',
    ]);
  });
});

// ---- real git repositories ------------------------------------------------------------------------

describe('against a git repository', () => {
  let root: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@noodara.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message: string) => {
    git('add', '--', '.');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const seedCassettes = (count = MIN_SCENARIOS) => {
    const [scenarios, adversarial] = cassetteDirs() as [{ dir: string }, { dir: string }];
    for (let index = 0; index < count; index += 1) write(`${scenarios.dir}/s-${index}.json`, '{}\n');
    write(`${adversarial.dir}/adv-1.json`, '{}\n');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-baseline-check-'));
    git('init', '-q');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('cassetteProblems (H1)', () => {
    it('accepts committed cassette directories', () => {
      seedCassettes();
      write(BASELINE_PATH, `${JSON.stringify(live())}\n`);
      commit('seed');
      expect(cassetteProblems(root)).toEqual([]);
      expect(cli('guard').status).toBe(0);
    });

    it('fails when a cassette directory is missing or holds too few recordings', () => {
      write(`${cassetteDirs()[0]?.dir ?? ''}/s-1.json`, '{}\n');
      commit('one cassette');
      expect(cassetteProblems(root)).toEqual([
        `tests/ai/evals/cassettes/anthropic/scenarios has 1 committed cassette(s), needs at least ${MIN_SCENARIOS}`,
        'tests/ai/evals/adversarial/cassettes/anthropic/scenarios is missing',
      ]);
    });

    it('fails on uncommitted, modified or git-ignored cassettes and baseline', () => {
      seedCassettes();
      write(BASELINE_PATH, `${JSON.stringify(live())}\n`);
      commit('seed');
      write('tests/ai/evals/cassettes/anthropic/scenarios/s-0.json', '{"changed":true}\n');
      write('tests/ai/evals/adversarial/cassettes/anthropic/scenarios/adv-2.json', '{}\n');
      write('.gitignore', 'ignored-*.json\n');
      write('tests/ai/evals/cassettes/anthropic/scenarios/ignored-1.json', '{}\n');
      expect(cassetteProblems(root)).toEqual([
        'uncommitted: M tests/ai/evals/cassettes/anthropic/scenarios/s-0.json',
        'uncommitted: ?? tests/ai/evals/adversarial/cassettes/anthropic/scenarios/adv-2.json',
        'ignored, never committed: tests/ai/evals/cassettes/anthropic/scenarios/ignored-1.json',
      ]);
    });

    it('guard fails with NOODARA_AI_EVAL_LIVE set or a provider key in the environment', () => {
      seedCassettes();
      commit('seed');
      const run = (env: Record<string, string>) =>
        spawnSync(process.execPath, [SCRIPT, 'guard', '--root', root], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
      expect(run({}).status).toBe(0);
      const withLive = run({ NOODARA_AI_EVAL_LIVE: '0' });
      expect(withLive.status).toBe(1);
      expect(withLive.stderr).toContain('NOODARA_AI_EVAL_LIVE must be unset');
      expect(run({ ANTHROPIC_API_KEY: 'sk-test' }).stderr).toContain('ANTHROPIC_API_KEY must not reach the replay job');
    });
  });

  describe('updateCheck (A3)', () => {
    it('refuses a lowered baseline until the change carries its justification', () => {
      write(BASELINE_PATH, `${JSON.stringify(live())}\n`);
      const base = commit('baseline');
      const digest = 'd'.repeat(64);
      write(BASELINE_PATH, `${JSON.stringify(live({ ...METRICS, diagnosisAccuracy: 0.91 }, digest))}\n`);

      expect(updateCheck(root, base).problems).toEqual([
        `baseline.json lowers diagnosisAccuracy dropped (0.97 -> 0.91); add ${justificationPath(digest)} explaining why`,
      ]);
      const refused = cli('update', '--base', base);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('lowers diagnosisAccuracy');

      write(justificationPath(digest), `${JUSTIFICATION}\n`);
      expect(updateCheck(root, base).problems).toEqual([]);
      expect(cli('update', '--base', base).status).toBe(0);
    });

    it('has nothing to compare for a first baseline, a zero base or a base without baseline.json', () => {
      write('README.md', 'x\n');
      const base = commit('no baseline');
      write(BASELINE_PATH, `${JSON.stringify(live())}\n`);
      expect(updateCheck(root, base).problems).toEqual([]);
      expect(updateCheck(root, '0'.repeat(40)).problems).toEqual([]);
    });

    it('fails on a base revision the clone does not have, or an invalid baseline', () => {
      write(BASELINE_PATH, '{"source":"live"}\n');
      const base = commit('broken');
      expect(() => updateCheck(root, 'f'.repeat(40))).toThrow(/not in this clone/);
      expect(() => updateCheck(root, base)).toThrow(/neither a live baseline/);
      const result = cli('update', '--base', 'f'.repeat(40));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fetch-depth: 0');
    });

    it('requires --base and a known command', () => {
      expect(cli('update').stderr).toContain('update needs --base');
      expect(cli('nope').status).toBe(1);
    });
  });
});

describe('replay against the committed cassettes and baseline.json (A1)', () => {
  it('replays 50+ scenarios with no metric below the baseline', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'replay'], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 120_000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/replay: ok \((\d+) scenarios replayed\)/);
    expect(Number(/\((\d+) scenarios/.exec(result.stdout)?.[1])).toBeGreaterThanOrEqual(MIN_SCENARIOS);
  }, 120_000);
});

// ---- workflows ------------------------------------------------------------------------------------

function jobBlock(file: string, job: string): string {
  const source = readFileSync(file, 'utf8');
  const match = source.match(new RegExp(`\\n {2}${job}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z0-9_-]*:\\n|$)`));
  expect(match, `${job} job not found in ${file}`).toBeTruthy();
  return match?.[1] ?? '';
}

const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const CI = '.github/workflows/ci.yml';
const NIGHTLY = '.github/workflows/nightly.yml';
const PROVIDER_KEYS = /ANTHROPIC_API_KEY|OPENAI_API_KEY|NOODARA_AI_EVAL_API_KEY/;

describe('ci.yml ai-evals job (A1, A3, H1)', () => {
  const block = () => withoutComments(jobBlock(CI, 'ai-evals'));

  it('runs on every pull request with no job-level condition', () => {
    expect(readFileSync(CI, 'utf8')).toMatch(/\non:\n {2}pull_request:\n/);
    expect(block()).not.toMatch(/^ {4}if:/m);
  });

  it('guards, replays the scenarios and the adversarial set, compares with the baseline, then guards again', () => {
    const steps = block();
    const order = [
      'run: node scripts/ai-baseline-check.mjs guard',
      'run: pnpm test:ai-evals',
      'run: node scripts/ai-baseline-check.mjs replay',
      'run: node scripts/ai-baseline-check.mjs update --base "$BASE_SHA"',
    ].map((step) => steps.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(steps.lastIndexOf('run: node scripts/ai-baseline-check.mjs guard')).toBeGreaterThan(order[3] ?? Infinity);
    expect(steps).toContain('github.event.pull_request.base.sha || github.event.before');
    expect(steps).toContain('fetch-depth: 0');
  });

  it('pnpm test:ai-evals covers the adversarial suite', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:ai-evals']).toBe('vitest run --config vitest.ai-evals.config.ts');
    expect(readFileSync('vitest.ai-evals.config.ts', 'utf8')).toContain("include: ['tests/ai/evals/**/*.test.ts']");
    expect(readFileSync('tests/ai/evals/adversarial/adversarial.test.ts', 'utf8').length).toBeGreaterThan(0);
  });

  it('gets no provider secret and never turns live mode on, on any job', () => {
    expect(block()).not.toContain('secrets.');
    expect(block()).toMatch(/permissions:\n {6}contents: read\n {4}steps:/);
    const ci = withoutComments(readFileSync(CI, 'utf8'));
    expect(ci).not.toMatch(PROVIDER_KEYS);
    expect(ci).not.toMatch(/NOODARA_AI_EVAL_LIVE\s*[:=]/);
  });
});

describe('ci.yml state-machine job (H2)', () => {
  it('runs pnpm test:state-machine on every pull request', () => {
    const block = withoutComments(jobBlock(CI, 'state-machine'));
    expect(block).toContain('run: pnpm test:state-machine');
    expect(block).not.toMatch(/^ {4}if:/m);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:state-machine']).toBe('vitest run --config vitest.state-machine.config.ts --coverage');
    expect(readFileSync('vitest.state-machine.config.ts', 'utf8')).toMatch(/branches: 100/);
  });
});

describe('nightly.yml ai-evals-live job (A2, H1)', () => {
  const block = () => withoutComments(jobBlock(NIGHTLY, 'ai-evals-live'));

  it('is the only place any workflow references the provider key', () => {
    for (const file of ['ci.yml', 'nightly.yml', 'release.yml', 'public-site.yml']) {
      const source = withoutComments(readFileSync(`.github/workflows/${file}`, 'utf8'));
      const outside = file === 'nightly.yml' ? source.replace(block(), '') : source;
      expect(outside, file).not.toMatch(PROVIDER_KEYS);
    }
    // In the job: the configured flag and the live step's env, nowhere else.
    expect(block().match(/secrets\.ANTHROPIC_API_KEY/g)).toHaveLength(2);
    expect(block()).toContain("PROVIDER_KEY_CONFIGURED: ${{ secrets.ANTHROPIC_API_KEY != '' }}");
    expect(block()).toMatch(/env:\n {10}NOODARA_AI_EVAL_LIVE: '1'\n {10}ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}\n {8}run: pnpm test:ai-evals\n/);
  });

  it('records an explicit skip with the reason when the key is not configured', () => {
    const steps = block();
    expect(steps).toMatch(/if: env\.PROVIDER_KEY_CONFIGURED != 'true'\n {8}run: \|/);
    expect(steps).toContain('::notice title=ai-evals-live skipped::');
    expect(steps).toContain('GITHUB_STEP_SUMMARY');
    expect(steps).toContain('secret is not configured');
    // Every other step only runs when the key is there.
    const ifs = steps.match(/if: .*$/gm) ?? [];
    expect(ifs.filter((line) => line.includes("PROVIDER_KEY_CONFIGURED == 'true'"))).toHaveLength(ifs.length - 1);
  });

  it('can never commit, push or open a pull request with a new baseline', () => {
    const steps = block();
    expect(steps).toMatch(/permissions:\n {6}contents: read\n {4}env:/);
    expect(steps).not.toMatch(/: write\b/);
    expect(steps).toContain('persist-credentials: false');
    expect(steps).not.toMatch(/git (push|commit)|gh pr|create-pull-request/);
  });

  it('compares the live baseline with the committed one and keeps the run as an artifact', () => {
    const steps = block();
    expect(steps).toMatch(/if: always\(\) && env\.PROVIDER_KEY_CONFIGURED == 'true'\n {8}run: node scripts\/ai-baseline-check\.mjs update --base HEAD/);
    expect(steps).toContain('name: ai-evals-live');
  });
});
