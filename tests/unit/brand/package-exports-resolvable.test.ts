// 07-06-PLAN.md Task 3: proves `packages/ui`'s `"./brand/*"` export is resolvable from OUTSIDE
// `packages/ui` -- specifically from `apps/web`'s own package location, through the real
// `node_modules/@noodara/ui` workspace symlink -- so Phase 10's future `apps/site` (or any other
// workspace package) can read `@noodara/ui/brand/<file>` with no copy step (ROADMAP.md success
// criterion 4).
//
// `vitest.shared.ts`'s `uiSourceAliases` only covers the bare `@noodara/ui` specifier and
// `@noodara/ui/testing` -- neither entry matches `@noodara/ui/brand/*`, so a resolution here goes
// through Node's OWN `exports` map resolution algorithm, not a Vitest alias standing in for it.
// That is exactly what this test needs to prove: a Vitest-only pass would prove nothing about
// Phase 10's real runtime.

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// `createRequire` needs a `file://` URL for the location whose `node_modules` resolution it
// should use -- passing `apps/web/package.json`'s own location means this `require.resolve` walks
// exactly the same resolution `apps/web`'s own source would use to import from `@noodara/ui`.
const webRequire = createRequire(pathToFileURL(path.resolve('apps/web/package.json')));

function resolveFileUrl(specifier: string): string {
  const resolved = webRequire.resolve(specifier);
  return pathToFileURL(resolved).href;
}

describe('"./brand/*" export resolves from apps/web (outside packages/ui)', () => {
  it('resolves @noodara/ui/brand/lockup-dark.svg to the real committed file', () => {
    const url = resolveFileUrl('@noodara/ui/brand/lockup-dark.svg');
    expect(url.endsWith('packages/ui/brand/lockup-dark.svg')).toBe(true);
  });

  it('resolves @noodara/ui/brand/favicon.ico to the real committed file', () => {
    const url = resolveFileUrl('@noodara/ui/brand/favicon.ico');
    expect(url.endsWith('packages/ui/brand/favicon.ico')).toBe(true);
  });

  it('resolves @noodara/ui/brand/brand-colors.json to the real committed file', () => {
    const url = resolveFileUrl('@noodara/ui/brand/brand-colors.json');
    expect(url.endsWith('packages/ui/brand/brand-colors.json')).toBe(true);
  });

  it('never lets the wildcard escape the brand/ prefix (no path traversal)', () => {
    expect(() => webRequire.resolve('@noodara/ui/brand/../src/index.ts')).toThrow();
  });
});
