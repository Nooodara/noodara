import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 10-01-PLAN.md Task 3 (SITE-02): apps/site is a public, statically-exported artifact and must
// never pull in the control plane, the web app, the SSH adapter, or the domain package. The full
// CONTEXT boundary requirement (no control-plane, no domain, no ssh, ui allowed) is enforced by
// TWO mechanisms together, because a turbo `public-site` tag rule cannot reach every one of those
// four packages on its own:
//   1. a turbo `public-site` tag denying @noodara/control-plane and @noodara/web (added to
//      turbo.json by this same task) -- both are unreachable from apps/site's real dependency
//      graph today, so a turbo-level deny works cleanly for these two.
//   2. this test's manifest + import scan, which is the ONLY enforcement for @noodara/domain and
//      @noodara/ssh, for two independent reasons:
//      - @noodara/domain: turbo boundary tags are TRANSITIVE (Context7 /vercel/turborepo: "rules
//        are applied even for dependencies of dependencies"), and packages/ui/package.json (the
//        explicitly-allowed @noodara/ui) itself depends on @noodara/domain (e.g. ThemeToggle/tone
//        imports `@noodara/domain/preferences`) -- a turbo-level deny of @noodara/domain would
//        therefore also block the allowed @noodara/ui.
//      - @noodara/ssh: the monorepo ROOT package.json has its own, unrelated and legitimate
//        `"@noodara/ssh": "workspace:*"` devDependency (needed to typecheck
//        tests/integration/ssh/**, which import `@noodara/ssh` directly and live outside any
//        workspace package). `turbo boundaries` treats that root-level dependency as reachable
//        from every workspace package's own graph -- confirmed empirically: adding "ssh-adapter"
//        to this tag's turbo deny list fails `pnpm boundaries` for @noodara/site even though
//        apps/site's own package.json and source files never reference @noodara/ssh at all (this
//        test's own "no forbidden dependency"/"no forbidden import" checks below pass either
//        way). Removing root's own @noodara/ssh devDependency to work around this would break an
//        unrelated, pre-existing integration-test typecheck path -- out of scope for this plan --
//        so ssh-adapter is deliberately left off the turbo tag's deny list and enforced here only.
// Modeled structurally on tests/unit/scripts/check-workflow-pins.test.ts's "read the real files on
// disk, no network, no execution" pattern.

const FORBIDDEN_SCOPED_PACKAGE_PATTERN = /^@noodara\/(domain|control-plane|web|ssh)(\/.*)?$/;
const FORBIDDEN_RELATIVE_SEGMENTS = ['control-plane/', 'apps/web/'];

const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Scans `source` for static `from '<spec>'`, dynamic `import('<spec>')` and `require('<spec>')`
 * specifiers, and returns one finding per specifier that reaches a forbidden target: any
 * `@noodara/(domain|control-plane|web|ssh)` scoped package (with or without a subpath), or a
 * relative specifier that walks into `apps/control-plane` or `apps/web` by path segment.
 */
function findForbiddenSiteImports(source) {
  const findings = [];

  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];

      if (FORBIDDEN_SCOPED_PACKAGE_PATTERN.test(specifier)) {
        findings.push({ specifier });
        continue;
      }

      if (FORBIDDEN_RELATIVE_SEGMENTS.some((segment) => specifier.includes(segment))) {
        findings.push({ specifier });
      }
    }
  }

  return findings;
}

/** Recursively lists files under `dir`, skipping node_modules/.next/out/.source. */
function listSiteSourceFiles(dir) {
  const skip = new Set(['node_modules', '.next', 'out', '.source']);
  const results = [];

  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      results.push(...listSiteSourceFiles(fullPath));
    } else if (/\.(mjs|cjs|js|ts|tsx|mdx)$/.test(entry)) {
      results.push(fullPath);
    }
  }

  return results;
}

describe('findForbiddenSiteImports', () => {
  it('flags a static import from @noodara/domain', () => {
    const findings = findForbiddenSiteImports("import { x } from '@noodara/domain';");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ specifier: '@noodara/domain' });
  });

  it('flags a subpath import of @noodara/domain', () => {
    const findings = findForbiddenSiteImports("import { tone } from '@noodara/domain/preferences';");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ specifier: '@noodara/domain/preferences' });
  });

  it('flags a static import of @noodara/control-plane', () => {
    const findings = findForbiddenSiteImports("import { db } from '@noodara/control-plane';");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ specifier: '@noodara/control-plane' });
  });

  it('flags a relative escape hatch into apps/control-plane', () => {
    const findings = findForbiddenSiteImports(
      "import { httpErrors } from '../../control-plane/src/routes/http-errors';",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ specifier: '../../control-plane/src/routes/http-errors' });
  });

  it('flags a dynamic import() of @noodara/web', () => {
    const findings = findForbiddenSiteImports("const web = await import('@noodara/web');");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ specifier: '@noodara/web' });
  });

  it('flags a require() of @noodara/ssh', () => {
    const findings = findForbiddenSiteImports("const ssh = require('@noodara/ssh');");

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ specifier: '@noodara/ssh' });
  });

  it('returns [] for @noodara/ui, a fumadocs-ui subpath and a local relative import', () => {
    expect(findForbiddenSiteImports("import { Button } from '@noodara/ui';")).toEqual([]);
    expect(findForbiddenSiteImports("import Layout from 'fumadocs-ui/layouts/docs';")).toEqual([]);
    expect(findForbiddenSiteImports("import { SITE_ORIGIN } from './site-config.mjs';")).toEqual([]);
  });
});

describe('apps/site import boundary (structural, reads real repo files)', () => {
  it('apps/site/package.json declares none of the forbidden dependencies', () => {
    const pkg = JSON.parse(readFileSync('apps/site/package.json', 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const forbidden of ['@noodara/domain', '@noodara/control-plane', '@noodara/web', '@noodara/ssh']) {
      expect(allDeps).not.toHaveProperty(forbidden);
    }
  });

  it('no file under apps/site imports a forbidden target', () => {
    const files = listSiteSourceFiles('apps/site');
    const violations = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const finding of findForbiddenSiteImports(source)) {
        violations.push({ file, ...finding });
      }
    }

    expect(violations).toEqual([]);
  });

  it('turbo.json declares a public-site boundary tag denying control-plane/web', () => {
    const turboJson = JSON.parse(readFileSync('turbo.json', 'utf8'));
    const deny = turboJson.boundaries?.tags?.['public-site']?.dependencies?.deny ?? [];

    for (const forbidden of ['@noodara/control-plane', '@noodara/web']) {
      expect(deny).toContain(forbidden);
    }
  });

  it('no file under apps/site imports @noodara/ssh (enforced here, not by a turbo tag -- see header comment)', () => {
    const files = listSiteSourceFiles('apps/site');

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/@noodara\/ssh/);
    }
  });

  it('apps/site/turbo.json tags itself as public-site', () => {
    const siteTurboJson = JSON.parse(readFileSync('apps/site/turbo.json', 'utf8'));

    expect(siteTurboJson.tags).toEqual(['public-site']);
  });

  it('apps/site/public/CNAME exists (sanity: listSiteSourceFiles must not choke on non-source files)', () => {
    expect(existsSync('apps/site/public/CNAME')).toBe(true);
  });
});
