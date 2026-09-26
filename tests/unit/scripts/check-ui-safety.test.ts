import { describe, expect, it } from 'vitest';

// 08-03-PLAN.md Task 2/3: the two new repo-wide UI safety gates the redesign phase is policed by
// (UI-03 "no shadow outside Sheet/Dialog/RowMenu/AccountMenu", UI-10 "never more than three
// simultaneous backdrop-filter surfaces"), made machine-checked instead of convention-only.
//
// Mirrors tests/unit/scripts/check-posix-sh.test.ts's shape: import the named export straight from
// the `.mjs` file and assert on its return value directly, no real file I/O or spawning the whole
// script needed. Each scan function takes a plain `{ relPath: content }` map so a fixture can
// exercise the allowlist/comment-stripping/counting behaviour without ever touching disk.
import { scanBackdropFilterUsage, scanBuiltinEasingUsage, scanShadowUsage } from '../../../scripts/check-ui-safety.mjs';

describe('scanShadowUsage (UI-03: zero shadows outside Sheet/Dialog/RowMenu/AccountMenu)', () => {
  it('passes on the repo as it stands today (nothing has a shadow)', () => {
    const { total, perFile } = scanShadowUsage({
      'packages/ui/src/Button.tsx': 'export function Button() { return null; }',
      'apps/web/src/components/Toolbar.tsx': 'className="sticky top-0 backdrop-blur"',
    });

    expect(total).toBe(0);
    expect(perFile).toEqual([]);
  });

  it('fails when shadow-[var(--shadow-floating)] appears in packages/ui/src/Button.tsx', () => {
    const { total, perFile } = scanShadowUsage({
      'packages/ui/src/Button.tsx': 'const ROOT_CLASSES = "shadow-[var(--shadow-floating)]";',
    });

    expect(total).toBe(1);
    expect(perFile).toEqual([{ relPath: 'packages/ui/src/Button.tsx', count: 1 }]);
  });

  it('passes when that same string appears in Sheet.tsx, Dialog.tsx, RowMenu.tsx or AccountMenu.tsx', () => {
    const allowlistedPaths = [
      'packages/ui/src/Sheet.tsx',
      'packages/ui/src/Dialog.tsx',
      'packages/ui/src/RowMenu.tsx',
      'packages/ui/src/AccountMenu.tsx',
    ];

    for (const relPath of allowlistedPaths) {
      const { total } = scanShadowUsage({ [relPath]: 'const PANEL_CLASSES = "shadow-[var(--shadow-floating)]";' });
      expect(total, `${relPath} should be allowlisted`).toBe(0);
    }
  });

  it('ignores the string when it occurs only inside a comment line', () => {
    const { total } = scanShadowUsage({
      'packages/ui/src/Button.tsx':
        '// never do this: shadow-[var(--shadow-floating)]\nexport function Button() { return null; }',
    });

    expect(total).toBe(0);
  });

  it('also catches bare box-shadow/drop-shadow declarations outside the allowlist', () => {
    const { total, perFile } = scanShadowUsage({
      'packages/ui/src/StatTile.tsx': 'box-shadow: 0 1px 2px rgba(0,0,0,0.1);',
      'packages/ui/src/CopyButton.tsx': 'filter: drop-shadow(0 1px 1px black);',
    });

    expect(total).toBe(2);
    expect(perFile.map((f) => f.relPath).sort()).toEqual([
      'packages/ui/src/CopyButton.tsx',
      'packages/ui/src/StatTile.tsx',
    ]);
  });
});

