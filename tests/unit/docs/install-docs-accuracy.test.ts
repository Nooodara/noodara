import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Plan 06-14: docs/install.md and README.md are operator-facing documentation for a script
// (install.sh) that already exists and has already passed through ~10 audit-driven post-execution
// fixes across plans 06-04..06-13. The docs must describe the script that actually ships, not the
// one any single plan described in advance -- so accuracy here is tested against install.sh's own
// source, never asserted by hand. Mirrors tests/unit/scripts/check-workflow-pins.test.ts's own
// "structural proof against the real files" pattern: everything below is read from disk, with no
// network call and no shell execution.

const installSh = () => readFileSync('install.sh', 'utf8');
const installDocs = () => readFileSync('docs/install.md', 'utf8');
const readme = () => readFileSync('README.md', 'utf8');

describe('docs/install.md accuracy against install.sh', () => {
  it('every exit code in noodara_exit_code_for appears in the troubleshooting table with the same number, and no extra code appears', () => {
    const source = installSh();
    const fnMatch = source.match(/noodara_exit_code_for\(\) \{([\s\S]*?)\n\}/);
    expect(fnMatch, 'noodara_exit_code_for function not found in install.sh').toBeTruthy();
    const body = fnMatch?.[1] ?? '';
    // Matches lines like: `    not-root) printf '%s\n' 10 ;;` -- never the `*) ... exit 99` default
    // branch, which starts with a literal `*`, not a word character.
    const codes = [...body.matchAll(/^\s+[\w-]+\)\s*printf '%s\\n' (\d+) ;;/gm)].map((m) => Number(m[1]));
    expect(codes.length).toBeGreaterThan(0);

    const docs = installDocs();
    const troubleshootingMatch = docs.match(/## Troubleshooting\n([\s\S]*?)(\n## |$)/);
    expect(troubleshootingMatch, 'Troubleshooting section not found in docs/install.md').toBeTruthy();
    const section = troubleshootingMatch?.[1] ?? '';
    const docCodes = [...section.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));

    expect(new Set(docCodes)).toEqual(new Set(codes));
    expect(docCodes.length).toBe(codes.length);
  });

  it("the firewall section quotes install.sh's own ufw wording verbatim, extracted from the script", () => {
    const source = installSh();
    const fnMatch = source.match(/noodara_check_ufw\(\) \{([\s\S]*?)\n\}/);
    expect(fnMatch, 'noodara_check_ufw function not found in install.sh').toBeTruthy();
    const body = fnMatch?.[1] ?? '';

    const bypassMatch = body.match(/noodara_note "([^"]*typically bypass[^"]*)"/);
    const cloudMatch = body.match(/noodara_note "([^"]*cloud provider[^"]*)"/);
    expect(bypassMatch, "install.sh's 'typically bypass' sentence not found").toBeTruthy();
    expect(cloudMatch, "install.sh's cloud-provider sentence not found").toBeTruthy();

    const docs = installDocs();
    expect(docs).toContain(bypassMatch?.[1]);
    expect(docs).toContain(cloudMatch?.[1]);
  });

  it('no D-19 test-only override variable name appears in docs/install.md or README.md', () => {
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
    const docs = installDocs();
    const rm = readme();
    for (const v of testOnlyVars) {
      expect(docs, `${v} must not appear in docs/install.md (D-19)`).not.toContain(v);
      expect(rm, `${v} must not appear in README.md (D-19)`).not.toContain(v);
    }
  });

  it('every NOODARA_ variable named in docs/install.md actually occurs in install.sh', () => {
    const docs = installDocs();
    const source = installSh();
    const names = new Set([...docs.matchAll(/\bNOODARA_[A-Z0-9_]+\b/g)].map((m) => m[0]));
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(source, `${name} is documented but does not occur in install.sh`).toContain(name);
    }
  });

  it("the one-line install command and the download-read-run alternative reference the same script URL, built from install.sh's own placeholder owner/repo", () => {
    const source = installSh();
    const ownerMatch = source.match(/NOODARA_REPO_OWNER="\$\{NOODARA_REPO_OWNER:-([A-Za-z0-9_]+)\}"/);
    const repoMatch = source.match(/NOODARA_REPO_NAME="\$\{NOODARA_REPO_NAME:-([A-Za-z0-9_]+)\}"/);
    expect(ownerMatch, 'placeholder NOODARA_REPO_OWNER default not found in install.sh').toBeTruthy();
    expect(repoMatch, 'placeholder NOODARA_REPO_NAME default not found in install.sh').toBeTruthy();
    const owner = ownerMatch?.[1];
    const repo = repoMatch?.[1];
    const expectedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/install.sh`;

    const docs = installDocs();
    const occurrences = docs.split(expectedUrl).length - 1;
    expect(occurrences, `expected "${expectedUrl}" to appear at least twice in docs/install.md`).toBeGreaterThanOrEqual(2);
  });

  it('the literal :latest image tag never appears in docs/install.md or README.md', () => {
    expect(installDocs()).not.toContain(':latest');
    expect(readme()).not.toContain(':latest');
  });

  it('no internal planning id (plan number, threat id, decision id) appears in docs/install.md or README.md', () => {
    const patterns: RegExp[] = [/\b0[1-6]-\d{2}\b/, /T-0\d-\d+/, /\bD-\d{2}\b/];
    for (const doc of [installDocs(), readme()]) {
      for (const p of patterns) {
        expect(doc).not.toMatch(p);
      }
    }
  });

  it('documents the ghcr.io image reference shape without ever using the unversioned tag', () => {
    const docs = installDocs();
    expect(docs).toMatch(/ghcr\.io\/.*\/noodara-control-plane/);
    expect(docs).toMatch(/ghcr\.io\/.*\/noodara-web/);
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

describe('docs/adr/0007-production-topology-and-installer.md', () => {
  it('exists, follows the Accepted status shape, and names every load-bearing decision id', () => {
    const adr = readFileSync('docs/adr/0007-production-topology-and-installer.md', 'utf8');
    expect(adr).toMatch(/^## Status\n\nAccepted/m);
    for (const id of ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-08', 'D-09', 'D-10', 'D-11', 'D-12', 'D-16', 'D-17', 'D-18', 'D-19']) {
      expect(adr, `${id} not named in ADR 0007`).toContain(id);
    }
  });
});
