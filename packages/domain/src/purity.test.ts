import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Machine-enforced purity boundary for packages/domain (RESEARCH Pitfall 4, T-1-03). This test
// is the second half of the boundary alongside Turborepo's `boundaries` check: `turbo boundaries`
// blocks disallowed *workspace package* dependencies, this test blocks disallowed *runtime*
// imports (Node builtins with I/O, and third-party I/O packages) that boundaries doesn't see.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // packages/domain
const SRC_DIR = join(PACKAGE_ROOT, 'src');

// node:crypto is deliberately NOT in this list: it is pure computation (no file/network/process
// I/O) and envelope.ts (Plan 05) needs it for AES-256-GCM. See RESEARCH Pitfall 4.
const BANNED_SPECIFIERS = [
  'node:fs',
  'node:net',
  'node:http',
  'node:child_process',
  'node:dns',
  'pg',
  'drizzle-orm',
  'better-auth',
  'fastify',
  'ioredis',
];

// Excludes *.test.ts: this guard file itself legitimately uses node:fs/node:path to walk the
// tree and is not shipped as part of the domain's runtime surface — only implementation modules
// are subject to the I/O ban.
function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry: string) => {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      return listTsFiles(fullPath);
    }
    return fullPath.endsWith('.ts') && !fullPath.endsWith('.test.ts') ? [fullPath] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const matches = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)];
  return matches.map((match) => match[1] ?? '');
}

describe('packages/domain purity boundary', () => {
  it('declares zod as its only dependency', () => {
    const pkgJson = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(pkgJson.dependencies ?? {})).toEqual(['zod']);
  });

  it('never imports I/O-bearing Node builtins or third-party I/O packages', () => {
    for (const file of listTsFiles(SRC_DIR)) {
      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      for (const specifier of specifiers) {
        expect(
          BANNED_SPECIFIERS.includes(specifier),
          `${file} imports "${specifier}", which is banned in packages/domain (RESEARCH Pitfall 4)`,
        ).toBe(false);
      }
    }
  });

  it('never imports another @noodara/ package', () => {
    for (const file of listTsFiles(SRC_DIR)) {
      const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
      for (const specifier of specifiers) {
        if (!specifier.startsWith('@noodara/')) continue;
        expect(
          specifier === '@noodara/domain' || specifier.startsWith('@noodara/domain/'),
          `${file} imports "${specifier}" — packages/domain must not depend on another @noodara/ package`,
        ).toBe(true);
      }
    }
  });
});
