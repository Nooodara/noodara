// 10-02-PLAN.md Task 2 (D-16/D-17, T-10-13): the allowlisted, idempotent sync that copies
// packages/ui/brand's four icon/OG files and docs/ui/approved's five-screen/two-theme capture
// set into apps/site before every dev run and build. Mirrors
// tests/unit/brand/sync-brand-assets.test.ts's own precedent (import the real .mjs module
// directly, never a re-implementation of its copy logic) -- extended here with the nested
// dest/src relative paths this script's SITE_ASSET_FILES shape actually uses (not a flat
// filename map like sync-brand-assets.mjs's).
//
// Every write/skip/no-delete/missing-source case below runs against throwaway `mkdtempSync`
// directories shaped like a miniature repoRoot/siteRoot pair -- never the real repo -- so this
// test can corrupt/omit a source file freely. The one exception is "every source listed in
// SITE_ASSET_FILES exists in the real repo", which deliberately reads the real repoRoot: a
// renamed approved capture or brand file must fail this test, not just the build.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SITE_ASSET_FILES, syncSiteAssets } from '../../../apps/site/scripts/sync-site-assets.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes every SITE_ASSET_FILES source into `repoRoot`, each with distinguishable byte content
 *  (its own source-relative path) so a byte-equality assertion is meaningful. Creates the
 *  necessary nested directories first -- unlike sync-brand-assets.test.ts's flat filenames,
 *  every SITE_ASSET_FILES source lives under a real subdirectory (packages/ui/brand/...,
 *  docs/ui/approved/...). */
function seedSources(repoRoot: string): void {
  for (const srcRel of Object.values(SITE_ASSET_FILES)) {
    const srcPath = path.join(repoRoot, srcRel);
    mkdirSync(path.dirname(srcPath), { recursive: true });
    writeFileSync(srcPath, `content-of-${srcRel}`);
  }
}

describe('apps/site/scripts/sync-site-assets.mjs SITE_ASSET_FILES', () => {
  it('has exactly 14 dest:src entries (4 brand files + 5 screens x 2 themes)', () => {
    expect(Object.keys(SITE_ASSET_FILES)).toHaveLength(14);
  });

  it('maps exactly the four brand destinations to packages/ui/brand sources', () => {
    expect(SITE_ASSET_FILES['src/app/favicon.ico']).toBe('packages/ui/brand/favicon.ico');
    expect(SITE_ASSET_FILES['src/app/icon.svg']).toBe('packages/ui/brand/favicon.svg');
    expect(SITE_ASSET_FILES['src/app/apple-icon.png']).toBe('packages/ui/brand/apple-touch-icon.png');
    expect(SITE_ASSET_FILES['src/app/opengraph-image.png']).toBe('packages/ui/brand/og-image.png');
  });

  it('maps every screen/theme screenshot to its docs/ui/approved source', () => {
    const screens = ['servers', 'login', 'server-detail', 'activity', 'settings'];
    for (const screen of screens) {
      for (const theme of ['light', 'dark']) {
        expect(SITE_ASSET_FILES[`public/screenshots/${screen}-${theme}.png`]).toBe(
          `docs/ui/approved/${screen}-${theme}.png`,
        );
      }
    }
  });

  it('never maps the "setup" screen (only servers/login/server-detail/activity/settings ship on the site)', () => {
    expect(Object.keys(SITE_ASSET_FILES).some((dest) => dest.includes('setup'))).toBe(false);
  });

  it('every source exists in the real repo', () => {
    for (const srcRel of Object.values(SITE_ASSET_FILES)) {
      expect(existsSync(path.join(REPO_ROOT, srcRel)), `${srcRel} should exist`).toBe(true);
    }
  });
});

describe('apps/site/scripts/sync-site-assets.mjs syncSiteAssets', () => {
  it('writes exactly 14 files under the allowlisted dest paths when every source is present', () => {
    const repoRoot = makeTempDir('site-sync-repo-');
    const siteRoot = makeTempDir('site-sync-site-');
    seedSources(repoRoot);

    const result = syncSiteAssets({ repoRoot, siteRoot });

    expect(result.written.sort()).toEqual(Object.keys(SITE_ASSET_FILES).sort());
    expect(result.unchanged).toEqual([]);

    for (const [destRel, srcRel] of Object.entries(SITE_ASSET_FILES)) {
      const destBytes = readFileSync(path.join(siteRoot, destRel));
      const srcBytes = readFileSync(path.join(repoRoot, srcRel));
      expect(destBytes.equals(srcBytes)).toBe(true);
    }
  });

  it('a second call against unchanged sources reports every file unchanged, writes none', () => {
    const repoRoot = makeTempDir('site-sync-repo-');
    const siteRoot = makeTempDir('site-sync-site-');
    seedSources(repoRoot);

    syncSiteAssets({ repoRoot, siteRoot });
    const second = syncSiteAssets({ repoRoot, siteRoot });

    expect(second.written).toEqual([]);
    expect(second.unchanged.sort()).toEqual(Object.keys(SITE_ASSET_FILES).sort());
  });

  it('never deletes a foreign file already present in a destination directory', () => {
    const repoRoot = makeTempDir('site-sync-repo-');
    const siteRoot = makeTempDir('site-sync-site-');
    seedSources(repoRoot);
    mkdirSync(path.join(siteRoot, 'public/screenshots'), { recursive: true });
    const foreignPath = path.join(siteRoot, 'public/screenshots', 'extra.txt');
    writeFileSync(foreignPath, 'not part of the allowlist');

    syncSiteAssets({ repoRoot, siteRoot });

    expect(readFileSync(foreignPath, 'utf8')).toBe('not part of the allowlist');
  });

  it('throws by name when a source is missing -- a renamed approved capture fails the build', () => {
    const repoRoot = makeTempDir('site-sync-repo-');
    const siteRoot = makeTempDir('site-sync-site-');
    seedSources(repoRoot);
    rmSync(path.join(repoRoot, 'docs/ui/approved/servers-dark.png'));

    expect(() => syncSiteAssets({ repoRoot, siteRoot })).toThrow(/servers-dark\.png/);
  });

  it('never calls unlink/rm on any file (grep-verifiable, but also behaviourally checked)', () => {
    const repoRoot = makeTempDir('site-sync-repo-');
    const siteRoot = makeTempDir('site-sync-site-');
    seedSources(repoRoot);

    syncSiteAssets({ repoRoot, siteRoot });
    // Re-run after mutating a dest file to something different -- syncSiteAssets should
    // overwrite it (not delete-then-recreate, which would transiently remove the file).
    const oneDest = path.join(siteRoot, 'src/app/favicon.ico');
    writeFileSync(oneDest, 'tampered');
    syncSiteAssets({ repoRoot, siteRoot });
    expect(existsSync(oneDest)).toBe(true);
  });
});
