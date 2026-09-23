// 07-09-PLAN.md Task 1 (BRAND-02, D-11/D-12, RESEARCH Pitfall 3): the allowlisted, idempotent sync
// that copies `packages/ui/brand/*` into `apps/web/src/app/` before every dev run and build. This
// test imports the real `.mjs` module directly (mirrors
// tests/unit/scripts/check-package-provenance.test.ts's own precedent for a testable, isMainModule
// -guarded script), never a re-implementation of its copy logic.
//
// Every case below runs against throwaway `mkdtempSync` directories -- never the real
// packages/ui/brand or apps/web/src/app -- so this test can corrupt/omit a source file freely
// without touching a single committed asset.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRAND_SYNC_FILES, syncBrandAssets } from '../../../apps/web/scripts/sync-brand-assets.mjs';

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

/** Writes every BRAND_SYNC_FILES source into `srcDir`, each with distinguishable byte content
 *  (the source-relative-path itself) so a byte-equality assertion is meaningful. */
function seedSources(srcDir: string): void {
  for (const srcName of Object.values(BRAND_SYNC_FILES)) {
    writeFileSync(path.join(srcDir, srcName), `content-of-${srcName}`);
  }
}

describe('apps/web/scripts/sync-brand-assets.mjs BRAND_SYNC_FILES', () => {
  it('has exactly the 7 dest:src entries the interface specifies', () => {
    expect(BRAND_SYNC_FILES).toEqual({
      'favicon.ico': 'favicon.ico',
      'icon.svg': 'favicon.svg',
      'icon1.png': 'icon-192.png',
      'icon2.png': 'icon-512.png',
      'apple-icon.png': 'apple-touch-icon.png',
      'opengraph-image.png': 'og-image.png',
      'brand-colors.json': 'brand-colors.json',
    });
  });
});

describe('apps/web/scripts/sync-brand-assets.mjs syncBrandAssets', () => {
  it('copies exactly 7 files under the allowlisted dest names when every source is present', () => {
    const srcDir = makeTempDir('brand-sync-src-');
    const destDir = makeTempDir('brand-sync-dest-');
    seedSources(srcDir);

    const result = syncBrandAssets({ srcDir, destDir });

    expect(result.written.sort()).toEqual(Object.keys(BRAND_SYNC_FILES).sort());
    expect(result.unchanged).toEqual([]);

    for (const [destName, srcName] of Object.entries(BRAND_SYNC_FILES)) {
      const destBytes = readFileSync(path.join(destDir, destName));
      const srcBytes = readFileSync(path.join(srcDir, srcName));
      expect(destBytes.equals(srcBytes)).toBe(true);
    }
  });

  it('a second call against unchanged sources reports every file unchanged, writes none', () => {
    const srcDir = makeTempDir('brand-sync-src-');
    const destDir = makeTempDir('brand-sync-dest-');
    seedSources(srcDir);

    syncBrandAssets({ srcDir, destDir });
    const second = syncBrandAssets({ srcDir, destDir });

    expect(second.written).toEqual([]);
    expect(second.unchanged.sort()).toEqual(Object.keys(BRAND_SYNC_FILES).sort());
  });

  it('never writes or deletes a file whose name is not a key of BRAND_SYNC_FILES', () => {
    const srcDir = makeTempDir('brand-sync-src-');
    const destDir = makeTempDir('brand-sync-dest-');
    seedSources(srcDir);
    const foreignPath = path.join(destDir, 'extra.txt');
    writeFileSync(foreignPath, 'not part of the allowlist');

    syncBrandAssets({ srcDir, destDir });

    expect(readFileSync(foreignPath, 'utf8')).toBe('not part of the allowlist');
    // The allowlist entries are the only new files added -- 'extra.txt' plus the 7 dest names.
    const entries = readdirSync(destDir).sort();
    expect(entries).toEqual([...Object.keys(BRAND_SYNC_FILES), 'extra.txt'].sort());
  });

  it('throws by name when a source is missing, mentioning pnpm brand:generate', () => {
    const srcDir = makeTempDir('brand-sync-src-');
    const destDir = makeTempDir('brand-sync-dest-');
    seedSources(srcDir);
    rmSync(path.join(srcDir, 'favicon.ico'));

    expect(() => syncBrandAssets({ srcDir, destDir })).toThrowError(/favicon\.ico/);
    expect(() => syncBrandAssets({ srcDir, destDir })).toThrowError(/pnpm brand:generate/);
  });
});
