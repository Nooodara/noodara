import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Plan 10-08 (D-07): the install text now lives only in apps/site/content/docs -- docs/install.md
// is a short stub. The "doc that can't lie" discipline from plan 06-14 carries over unchanged:
// every fact below is read from the real MDX pages and diffed against install.sh's own source,
// never hand-typed or asserted by hand. Mirrors tests/unit/scripts/check-workflow-pins.test.ts's
// own "structural proof against the real files" pattern: everything below is read from disk, with
// no network call and no shell execution.

const DOCS_DIR = 'apps/site/content/docs';

const installSh = () => readFileSync('install.sh', 'utf8');
const readme = () => readFileSync('README.md', 'utf8');

/** Reads one MDX page under apps/site/content/docs, e.g. docsPage('getting-started/install'). */
const docsPage = (rel: string) => readFileSync(path.join(DOCS_DIR, `${rel}.mdx`), 'utf8');

/** Every .mdx file under apps/site/content/docs, concatenated -- for assertions that must hold
 *  across the whole docs tree rather than any one page. */
function listMdxFiles(dir: string = DOCS_DIR): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...listMdxFiles(absolute));
    } else if (entry.endsWith('.mdx')) {
      files.push(absolute);
    }
  }
  return files;
}

const allDocsPages = () => listMdxFiles().map((file) => readFileSync(file, 'utf8')).join('\n');

