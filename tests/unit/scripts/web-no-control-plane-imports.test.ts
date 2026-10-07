import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 14-18 A2: the web image is built from a turbo-pruned workspace that has no apps/control-plane
// source, so web must take API contract types from @noodara/domain/api-contract only.

const WEB_SRC = join(process.cwd(), 'apps/web');
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo']);
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g;

export function findControlPlaneImports(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)]
    .map((m) => m[1] as string)
    .filter((spec) => /(^|\/)control-plane(\/|$)/.test(spec) && (spec.startsWith('.') || spec.startsWith('apps/')));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|jsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

describe('apps/web does not import apps/control-plane source', () => {
  it('detects relative and apps/ imports of control-plane', () => {
    expect(findControlPlaneImports(`import { a } from '../../../control-plane/src/routes/x.js';`)).toHaveLength(1);
    expect(findControlPlaneImports(`const m = await import('../../control-plane/src/y');`)).toHaveLength(1);
    expect(findControlPlaneImports(`import { a } from '@noodara/domain/api-contract';`)).toEqual([]);
  });

  it('has no such import in any web file', () => {
    const offenders = walk(WEB_SRC).filter((f) => findControlPlaneImports(readFileSync(f, 'utf8')).length > 0);
    expect(offenders).toEqual([]);
  });
});
