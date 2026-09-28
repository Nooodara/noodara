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
    // Scope to the `jobs:` top-level block only -- the same "  key:" indentation shape also
    // appears under `on:`/`concurrency:` above it (e.g. "  push:", "  tags:"), which are not jobs.
    const jobsSectionMatch = source.match(/\njobs:\n([\s\S]*)$/);
    expect(jobsSectionMatch, 'jobs: section not found').toBeTruthy();
    const jobsSection = jobsSectionMatch?.[1] ?? '';
    const jobNames = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);

    expect(jobNames.length).toBeGreaterThan(0);
    for (const jobName of jobNames) {
      const jobBlockMatch = jobsSection.match(new RegExp(`\\n {2}${jobName}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z0-9_-]*:\\n|$)`));
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

// Plan 10-03 (SITE-02, D-11/D-12/D-13, T-10-01/T-10-02/T-10-10/T-10-03/T-10-16): the same
// offline, structural discipline as the release-pipeline describe block above, now proving
// public-site.yml (the GitHub Pages publish workflow) and ci.yml's `site` PR gate job stay
// SHA-pinned, least-privilege, push-to-main-only, and fully isolated from release.yml and every
// docker-compose file -- before either workflow file exists.
describe('public site workflows (D-12/D-13, structural)', () => {
  const publicSiteYml = () => readFileSync('.github/workflows/public-site.yml', 'utf8');
  const ciYml = () => readFileSync('.github/workflows/ci.yml', 'utf8');
  const releaseYml = () => readFileSync('.github/workflows/release.yml', 'utf8');
  const dockerComposeYml = () => readFileSync('docker-compose.yml', 'utf8');
  const dockerComposeDevYml = () => readFileSync('docker-compose.dev.yml', 'utf8');

  // Same job-block extraction shape used by the release.yml describe block above, reused here
  // against public-site.yml and ci.yml's own `jobs:` sections.
  function extractJobsSection(source: string): string {
    const jobsSectionMatch = source.match(/\njobs:\n([\s\S]*)$/);
    expect(jobsSectionMatch, 'jobs: section not found').toBeTruthy();
    // Leading \n so extractJobBlock's `\n {2}${jobName}:\n` pattern also matches the very first
    // job in the section, not just jobs preceded by a prior job's own content.
    return `\n${jobsSectionMatch?.[1] ?? ''}`;
  }

  function extractJobBlock(source: string, jobName: string): string {
    const jobBlockMatch = source.match(
      new RegExp(`\\n {2}${jobName}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z0-9_-]*:\\n|$)`),
    );
    expect(jobBlockMatch, `job "${jobName}" block not found`).toBeTruthy();
    return jobBlockMatch?.[1] ?? '';
  }

  it('public-site.yml: every uses: is pinned to a 40-hex SHA', () => {
    expect(scanWorkflowPins(publicSiteYml())).toEqual([]);
  });

  it('ci.yml: every uses: is still pinned to a 40-hex SHA after this plan\'s edits', () => {
    expect(scanWorkflowPins(ciYml())).toEqual([]);
  });

  it('public-site.yml triggers on push to main and workflow_dispatch only, never pull_request', () => {
    const source = publicSiteYml();
    const onSectionMatch = source.match(/\non:\n([\s\S]*?)(?=\n[a-z]+:\n)/);
    expect(onSectionMatch, 'on: section not found').toBeTruthy();
    const onSection = onSectionMatch?.[1] ?? '';

    expect(onSection).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
    expect(onSection).toMatch(/workflow_dispatch:/);
    expect(onSection).not.toMatch(/pull_request/);
  });

  it('public-site.yml never declares a paths: or paths-ignore: filter (D-13)', () => {
    expect(publicSiteYml()).not.toMatch(/paths(-ignore)?:/);
  });

  it('public-site.yml declares a top-level permissions: {} block', () => {
    expect(publicSiteYml()).toMatch(/\npermissions:\s*\{\}/);
  });

  it('public-site.yml\'s deploy job has only contents: read, never pages: or id-token:', () => {
    const jobsSection = extractJobsSection(publicSiteYml());
    const deployJob = extractJobBlock(jobsSection, 'deploy');

    expect(deployJob).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(deployJob).not.toMatch(/pages:\s*write/);
    expect(deployJob).not.toMatch(/id-token:\s*write/);
  });

  it('sets concurrency group cloudflare-pages with cancel-in-progress: false', () => {
    const source = publicSiteYml();

    expect(source).toMatch(/concurrency:\s*\n\s*group:\s*cloudflare-pages\s*\n\s*cancel-in-progress:\s*false/);
  });

  it('every job in public-site.yml declares timeout-minutes:', () => {
    const jobsSection = extractJobsSection(publicSiteYml());
    const jobNames = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);

    expect(jobNames.length).toBeGreaterThan(0);
    for (const jobName of jobNames) {
      const jobBlock = extractJobBlock(jobsSection, jobName as string);
      expect(jobBlock, `job "${jobName}" missing timeout-minutes:`).toMatch(/timeout-minutes:/);
    }
  });

  it('references only the two Cloudflare secrets, never any other secret', () => {
    const source = publicSiteYml();
    const captured = [...source.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    const allowed = new Set(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);

    expect(captured.length).toBeGreaterThan(0);
    for (const name of captured) {
      expect(allowed.has(name as string), `unexpected secret: ${name}`).toBe(true);
    }
  });

  it('deploy job checks out with fetch-depth: 0, installs, builds and deploys apps/site/out via wrangler', () => {
    const jobsSection = extractJobsSection(publicSiteYml());
    const deployJob = extractJobBlock(jobsSection, 'deploy');

    expect(deployJob).toMatch(/fetch-depth:\s*0/);
    expect(deployJob).toContain('pnpm install --frozen-lockfile');
    expect(deployJob).toContain('pnpm --filter @noodara/site build');
    expect(deployJob).toContain('pages deploy apps/site/out --project-name=noodara-site --branch=main');
    expect(deployJob).not.toContain('upload-pages-artifact');
    expect(deployJob).not.toContain('deploy-pages');
  });

  it('public-site.yml pins cloudflare/wrangler-action to a 40-hex SHA and an exact wranglerVersion', () => {
    const source = publicSiteYml();

    expect(source).toContain('cloudflare/wrangler-action@');
    expect(source).toMatch(/wranglerVersion:\s*['"]?\d+\.\d+\.\d+['"]?/);
  });

  it('public-site.yml never declares a github-pages environment or pages/id-token permissions anywhere', () => {
    const source = publicSiteYml();

    expect(source).not.toMatch(/environment:\s*\n\s*name:\s*github-pages/);
    expect(source).not.toContain('pages: write');
    expect(source).not.toContain('id-token: write');
  });

  it('ci.yml has a site job with contents: read, timeout-minutes, fetch-depth: 0, the site build and docs/site tests, and no job-level if:', () => {
    const jobsSection = extractJobsSection(ciYml());
    const siteJob = extractJobBlock(jobsSection, 'site');

    expect(siteJob).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(siteJob).toMatch(/timeout-minutes:/);
    expect(siteJob).toMatch(/fetch-depth:\s*0/);
    expect(siteJob).toContain('pnpm --filter @noodara/site build');
    expect(siteJob).toContain('pnpm exec vitest run tests/unit/docs tests/unit/site');
    expect(siteJob).not.toMatch(/^\s*if:/m);
  });

  it('release.yml, docker-compose.yml and docker-compose.dev.yml never mention the site', () => {
    for (const source of [releaseYml(), dockerComposeYml(), dockerComposeDevYml()]) {
      expect(source).not.toContain('apps/site');
      expect(source).not.toContain('@noodara/site');
      expect(source).not.toContain('public-site');
    }
  });
});