describe('install docs (apps/site/content/docs) accuracy against install.sh', () => {
  it('every exit code in noodara_exit_code_for appears in the Troubleshooting page table with the same number, and no extra code appears', () => {
    const source = installSh();
    const fnMatch = source.match(/noodara_exit_code_for\(\) \{([\s\S]*?)\n\}/);
    expect(fnMatch, 'noodara_exit_code_for function not found in install.sh').toBeTruthy();
    const body = fnMatch?.[1] ?? '';
    const codes = [...body.matchAll(/^\s+[\w-]+\)\s*printf '%s\\n' (\d+) ;;/gm)].map((m) => Number(m[1]));
    expect(codes.length).toBeGreaterThan(0);

    const page = docsPage('operate/troubleshooting');
    const docCodes = [...page.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));

    expect(new Set(docCodes)).toEqual(new Set(codes));
    expect(docCodes.length).toBe(codes.length);
  });

  it('every exit code in noodara_exit_code_for also appears in the Reference › Exit codes page table, and no extra code appears', () => {
    const source = installSh();
    const fnMatch = source.match(/noodara_exit_code_for\(\) \{([\s\S]*?)\n\}/);
    const body = fnMatch?.[1] ?? '';
    const codes = [...body.matchAll(/^\s+[\w-]+\)\s*printf '%s\\n' (\d+) ;;/gm)].map((m) => Number(m[1]));

    const page = docsPage('reference/exit-codes');
    const docCodes = [...page.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));

    expect(new Set(docCodes)).toEqual(new Set(codes));
    expect(docCodes.length).toBe(codes.length);
  });

  it("the Install page quotes install.sh's own ufw wording verbatim, extracted from the script", () => {
    const source = installSh();
    const fnMatch = source.match(/noodara_check_ufw\(\) \{([\s\S]*?)\n\}/);
    expect(fnMatch, 'noodara_check_ufw function not found in install.sh').toBeTruthy();
    const body = fnMatch?.[1] ?? '';

    const bypassMatch = body.match(/noodara_note "([^"]*typically bypass[^"]*)"/);
    const cloudMatch = body.match(/noodara_note "([^"]*cloud provider[^"]*)"/);
    expect(bypassMatch, "install.sh's 'typically bypass' sentence not found").toBeTruthy();
    expect(cloudMatch, "install.sh's cloud-provider sentence not found").toBeTruthy();

    const page = docsPage('getting-started/install');
    expect(page).toContain(bypassMatch?.[1]);
    expect(page).toContain(cloudMatch?.[1]);
  });

  it('no D-19 test-only override variable name appears anywhere under apps/site/content/docs or in README.md', () => {
    const testOnlyVars = [
      'NOODARA_INTERNAL_IMAGE_PREFIX',
      'NOODARA_INSTALL_SH_SOURCE_ONLY',
      'NOODARA_HEALTH_WAIT_ATTEMPTS',
      'NOODARA_HEALTH_WAIT_INTERVAL',
      'NOODARA_DOCKER_READY_WAIT_ATTEMPTS',
      'NOODARA_DOCKER_READY_WAIT_INTERVAL',
      'NOODARA_FETCH_TIMEOUT',
      'NOODARA_OS_RELEASE_FILE',
      'NOODARA_MEMINFO_FILE',
      'NOODARA_DOCKER_KEYRING_DIR',
      'NOODARA_DOCKER_SOURCES_FILE',
      'NOODARA_REGISTRY',
      'NOODARA_REPO_OWNER',
      'NOODARA_REPO_NAME',
      'NOODARA_INSTALL_DIR',
    ];
    const docs = allDocsPages();
    const rm = readme();
    for (const v of testOnlyVars) {
      expect(docs, `${v} must not appear under apps/site/content/docs (D-19)`).not.toContain(v);
      expect(rm, `${v} must not appear in README.md (D-19)`).not.toContain(v);
    }
  });

  it('every NOODARA_ variable named anywhere under apps/site/content/docs actually occurs in install.sh', () => {
    const docs = allDocsPages();
    const source = installSh();
    const names = new Set([...docs.matchAll(/\bNOODARA_[A-Z0-9_]+\b/g)].map((m) => m[0]));
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(source, `${name} is documented but does not occur in install.sh`).toContain(name);
    }
  });

  it("the Install page's one-line install command and its download-read-run alternative reference the same script URL, built from install.sh's own placeholder owner/repo", () => {
    const source = installSh();
    const ownerMatch = source.match(/NOODARA_REPO_OWNER="\$\{NOODARA_REPO_OWNER:-([A-Za-z0-9_]+)\}"/);
    const repoMatch = source.match(/NOODARA_REPO_NAME="\$\{NOODARA_REPO_NAME:-([A-Za-z0-9_]+)\}"/);
    expect(ownerMatch, 'placeholder NOODARA_REPO_OWNER default not found in install.sh').toBeTruthy();
    expect(repoMatch, 'placeholder NOODARA_REPO_NAME default not found in install.sh').toBeTruthy();
    const owner = ownerMatch?.[1];
    const repo = repoMatch?.[1];
    const expectedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/install.sh`;

    const page = docsPage('getting-started/install');
    const occurrences = page.split(expectedUrl).length - 1;
    expect(occurrences, `expected "${expectedUrl}" to appear at least twice on the Install page`).toBeGreaterThanOrEqual(2);
  });

  it('the literal :latest image tag never appears under apps/site/content/docs or in README.md', () => {
    expect(allDocsPages()).not.toContain(':latest');
    expect(readme()).not.toContain(':latest');
  });

  it('no internal planning id (plan number, threat id, decision id) appears under apps/site/content/docs or in README.md', () => {
    const patterns: RegExp[] = [/\b0[1-6]-\d{2}\b/, /T-0\d-\d+/, /\bD-\d{2}\b/];
    for (const doc of [allDocsPages(), readme()]) {
      for (const p of patterns) {
        expect(doc).not.toMatch(p);
      }
    }
  });

  it('the Install page documents the ghcr.io image reference shape without ever using the unversioned tag', () => {
    const page = docsPage('getting-started/install');
    expect(page).toMatch(/ghcr\.io\/.*\/noodara-control-plane/);
    expect(page).toMatch(/ghcr\.io\/.*\/noodara-web/);
  });

  // Post-execution fix (orchestrator audit Finding 1, 06-14 follow-up): a `VAR=value cmd1 | cmd2`
  // shell pipeline applies the assignment to `cmd1` only -- `NOODARA_VERSION=<x> curl ... | sh`
  // would silently install the LATEST version, never the pinned one. Every documented command must
  // place a NOODARA_* assignment on the `sh` side of the pipe (after `sudo` when `sudo` is used),
  // never in front of `curl`.
  it('never places a NOODARA_*= assignment before curl in a piped-install command', () => {
    for (const doc of [allDocsPages(), readme()]) {
      expect(doc).not.toMatch(/\bNOODARA_[A-Z0-9_]+=\S*\s+curl\b/);
    }
  });

  it('the Rollback page places NOODARA_VERSION on the sh side of the pipe, both as root and with sudo', () => {
    const page = docsPage('operate/rollback');
    // The owner is read from install.sh's own default, never hand-written here, so the docs and the
    // script can only ever agree on one owner string.
    const ownerMatch = installSh().match(/NOODARA_REPO_OWNER="\$\{NOODARA_REPO_OWNER:-([A-Za-z0-9_-]+)\}"/);
    expect(ownerMatch, 'NOODARA_REPO_OWNER default not found in install.sh').toBeTruthy();
    const url = `https://raw.githubusercontent.com/${ownerMatch?.[1] ?? ''}/noodara/main/install.sh`;
    expect(page).toContain(`curl -fsSL ${url} | NOODARA_VERSION=<previous-version> sh`);
    expect(page).toContain(`curl -fsSL ${url} | sudo NOODARA_VERSION=<previous-version> sh`);
  });

  // Post-execution fix (orchestrator audit Finding 2, 06-14 follow-up): only `web` publishes a
  // port, and `web` only rewrites `/api/:path*` to the control plane (apps/web/next.config.ts) --
  // `/health` on the published panel port is answered by Next.js, never the control plane.
  it('the Troubleshooting page never documents /health (or any non-/api/ route) reachable on the published panel port', () => {
    const page = docsPage('operate/troubleshooting');
    const matches = [...page.matchAll(/127\.0\.0\.1:<port>(\/\S*)?/g)].map((m) => m[1] ?? '');
    expect(matches.length).toBeGreaterThan(0);
    for (const p of matches) {
      const allowed = p === '' || p === '/' || p === '/login' || p.startsWith('/api/');
      expect(allowed, `unexpected path documented on the published panel port: '${p}'`).toBe(true);
    }
    expect(page).not.toContain('curl http://127.0.0.1:<port>/health');
  });

  // Post-execution fix (orchestrator audit Finding 3, 06-14 follow-up): a same-version re-run with
  // an already-healthy stack is a true no-op (D-09) -- it never runs `docker compose up`, so
  // telling the operator to "edit .env and re-run the installer" to apply a change does nothing.
  // The only real way to apply an edited `.env` is `docker compose ... up -d` directly.
  it('the Reference › Supported variables page never tells the operator to re-run the installer to apply an .env edit, and documents the docker compose apply command', () => {
    const page = docsPage('reference/variables');
    expect(page).not.toContain('and re-run the installer to apply them');
    expect(page).not.toContain('edit /opt/noodara/.env directly and re-run the installer');
    expect(page).not.toMatch(/Re-run the installer with `NOODARA_PUBLIC_URL`/);
    expect(page).toContain('docker compose -f /opt/noodara/docker-compose.yml up -d');
    expect(page.toLowerCase()).toMatch(/re-running the installer does not apply an `?\.env`? edit/);
  });

  // Post-execution fix (orchestrator audit WR-04): the admin-password minimum length install.sh
  // itself checks up front (NOODARA_ADMIN_PASSWORD_MIN_LENGTH) must be the same number the
  // First login page documents -- extracted from install.sh's own source, never hand-typed twice.
  it("the First login page's documented admin-password minimum length matches install.sh's own NOODARA_ADMIN_PASSWORD_MIN_LENGTH constant", () => {
    const source = installSh();
    const match = source.match(/readonly NOODARA_ADMIN_PASSWORD_MIN_LENGTH=(\d+)/);
    expect(match, 'NOODARA_ADMIN_PASSWORD_MIN_LENGTH constant not found in install.sh').toBeTruthy();
    const minLength = match?.[1] ?? '';

    const page = docsPage('getting-started/first-login');
    expect(page).toContain(`at least ${minLength} characters`);
  });

  // Post-execution fix (orchestrator audit WR-04): the First login page must plainly say the
  // common-password check happens later, at control-plane boot, and name the real diagnostic
  // command -- never imply the full password policy is rejected outright before anything is
  // written (the finding this fix addresses).
  it('the First login page explains that a common admin password is rejected later, at boot, surfacing as exit 53 in the api log tail', () => {
    const page = docsPage('getting-started/first-login');

    expect(page.toLowerCase()).toContain('common');
    expect(page).toContain('docker compose -f /opt/noodara/docker-compose.yml logs api');
    expect(page).toContain('53');
  });
});