describe('scanBackdropFilterUsage (UI-10: at most three simultaneous backdrop-filter surfaces)', () => {
  it('counts distinct files, not total matches -- one file using both backdrop-blur and backdrop-saturate counts once', () => {
    const { total, perFile } = scanBackdropFilterUsage({
      'packages/ui/src/Sheet.tsx': 'className="backdrop-blur-xl backdrop-saturate-[1.8]"',
    });

    expect(total).toBe(1);
    expect(perFile).toEqual([{ relPath: 'packages/ui/src/Sheet.tsx', count: 2 }]);
  });

  // NOTE: the real repo today declares backdrop-filter usage in three files, not two --
  // apps/web/src/components/ServerDetailToolbar.tsx (the server-detail screen's own sticky
  // toolbar) also carries `backdrop-blur`, alongside Sheet.tsx and Toolbar.tsx. 08-UI-SPEC.md
  // SS5.3's "toolbar (1) + Sheet (1) = 2" narrative did not account for this second toolbar
  // component (verified by direct grep of packages/ui/src and apps/web/src -- see 08-03-SUMMARY.md
  // Deviations). The gate still holds at the real count (3 <= 3, the stated budget), it is simply
  // already at the ceiling rather than one below it.
  it('passes at a count of 3 (today: Sheet.tsx, Toolbar.tsx, ServerDetailToolbar.tsx)', () => {
    const { total } = scanBackdropFilterUsage({
      'packages/ui/src/Sheet.tsx': 'backdrop-blur-xl backdrop-saturate-[1.8]',
      'apps/web/src/components/Toolbar.tsx': 'backdrop-blur',
      'apps/web/src/components/ServerDetailToolbar.tsx': 'backdrop-blur',
    });

    expect(total).toBe(3);
  });

  it('fails at a count of 4, naming every file that declares one', () => {
    const fileContents = {
      'packages/ui/src/Sheet.tsx': 'backdrop-blur-xl',
      'apps/web/src/components/Toolbar.tsx': 'backdrop-blur',
      'apps/web/src/components/ServerDetailToolbar.tsx': 'backdrop-blur',
      'packages/ui/src/RowMenu.tsx': 'backdrop-filter: blur(4px);',
    };

    const { total, perFile } = scanBackdropFilterUsage(fileContents);

    expect(total).toBe(4);
    expect(perFile.map((f) => f.relPath).sort()).toEqual(Object.keys(fileContents).sort());
  });

  it('ignores a backdrop-filter mention inside a comment line', () => {
    const { total } = scanBackdropFilterUsage({
      'packages/ui/src/Button.tsx': '// do not add backdrop-blur here\nexport function Button() {}',
    });

    expect(total).toBe(0);
  });
});

// 08-14-PLAN.md Task 3 (UI-05, 08-UI-SPEC.md §7.2, brief §9 #9): the redesign's own duration/
// easing table replaces every CSS built-in easing keyword in the inventory -- `ease-in` has no
// replacement at all (forbidden outright), `ease-out`/`ease-in-out`/`linear` must always resolve
// through a `var(--ease-*)` token reference, never a bare Tailwind easing utility.
describe('scanBuiltinEasingUsage (UI-05: no CSS built-in easing keyword survives in packages/ui)', () => {
  it('passes when every easing reference goes through a var(--ease-*) token', () => {
    const { total, perFile } = scanBuiltinEasingUsage({
      'packages/ui/src/Button.tsx': 'motion-safe:ease-[var(--ease-out)] motion-safe:ease-[var(--ease-standard)]',
    });

    expect(total).toBe(0);
    expect(perFile).toEqual([]);
  });

  it('fails on a bare Tailwind ease-out utility (no var(--ease- token)', () => {
    const { total, perFile } = scanBuiltinEasingUsage({
      'packages/ui/src/Button.tsx': 'className="transition-transform ease-out duration-150"',
    });

    expect(total).toBe(1);
    expect(perFile).toEqual([{ relPath: 'packages/ui/src/Button.tsx', count: 1 }]);
  });

  it('fails on ease-in outright -- it has no token replacement, it is simply forbidden', () => {
    const { total } = scanBuiltinEasingUsage({
      'packages/ui/src/Button.tsx': 'className="ease-in"',
    });

    expect(total).toBe(1);
  });

  it('fails on bare linear, and on ease-in-out written without the var(--ease- form', () => {
    const { total, perFile } = scanBuiltinEasingUsage({
      'packages/ui/src/StatTile.tsx': 'ease-linear',
      'packages/ui/src/Skeleton.tsx': 'ease-in-out',
    });

    expect(total).toBe(2);
    expect(perFile.map((f) => f.relPath).sort()).toEqual(['packages/ui/src/Skeleton.tsx', 'packages/ui/src/StatTile.tsx']);
  });

  it('ignores a mention inside a comment line', () => {
    const { total } = scanBuiltinEasingUsage({
      'packages/ui/src/Button.tsx': '// never use ease-in here\nexport function Button() {}',
    });

    expect(total).toBe(0);
  });

  it('excludes packages/ui/tokens.css -- the one legitimate place the token definitions themselves live', () => {
    const { total } = scanBuiltinEasingUsage({
      'packages/ui/tokens.css': '--ease-out: cubic-bezier(0.23, 1, 0.32, 1);\n--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);',
    });

    expect(total).toBe(0);
  });
});
