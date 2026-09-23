// 07-04-PLAN.md Task 1: the review artifact layout, pinned before anything writes a PNG.
//
// Two scripts (render-boards.ts and capture-brand-review.ts) and, later, the approval plan (07-05)
// all have to agree on where a capture lives. That agreement is this module, not a string
// duplicated in three places -- and it is computed from `import.meta.dirname`, never
// `process.cwd()`, so `pnpm brand:review` produces the same paths whatever directory it is invoked
// from.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONCEPT_IDS } from '../../../packages/ui/src/brand/geometry.js';
import { REVIEW_ROOT, REVIEW_SURFACES, THEMES, reviewPngPath } from '../../../scripts/brand/review-paths.js';

const SOURCE = readFileSync('scripts/brand/review-paths.ts', 'utf8');

describe('REVIEW_SURFACES', () => {
  it('holds exactly the four in-app review surfaces, in the order the capture script visits them', () => {
    expect([...REVIEW_SURFACES]).toEqual(['sidebar-expanded', 'sidebar-rail', 'login', 'setup']);
  });

  it('holds both themes', () => {
    expect([...THEMES]).toEqual(['light', 'dark']);
  });
});

describe('REVIEW_ROOT', () => {
  it('is an absolute path ending in docs/brand/review', () => {
    expect(path.isAbsolute(REVIEW_ROOT)).toBe(true);
    expect(REVIEW_ROOT.endsWith(path.join('docs', 'brand', 'review'))).toBe(true);
  });

  it('is derived from the module location, never from the working directory', () => {
    expect(SOURCE).not.toContain('process.cwd');
    expect(SOURCE).toContain('import.meta.dirname');
  });
});

describe('reviewPngPath', () => {
  it('places an in-app capture at <review root>/<concept>/<surface>-<theme>.png', () => {
    expect(reviewPngPath('a', 'login', 'dark')).toBe(path.join(REVIEW_ROOT, 'a', 'login-dark.png'));
    expect(reviewPngPath('c', 'sidebar-rail', 'light')).toBe(path.join(REVIEW_ROOT, 'c', 'sidebar-rail-light.png'));
  });

  it('places a board at <review root>/<concept>/board-<theme>.png', () => {
    expect(reviewPngPath('b', 'board', 'light')).toBe(path.join(REVIEW_ROOT, 'b', 'board-light.png'));
  });

  it('suffixes a cropped variant with -crop, keeping it beside its own full capture', () => {
    expect(reviewPngPath('a', 'sidebar-expanded', 'dark', 'crop')).toBe(
      path.join(REVIEW_ROOT, 'a', 'sidebar-expanded-dark-crop.png'),
    );
  });

  it('never collides across the full concept x surface x theme matrix', () => {
    const paths = new Set<string>();
    for (const concept of CONCEPT_IDS) {
      for (const surface of [...REVIEW_SURFACES, 'board'] as const) {
        for (const theme of THEMES) {
          paths.add(reviewPngPath(concept, surface, theme));
        }
      }
    }
    expect(paths.size).toBe(CONCEPT_IDS.length * (REVIEW_SURFACES.length + 1) * THEMES.length);
  });
});
