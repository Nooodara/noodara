import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Plan 06-13, T-06-54: every third-party `uses:` inside the release pipeline (and every existing
// workflow) must be pinned to a 40-character commit SHA, with the human-readable tag kept as a
// trailing comment -- a mutable tag reference inside the pipeline that builds and publishes the
// GHCR images every VPS install pulls is exactly the tampering surface T-06-54 names. This scanner
// is the machine-checked form of that rule, mirroring scripts/check-posix-sh.mjs's own
// zero-dependency, regex-over-known-shape discipline (no YAML parser dependency added).
import { scanWorkflowPins } from '../../../scripts/check-workflow-pins.mjs';

describe('scanWorkflowPins', () => {
  it('returns [] for a workflow where every uses: is pinned to a 40-hex SHA', () => {
    const source = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5',
      '      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1',
      '',
    ].join('\n');

    expect(scanWorkflowPins(source)).toEqual([]);
  });

  it('flags a uses: line pinned to a mutable tag instead of a commit SHA', () => {
    const source = ['jobs:', '  build:', '    steps:', '      - uses: docker/login-action@v4', ''].join('\n');

    const findings = scanWorkflowPins(source);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'unpinned-action', action: 'docker/login-action', ref: 'v4' });
  });

  it('flags a uses: line with no @ref at all', () => {
    const source = ['jobs:', '  build:', '    steps:', '      - uses: actions/checkout', ''].join('\n');

    const findings = scanWorkflowPins(source);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('missing-ref');
  });

  it('does not flag an unpinned action when the line carries an explicit TODO(06-15) marker', () => {
    // hard_rule #6's own escape hatch: an unresolvable SHA becomes a tracked TODO for Plan 06-15,
    // never a silently-shipped floating tag.
    const source = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: some/action@v1 # TODO(06-15): resolve commit SHA before the first release',
      '',
    ].join('\n');

    expect(scanWorkflowPins(source)).toEqual([]);
  });
});

// Structural proof against the REAL workflow files this plan authors/modifies -- not just the
// scanner's own fixtures. These assertions are the honest, offline substitute for a real GitHub
// Actions run (hard_rule #8): everything here can be verified by reading files on disk, with no
// network call and no workflow execution.
describe('release pipeline workflow files (structural, no GitHub Actions run required)', () => {
  const releaseYml = () => readFileSync('.github/workflows/release.yml', 'utf8');
  const ciYml = () => readFileSync('.github/workflows/ci.yml', 'utf8');
  const nightlyYml = () => readFileSync('.github/workflows/nightly.yml', 'utf8');

  it('release.yml: every uses: is pinned to a 40-hex SHA (or carries an explicit TODO(06-15))', () => {
    expect(scanWorkflowPins(releaseYml())).toEqual([]);
  });

  it('ci.yml: every uses: is still pinned to a 40-hex SHA after this plan\'s edits', () => {
    expect(scanWorkflowPins(ciYml())).toEqual([]);
  });

  it('nightly.yml: every uses: is still pinned to a 40-hex SHA after this plan\'s edits', () => {
    expect(scanWorkflowPins(nightlyYml())).toEqual([]);
  });

  it('release.yml bakes the exact production NOODARA_API_ORIGIN build arg (D-01)', () => {
    expect(releaseYml()).toContain('NOODARA_API_ORIGIN=http://api:3000');
  });

  it('release.yml bakes NOODARA_IMAGE_VERSION for the control-plane image', () => {
    expect(releaseYml()).toContain('NOODARA_IMAGE_VERSION');
  });

  it('release.yml never publishes the unversioned :latest tag (D-04)', () => {
    expect(releaseYml()).not.toContain(':latest');
  });

  it('none of the three workflow files reference the floating :latest image tag', () => {
    for (const source of [releaseYml(), ciYml(), nightlyYml()]) {
      expect(source).not.toContain(':latest');
    }
  });

  it('release.yml combines per-arch pushes into one manifest and verifies both architectures', () => {
    const source = releaseYml();

    expect(source).toContain('imagetools create');
    expect(source).toContain('docker manifest inspect');
  });

  it('release.yml builds natively on both amd64 and arm64 runners, never under QEMU (D-16)', () => {
    const source = releaseYml();

    expect(source).toContain('ubuntu-24.04-arm');
    expect(source).toContain('linux/arm64');
    expect(source).not.toContain('setup-qemu-action');
  });

  it('release.yml uses only the built-in GITHUB_TOKEN for GHCR, never a PAT', () => {
    const source = releaseYml();

    expect(source).toContain('packages: write');
    expect(source).not.toContain('secrets.GHCR');
  });

  it('release.yml documents D-02: it cannot fire for real until a remote exists', () => {
    expect(releaseYml()).toMatch(/D-02/);
  });

  it('release.yml sets cancel-in-progress: false exactly once (a half-finished publish must not be cancelled)', () => {
    const matches = releaseYml().match(/cancel-in-progress: false/g) ?? [];

    expect(matches).toHaveLength(1);
  });

  it('every job in release.yml declares both permissions: and timeout-minutes:', () => {
    const source = releaseYml();
    const jobNames = [...source.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);

    expect(jobNames.length).toBeGreaterThan(0);
    for (const jobName of jobNames) {
      const jobBlockMatch = source.match(new RegExp(`\\n {2}${jobName}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z0-9_-]*:\\n|$)`));
      expect(jobBlockMatch, `job "${jobName}" block not found`).toBeTruthy();
      const jobBlock = jobBlockMatch?.[1] ?? '';
      expect(jobBlock, `job "${jobName}" missing permissions:`).toMatch(/permissions:/);
      expect(jobBlock, `job "${jobName}" missing timeout-minutes:`).toMatch(/timeout-minutes:/);
    }
  });

  it('ci.yml gates pnpm test:installer to push-on-main, never on every pull request', () => {
    const source = ciYml();
    const jobBlockMatch = source.match(/\n {2}installer:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/);

    expect(jobBlockMatch, 'installer job not found in ci.yml').toBeTruthy();
    const jobBlock = jobBlockMatch?.[1] ?? '';
    expect(jobBlock).toContain('test:installer');
    expect(jobBlock).toMatch(/if:.*push/);
    expect(jobBlock).toMatch(/refs\/heads\/main/);
    expect(jobBlock).toMatch(/permissions:/);
    expect(jobBlock).toMatch(/timeout-minutes:/);
  });

  it('ci.yml runs pnpm check:posix-sh inside the lint job (every PR)', () => {
    const source = ciYml();
    const jobBlockMatch = source.match(/\n {2}lint:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/);

    expect(jobBlockMatch, 'lint job not found in ci.yml').toBeTruthy();
    expect(jobBlockMatch?.[1]).toContain('check:posix-sh');
  });

  it('nightly.yml runs the installer suite', () => {
    const source = nightlyYml();
    const jobBlockMatch = source.match(/\n {2}installer:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/);

    expect(jobBlockMatch, 'installer job not found in nightly.yml').toBeTruthy();
    const jobBlock = jobBlockMatch?.[1] ?? '';
    expect(jobBlock).toContain('test:installer');
    expect(jobBlock).toMatch(/permissions:/);
    expect(jobBlock).toMatch(/timeout-minutes:/);
  });
});
