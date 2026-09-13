import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Machine-enforced containment boundary for `ssh2` (SEC-04, T-2-03). Turborepo's `boundaries`
// check blocks disallowed *workspace package* dependencies; this test blocks the one thing it
// cannot see — a bare `ssh2` import landing in a file that isn't part of `packages/ssh`.
const SSH_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // packages/ssh
const REPO_ROOT = dirname(dirname(SSH_PACKAGE_ROOT)); // repo root

const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages'),
  join(REPO_ROOT, 'apps'),
  join(REPO_ROOT, 'tests'),
];

function listTsFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry: string) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') return [];
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      return listTsFiles(fullPath);
    }
    return fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') ? [fullPath] : [];
  });
}

function findFilesUnder(root: string): string[] {
  // packages/*/src, apps/*/src, and tests/** — mirrors packages/domain/src/purity.test.ts's
  // own path-resolution style, walked from this file's own location.
  return listTsFiles(root);
}

function importSpecifiers(source: string): string[] {
  const matches = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)];
  return matches.map((match) => match[1] ?? '');
}

function isUnderSshPackage(filePath: string): boolean {
  return filePath.startsWith(SSH_PACKAGE_ROOT + '/');
}

describe('ssh2 containment boundary', () => {
  it('is only imported from files under packages/ssh', () => {
    const allFiles = SCAN_ROOTS.flatMap((root) => findFilesUnder(root));

    for (const file of allFiles) {
      if (isUnderSshPackage(file)) continue;

      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      expect(
        specifiers.includes('ssh2'),
        `${file} imports "ssh2", which may only be imported from packages/ssh (SEC-04, T-2-03)`,
      ).toBe(false);
    }
  });

  it('declares dependencies as exactly @noodara/domain and ssh2', () => {
    const pkgJson = JSON.parse(
      readFileSync(join(SSH_PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(pkgJson.dependencies ?? {}).sort()).toEqual(['@noodara/domain', 'ssh2']);
  });
});
