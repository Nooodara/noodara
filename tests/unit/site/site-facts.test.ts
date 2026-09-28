// 10-09-PLAN.md Task 1 (D-01/D-17, T-10-12). site-facts.ts ties the landing's install command,
// GitHub URL and approved-screenshot list to install.sh, README.md and docs/ui/approved -- never
// a hand-typed literal. RED: written before apps/site/src/lib/site-facts.ts exists. Mirrors
// tests/unit/docs/install-docs-accuracy.test.ts's "read from disk, diff against install.sh"
// discipline.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVED_SCREENS, GITHUB_URL, INSTALL_COMMAND, INSTALL_SCRIPT_URL } from '../../../apps/site/src/lib/site-facts';

const installSh = () => readFileSync('install.sh', 'utf8');
const readme = () => readFileSync('README.md', 'utf8');
const installMdx = () => readFileSync('apps/site/content/docs/getting-started/install.mdx', 'utf8');

describe('INSTALL_SCRIPT_URL / INSTALL_COMMAND / GITHUB_URL', () => {
  it("INSTALL_SCRIPT_URL is built from install.sh's own NOODARA_REPO_OWNER / NOODARA_REPO_NAME defaults", () => {
    const source = installSh();
    const ownerMatch = source.match(/NOODARA_REPO_OWNER="\$\{NOODARA_REPO_OWNER:-([A-Za-z0-9_-]+)\}"/);
    const repoMatch = source.match(/NOODARA_REPO_NAME="\$\{NOODARA_REPO_NAME:-([A-Za-z0-9_-]+)\}"/);
    expect(ownerMatch, 'NOODARA_REPO_OWNER default not found in install.sh').toBeTruthy();
    expect(repoMatch, 'NOODARA_REPO_NAME default not found in install.sh').toBeTruthy();
    const owner = ownerMatch?.[1];
    const repo = repoMatch?.[1];

    expect(INSTALL_SCRIPT_URL).toBe(`https://raw.githubusercontent.com/${owner}/${repo}/main/install.sh`);
  });

  it('INSTALL_COMMAND pipes INSTALL_SCRIPT_URL to sh', () => {
    expect(INSTALL_COMMAND).toBe(`curl -fsSL ${INSTALL_SCRIPT_URL} | sh`);
  });

  it('INSTALL_COMMAND appears verbatim in README.md', () => {
    expect(readme()).toContain(INSTALL_COMMAND);
  });

  it('INSTALL_COMMAND appears verbatim in the Install docs page', () => {
    expect(installMdx()).toContain(INSTALL_COMMAND);
  });

  it("GITHUB_URL is built from install.sh's own owner/repo defaults", () => {
    const source = installSh();
    const ownerMatch = source.match(/NOODARA_REPO_OWNER="\$\{NOODARA_REPO_OWNER:-([A-Za-z0-9_-]+)\}"/);
    const repoMatch = source.match(/NOODARA_REPO_NAME="\$\{NOODARA_REPO_NAME:-([A-Za-z0-9_-]+)\}"/);
    const owner = ownerMatch?.[1];
    const repo = repoMatch?.[1];

    expect(GITHUB_URL).toBe(`https://github.com/${owner}/${repo}`);
  });
});

describe('APPROVED_SCREENS', () => {
  it('equals the six approved screens, in ProductTour tab order', () => {
    expect(APPROVED_SCREENS).toEqual(['setup', 'login', 'servers', 'server-detail', 'activity', 'settings']);
  });

  it('every screen has both a light and a dark PNG under docs/ui/approved', () => {
    for (const screen of APPROVED_SCREENS) {
      for (const theme of ['light', 'dark'] as const) {
        const filePath = path.join('docs', 'ui', 'approved', `${screen}-${theme}.png`);
        expect(existsSync(filePath), `${filePath} does not exist`).toBe(true);
      }
    }
  });
});
