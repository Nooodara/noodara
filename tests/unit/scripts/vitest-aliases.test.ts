import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { domainSourceAliases, sshSourceAliases, uiSourceAliases } from '../../../vitest.shared.js';

// Quick 260928-m8j: the first clean-checkout CI run (public main 50473ae) failed 27 unit test
// files with `Cannot find package '@noodara/domain/preferences'` -- packages/domain/package.json
// grew a `./preferences` export (01-16-PLAN.md-style subpath) but nobody added the matching
// vitest.shared.ts source alias, so every in-process Vitest run fell through to the package's real
// `exports` map, which points at a `dist/` that a clean checkout never built. This test makes that
// class of drift structurally impossible: it reads the real `exports` map of every package whose
// source aliases live in vitest.shared.ts (domain, ssh, ui) and asserts every JS/TS subpath export
// has a matching alias that resolves to a real file on disk -- so a new subpath can never again be
// forgotten here.

interface AliasEntry {
  find: string | RegExp;
  replacement: string;
}

function findAlias(aliases: readonly AliasEntry[], specifier: string): AliasEntry | undefined {
  return aliases.find((alias) =>
    typeof alias.find === 'string' ? alias.find === specifier : alias.find.test(specifier),
  );
}

interface PackageCase {
  packageName: string;
  packageJsonPath: string;
  aliases: readonly AliasEntry[];
}

const packages: PackageCase[] = [
  { packageName: '@noodara/domain', packageJsonPath: 'packages/domain/package.json', aliases: domainSourceAliases as AliasEntry[] },
  { packageName: '@noodara/ssh', packageJsonPath: 'packages/ssh/package.json', aliases: sshSourceAliases as AliasEntry[] },
  { packageName: '@noodara/ui', packageJsonPath: 'packages/ui/package.json', aliases: uiSourceAliases as AliasEntry[] },
];

describe('vitest.shared.ts source aliases cover every JS/TS subpath export', () => {
  for (const { packageName, packageJsonPath, aliases } of packages) {
    it(`${packageName}: every JS/TS subpath in exports has a matching alias pointing at a real file`, () => {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { exports?: Record<string, unknown> };
      const exportsMap = pkg.exports ?? {};

      // Non-JS asset exports (tokens.css, theme.css, aperture.css, brand/*) are plain string
      // values in the exports map, not { types, default } objects -- they are static assets
      // served straight from source and have nothing for Vitest to alias.
      const jsSubpaths = Object.entries(exportsMap)
        .filter(([key, value]) => key !== '.' && typeof value === 'object' && value !== null)
        .map(([key]) => key.slice(2)); // './preferences' -> 'preferences'

      for (const subpath of jsSubpaths) {
        const specifier = `${packageName}/${subpath}`;
        const alias = findAlias(aliases, specifier);

        expect(alias, `no vitest.shared.ts alias found for "${specifier}"`).toBeDefined();
        expect(
          existsSync(alias!.replacement),
          `alias for "${specifier}" points at a non-existent file: ${alias!.replacement}`,
        ).toBe(true);
      }
    });
  }
});
