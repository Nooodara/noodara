import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 10-01-PLAN.md Task 3 (SITE-02): apps/site is a public, statically-exported artifact and must
// never pull in the control plane, the web app, the SSH adapter, or the domain package. Turborepo
// boundary tags are TRANSITIVE (Context7 /vercel/turborepo: "rules are applied even for
// dependencies of dependencies"), so a turbo-level deny of `@noodara/domain` for the site would
// fail as soon as the site depends on `@noodara/ui` (packages/ui/package.json depends on
// @noodara/domain, e.g. ThemeToggle/tone import `@noodara/domain/preferences`). This means the
// full CONTEXT boundary requirement (no control-plane, no domain, ui allowed) is only fully
// enforced by TWO mechanisms together:
//   1. a turbo `public-site` tag denying @noodara/control-plane, @noodara/web and ssh-adapter
//      (added to turbo.json by this same task -- transitive denial works fine here because
//      nothing @noodara/ui depends on is control-plane/web/ssh-adapter-tagged)
//   2. this test's manifest + import scan, which catches @noodara/domain (and any relative-path
//      escape hatch into apps/control-plane or apps/web) that a turbo tag rule cannot reach
//      transitively without also blocking the explicitly-allowed @noodara/ui.
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

  it('turbo.json declares a public-site boundary tag denying control-plane/web/ssh-adapter', () => {
    const turboJson = JSON.parse(readFileSync('turbo.json', 'utf8'));
    const deny = turboJson.boundaries?.tags?.['public-site']?.dependencies?.deny ?? [];

    for (const forbidden of ['@noodara/control-plane', '@noodara/web', 'ssh-adapter']) {
      expect(deny).toContain(forbidden);
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
