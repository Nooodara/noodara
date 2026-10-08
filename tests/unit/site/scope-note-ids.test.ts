// Every <ScopeNote id="..."> in apps/site/content must name a SCOPE_EXCLUSIONS entry. Without
// this, an unknown id only fails at Next prerender (ScopeNote throws), i.e. in the site build.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCOPE_EXCLUSIONS } from '../../../apps/site/src/content/scope';

const CONTENT_DIR = 'apps/site/content';

function mdxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return mdxFiles(full);
    return entry.name.endsWith('.mdx') ? [full] : [];
  });
}

describe('ScopeNote ids used in site content', () => {
  const known = new Set<string>(SCOPE_EXCLUSIONS.map((e) => e.id));

  it('finds at least one ScopeNote usage', () => {
    const total = mdxFiles(CONTENT_DIR).filter((f) => /<ScopeNote\b/.test(readFileSync(f, 'utf8')));
    expect(total.length).toBeGreaterThan(0);
  });

  it('every ScopeNote id exists in SCOPE_EXCLUSIONS', () => {
    const unknown: string[] = [];
    for (const file of mdxFiles(CONTENT_DIR)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/<ScopeNote\s+id=["']([^"']+)["']/g)) {
        const id = m[1];
        if (id !== undefined && !known.has(id)) unknown.push(`${file}: ${id}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
