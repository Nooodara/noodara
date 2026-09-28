// 10-06-PLAN.md Task 1 (D-10): repo-wide scan enforcing content-rules.ts across real site
// content and components. Reads files directly from disk (no execution, no network), modeled
// on tests/unit/site/site-boundary.test.ts's own recursive-listing pattern. RED: written
// before apps/site/src/lib/content-rules.ts exists.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findForbiddenWording, findUnsafeMarkup } from '../../../apps/site/src/lib/content-rules';

/** Recursively lists files under `dir` matching `extensions`, skipping `skip` dir names. */
function listFiles(dir: string, extensions: RegExp, skip: ReadonlySet<string> = new Set(['node_modules', '.next', 'out', '.source'])): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      results.push(...listFiles(fullPath, extensions, skip));
    } else if (extensions.test(entry)) {
      results.push(fullPath);
    }
  }

  return results;
}

describe('D-10 forbidden wording and unsafe markup scan', () => {
  it('scans every content file (apps/site/content/**/*.{mdx,json}, apps/site/src/content/**/*.ts) with zero findings', () => {
    const contentFiles = [
      ...listFiles('apps/site/content', /\.(mdx|json)$/),
      ...listFiles('apps/site/src/content', /\.ts$/),
    ];

    expect(contentFiles.length).toBeGreaterThan(0);

    for (const file of contentFiles) {
      const text = readFileSync(file, 'utf8');
      expect(findForbiddenWording(text), `${file} has forbidden wording`).toEqual([]);
      expect(findUnsafeMarkup(text), `${file} has unsafe markup`).toEqual([]);
    }
  });

  it('scans non-test .tsx files under apps/site/src/components and apps/site/src/app for coming-soon/soon/roadmap only', () => {
    const tsxFiles = [
      ...listFiles('apps/site/src/components', /\.tsx$/),
      ...listFiles('apps/site/src/app', /\.tsx$/),
    ].filter((file) => !file.endsWith('.test.tsx'));

    expect(tsxFiles.length).toBeGreaterThan(0);

    const bannedRules = new Set(['coming-soon', 'soon', 'roadmap']);
    for (const file of tsxFiles) {
      const text = readFileSync(file, 'utf8');
      const findings = findForbiddenWording(text).filter((f) => bannedRules.has(f.rule));
      expect(findings, `${file} has forbidden wording`).toEqual([]);
    }
  });
});
