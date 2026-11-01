// 22-06 (A2): the proxy/TLS contract suites need the sshd + dockerd fixture with Traefik and
// Pebble, so ci.yml skips tests/integration/proxy (like deploy-engine) and nightly.yml runs it on
// both Ubuntu versions with the noodara.test leak checks. tests/integration/domains is DB-only and
// stays in the CI integration run. Static reads of the real workflow files, same job-block regex
// as vitest-gate-config.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function jobBlock(file: string, job: string): string {
  const source = readFileSync(file, 'utf8');
  const match = source.match(
    new RegExp(`\\n {2}${job}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z0-9_-]*:\\n|$)`),
  );
  expect(match, `${job} job not found in ${file}`).toBeTruthy();
  return match?.[1] ?? '';
}

describe('.github/workflows/nightly.yml runs the proxy suites', () => {
  const block = (): string => jobBlock('.github/workflows/nightly.yml', 'proxy');

  it('runs on a 22.04 and 24.04 matrix without fail-fast', () => {
    expect(block()).toMatch(/ubuntu:\s*\['22\.04',\s*'24\.04'\]/);
    expect(block()).toContain('fail-fast: false');
  });

  it('runs tests/integration/proxy with NOODARA_TEST_UBUNTU from the matrix', () => {
    expect(block()).toMatch(
      /run: NOODARA_TEST_UBUNTU=\$\{\{ matrix\.ubuntu \}\} pnpm exec vitest run --config vitest\.integration\.config\.ts tests\/integration\/proxy\s*\n/,
    );
  });

  it('fails on leftover noodara.test containers and networks, even after a failed run', () => {
    const steps = block();
    expect(steps).toContain('docker ps -aq --filter "label=noodara.test=true"');
    expect(steps).toContain('docker network ls -q --filter label=noodara.test=true');
    expect(steps.match(/if: always\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(steps.match(/exit 1/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // The leak checks come after the suite run.
    expect(steps.indexOf('label=noodara.test=true')).toBeGreaterThan(steps.indexOf('tests/integration/proxy'));
  });
});

describe('.github/workflows/ci.yml integration job', () => {
  const block = (): string => jobBlock('.github/workflows/ci.yml', 'integration');
  const runLine = (): string => {
    const line = block()
      .split('\n')
      .find((entry) => entry.includes('run: pnpm test:integration'));
    expect(line, 'pnpm test:integration step not found').toBeTruthy();
    return line ?? '';
  };

  it('excludes tests/integration/proxy and tests/integration/deploy-engine', () => {
    expect(runLine()).toContain("--exclude 'tests/integration/deploy-engine/**'");
    expect(runLine()).toContain("--exclude 'tests/integration/proxy/**'");
  });

  it('still runs tests/integration/domains (no exclusion matches it)', () => {
    const excluded = [...runLine().matchAll(/--exclude '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(excluded.length).toBeGreaterThan(0);
    for (const glob of excluded) expect(glob.startsWith('tests/integration/domains')).toBe(false);
    expect(excluded.some((glob) => glob === 'tests/integration/**' || glob === '**')).toBe(false);
  });

  it('documents the proxy exclusion next to the step', () => {
    expect(block()).toMatch(/#.*tests\/integration\/proxy/);
    expect(block()).toMatch(/#.*tests\/integration\/domains/);
  });
});
