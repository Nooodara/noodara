// 08-01-PLAN.md Task 1: the UI review matrix layout, pinned before anything writes a PNG.
//
// Mirrors tests/unit/brand/review-paths.test.ts's own shape (Phase 7 precedent) exactly:
// scripts/ui/capture-ui-review.ts and, later, docs/ui/APPROVAL.md's pin test both have to agree on
// where a capture lives and what the full matrix is. That agreement is this module, not a string
// duplicated in three places -- and it is computed from `import.meta.dirname`, never
// `process.cwd()`, so `pnpm ui:review` produces the same paths whatever directory it is invoked
// from.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_ROOT,
  approvedPngPath,
  OVERLAYS,
  REVIEW_ROOT,
  reviewPngPath,
  SCREENS,
  THEMES,
  WIDTHS,
} from '../../../scripts/ui/review-paths.js';

const SOURCE = readFileSync('scripts/ui/review-paths.ts', 'utf8');

describe('SCREENS', () => {
  it('holds exactly the six redesigned screens, in the order the capture script visits them', () => {
    expect([...SCREENS]).toEqual(['setup', 'login', 'servers', 'server-detail', 'activity', 'settings']);
  });
});

describe('OVERLAYS', () => {
  it('holds exactly the four overlay surfaces', () => {
    expect([...OVERLAYS]).toEqual(['sheet-open', 'dialog-open', 'row-menu-open', 'account-menu-open']);
  });
});

describe('THEMES and WIDTHS', () => {
  it('holds both themes', () => {
    expect([...THEMES]).toEqual(['light', 'dark']);
  });

  it('holds exactly the four review widths', () => {
    expect([...WIDTHS]).toEqual([375, 900, 1280, 1920]);
  });
});

describe('REVIEW_ROOT and APPROVED_ROOT', () => {
  it('are absolute paths ending in docs/ui/review and docs/ui/approved', () => {
    expect(path.isAbsolute(REVIEW_ROOT)).toBe(true);
    expect(REVIEW_ROOT.endsWith(path.join('docs', 'ui', 'review'))).toBe(true);
    expect(path.isAbsolute(APPROVED_ROOT)).toBe(true);
    expect(APPROVED_ROOT.endsWith(path.join('docs', 'ui', 'approved'))).toBe(true);
  });

  it('are derived from the module location, never from the working directory', () => {
    expect(SOURCE).not.toContain('process.cwd');
    expect(SOURCE).toContain('import.meta.dirname');
  });
});

describe('reviewPngPath', () => {
  it('places a screen capture at <review root>/<screen>-<theme>-<width>.png', () => {
    expect(reviewPngPath('servers', 'dark', 1280)).toBe(path.join(REVIEW_ROOT, 'servers-dark-1280.png'));
    expect(reviewPngPath('setup', 'light', 375)).toBe(path.join(REVIEW_ROOT, 'setup-light-375.png'));
  });

  it('places an overlay capture the same way, keyed by its own surface name', () => {
    expect(reviewPngPath('sheet-open', 'dark', 1920)).toBe(path.join(REVIEW_ROOT, 'sheet-open-dark-1920.png'));
  });

  it('is identical regardless of process.cwd()', () => {
    const before = reviewPngPath('servers', 'dark', 1280);
    const originalCwd = process.cwd();
    process.chdir(path.resolve(originalCwd, 'scripts'));
    try {
      expect(reviewPngPath('servers', 'dark', 1280)).toBe(before);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('never collides across the full screens x overlays x themes x widths matrix', () => {
    const paths = new Set<string>();
    for (const surface of [...SCREENS, ...OVERLAYS] as const) {
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          paths.add(reviewPngPath(surface, theme, width));
        }
      }
    }
    expect(paths.size).toBe((SCREENS.length + OVERLAYS.length) * THEMES.length * WIDTHS.length);
  });
});

describe('approvedPngPath', () => {
  it('places an approved screen capture at <approved root>/<screen>-<theme>.png, no width', () => {
    expect(approvedPngPath('servers', 'dark')).toBe(path.join(APPROVED_ROOT, 'servers-dark.png'));
    expect(approvedPngPath('setup', 'light')).toBe(path.join(APPROVED_ROOT, 'setup-light.png'));
  });

  it('produces exactly SCREENS x THEMES files (12), one per screen per theme', () => {
    const paths = new Set<string>();
    for (const screen of SCREENS) {
      for (const theme of THEMES) {
        paths.add(approvedPngPath(screen, theme));
      }
    }
    expect(paths.size).toBe(SCREENS.length * THEMES.length);
    expect(paths.size).toBe(12);
  });
});
