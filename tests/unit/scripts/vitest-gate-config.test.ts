// Post-execution fix (orchestrator audit WR-08, code review report
// .planning/phases/06-instalador-y-docker-compose/06-REVIEW.md): vitest.installer.config.ts and
// vitest.integration.config.ts both set `passWithNoTests: true` behind a now-stale "no tests
// exist yet" comment -- both suites are long populated (tests/integration/installer/** has ten
// real files; tests/integration/** minus installer/ has several more). With the flag still set, a
// future glob typo, directory rename, or CI checkout that omits the test directory would make
// these release-blocking gates (ci.yml's `installer` job, nightly.yml, and the PR-gating
// `test:integration` job) report success having run zero tests, rather than failing loudly.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CONFIG_FILES = ['vitest.installer.config.ts', 'vitest.integration.config.ts'];

describe.each(CONFIG_FILES)('%s does not set passWithNoTests: true', (file) => {
  it('never contains the literal passWithNoTests: true', () => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/passWithNoTests:\s*true/);
  });

  it('explicitly sets passWithNoTests: false, so an accidental zero-match run fails loudly', () => {
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(/passWithNoTests:\s*false/);
  });
});

// Plan 07-10 (T-07-30): packages/ui/brand/* is generated, committed source -- `pnpm brand:check`
// is the only gate that can catch a hand-edited or stale asset before it merges. This is a static,
// structural read of the real .github/workflows/ci.yml (no workflow execution), mirroring
// tests/unit/scripts/check-workflow-pins.test.ts's own job-block-regex pattern for the same file.
describe('.github/workflows/ci.yml runs the brand drift gate in the lint job', () => {
  it('the lint job runs pnpm brand:check immediately after pnpm check:ui-safety', () => {
    const source = readFileSync('.github/workflows/ci.yml', 'utf8');
    const jobBlockMatch = source.match(/\n {2}lint:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/);
    expect(jobBlockMatch, 'lint job not found in ci.yml').toBeTruthy();
    const jobBlock = jobBlockMatch?.[1] ?? '';

    expect(jobBlock).toContain('run: pnpm brand:check');

    const uiSafetyIndex = jobBlock.indexOf('run: pnpm check:ui-safety');
    const brandCheckIndex = jobBlock.indexOf('run: pnpm brand:check');
    expect(uiSafetyIndex).toBeGreaterThanOrEqual(0);
    expect(brandCheckIndex).toBeGreaterThan(uiSafetyIndex);
  });
});