describe('docs/install.md stub (D-07)', () => {
  const installStub = () => readFileSync('docs/install.md', 'utf8');

  it('points at the site as the single source, keeps the #firewall anchor alive, and carries no exit-code table', () => {
    const stub = installStub();
    expect(stub).toContain('https://noodara.com/docs/getting-started/install');
    expect(stub).toMatch(/#firewall/);
    expect(stub.split('\n').length).toBeLessThanOrEqual(25);
    expect(stub).not.toMatch(/\|\s*10\s*\|/);
  });
});

describe('README.md', () => {
  it('has an Install section that links to docs/install.md', () => {
    const rm = readme();
    expect(rm).toContain('## Install');
    expect(rm).toContain('docs/install.md');
  });

  it('has a Status line naming v0.1 and makes no v0.2+ claim', () => {
    const rm = readme();
    expect(rm).toMatch(/## Status/);
    expect(rm).toMatch(/v0\.1/);
  });

  it('every command in the Development section exists as a script in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const rm = readme();
    const devMatch = rm.match(/## Development\n([\s\S]*?)(\n## |$)/);
    expect(devMatch, 'Development section not found in README.md').toBeTruthy();
    const section = devMatch?.[1] ?? '';
    const commands = [...new Set([...section.matchAll(/`pnpm ([a-z0-9:_-]+)`/g)].map((m) => m[1]))];
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(pkg.scripts, `pnpm ${cmd} is documented but not a real script in package.json`).toHaveProperty(cmd);
    }
  });
});

// Plan 07-10 (BRAND-02, D-10, T-07-29): the README's own <picture> header is the last surface the
// brand mark had to reach. The sources must be the two repo-relative SVG paths this phase already
// generated and byte-locked (07-06) -- never a remote URL, which is exactly the tampering surface
// T-07-29 names -- and the existing Install/Status/Development/no-planning-id assertions above must
// keep passing against the new markup.
describe('README.md brand header', () => {
  it('opens with a <picture> lockup: a dark <source> and a light <img> fallback, both repo-relative', () => {
    const rm = readme();
    expect(rm).toContain(
      '<source media="(prefers-color-scheme: dark)" srcset="packages/ui/brand/lockup-dark.svg">',
    );
    expect(rm).toContain('<img alt="Noodara" src="packages/ui/brand/lockup-light.svg" width="240">');
  });

  it('the <picture> block never references a remote URL, only the two repo-relative lockup SVGs', () => {
    const rm = readme();
    const pictureMatch = rm.match(/<picture>[\s\S]*?<\/picture>/);
    expect(pictureMatch, '<picture> block not found in README.md').toBeTruthy();
    expect(pictureMatch?.[0]).not.toMatch(/https?:\/\//);
  });

  it('both lockup sources the <picture> block points at exist on disk', () => {
    expect(existsSync('packages/ui/brand/lockup-dark.svg')).toBe(true);
    expect(existsSync('packages/ui/brand/lockup-light.svg')).toBe(true);
  });

  it('the <picture> block appears before the first ## heading, and the H1 + tagline remain', () => {
    const rm = readme();
    const pictureIndex = rm.indexOf('<picture>');
    const firstHeadingIndex = rm.indexOf('\n## ');
    expect(pictureIndex).toBeGreaterThanOrEqual(0);
    expect(firstHeadingIndex).toBeGreaterThan(pictureIndex);
    expect(rm).toMatch(/^# Noodara$/m);
    expect(rm).toContain('> Your infrastructure, understood.');
  });
});

describe('docs/adr/0007-production-topology-and-installer.md', () => {
  it('exists, follows the Accepted status shape, and names every load-bearing decision id', () => {
    const adr = readFileSync('docs/adr/0007-production-topology-and-installer.md', 'utf8');
    expect(adr).toMatch(/^## Status\n\nAccepted/m);
    for (const id of ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-08', 'D-09', 'D-10', 'D-11', 'D-12', 'D-16', 'D-17', 'D-18', 'D-19']) {
      expect(adr, `${id} not named in ADR 0007`).toContain(id);
    }
  });
});
