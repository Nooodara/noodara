// 10-02-PLAN.md Task 3 (SITE-03, D-15/D-16): every --color-fd-* custom property fumadocs-ui's
// neutral.css declares (directly or via its own @import chain) must be assigned in
// apps/site/src/app/global.css, as an exact `var(--token)` reference into
// packages/ui/tokens.css -- never a hand-typed literal, never left at Fumadocs' own default
// palette. Reads the real, installed fumadocs-ui package and the real global.css/tokens.css --
// this test intentionally has no fixture/mock version of either, so an actual dependency
// upgrade or an actual mapping edit is what it measures.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseTokensCss } from '../../../packages/ui/src/contrast';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SITE_PKG_JSON = path.join(REPO_ROOT, 'apps/site/package.json');
const GLOBAL_CSS_PATH = path.join(REPO_ROOT, 'apps/site/src/app/global.css');
const TOKENS_CSS_PATH = path.join(REPO_ROOT, 'packages/ui/tokens.css');

function resolveNeutralCssPath(): string {
  try {
    const requireFromSite = createRequire(SITE_PKG_JSON);
    return requireFromSite.resolve('fumadocs-ui/css/neutral.css');
  } catch {
    const fallback = path.join(REPO_ROOT, 'apps/site/node_modules/fumadocs-ui/css/neutral.css');
    if (existsSync(fallback)) return fallback;
    throw new Error('fumadocs-token-map.test.ts: could not resolve fumadocs-ui/css/neutral.css');
  }
}

const IMPORT_RE = /@import\s+['"]([^'"]+)['"]/g;
const COLOR_FD_DECL_RE = /--color-fd-([a-z-]+)\s*:/g;

/** Recursively walks a CSS file's own @import chain (relative to its own directory only --
 *  fumadocs-ui's css/ directory is self-contained) collecting every declared --color-fd-<name>
 *  custom property name. */
function collectColorFdNames(entryPath: string, seen: Set<string> = new Set(), names: Set<string> = new Set()): Set<string> {
  if (seen.has(entryPath)) return names;
  seen.add(entryPath);
  const content = readFileSync(entryPath, 'utf8');

  COLOR_FD_DECL_RE.lastIndex = 0;
  let declMatch: RegExpExecArray | null;
  while ((declMatch = COLOR_FD_DECL_RE.exec(content)) !== null) {
    names.add(declMatch[1] as string);
  }

  IMPORT_RE.lastIndex = 0;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = IMPORT_RE.exec(content)) !== null) {
    const importPath = path.resolve(path.dirname(entryPath), importMatch[1] as string);
    if (existsSync(importPath)) {
      collectColorFdNames(importPath, seen, names);
    }
  }

  return names;
}

const MAPPING_DECL_RE = /--color-fd-([a-z-]+)\s*:\s*([^;]+);/g;

function extractMapping(css: string): Record<string, string> {
  const map: Record<string, string> = {};
  MAPPING_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MAPPING_DECL_RE.exec(css)) !== null) {
    map[match[1] as string] = (match[2] as string).trim();
  }
  return map;
}

const VAR_FORM_RE = /^var\(--([a-z0-9-]+)\)$/;

const neutralCssNames = collectColorFdNames(resolveNeutralCssPath());
const globalCss = readFileSync(GLOBAL_CSS_PATH, 'utf8');
const mapping = extractMapping(globalCss);
const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
const tokens = parseTokensCss(tokensCss);

describe('apps/site/src/app/global.css Fumadocs --color-fd-* mapping', () => {
  it('finds at least the well-known Fumadocs neutral.css variable set', () => {
    // Sanity check on the resolution logic itself -- if this ever comes back empty/tiny,
    // resolveNeutralCssPath or the @import walk broke, not the mapping.
    expect(neutralCssNames.size).toBeGreaterThanOrEqual(15);
    expect(neutralCssNames.has('background')).toBe(true);
    expect(neutralCssNames.has('primary')).toBe(true);
  });

  it('assigns every --color-fd-* variable neutral.css declares', () => {
    const missing = [...neutralCssNames].filter((name) => mapping[name] === undefined);
    expect(missing, `missing mappings for: ${missing.join(', ')}`).toEqual([]);
  });

  it('every assigned value has the exact form var(--token)', () => {
    for (const [name, value] of Object.entries(mapping)) {
      expect(VAR_FORM_RE.test(value), `--color-fd-${name}: ${value} is not var(--token)`).toBe(true);
    }
  });

  it('every referenced token is actually declared in packages/ui/tokens.css', () => {
    for (const [name, value] of Object.entries(mapping)) {
      const tokenMatch = VAR_FORM_RE.exec(value);
      const tokenName = tokenMatch?.[1];
      expect(tokenName, `--color-fd-${name} value ${value} did not match var() form`).toBeDefined();
      if (tokenName === undefined) continue;
      expect(tokens.light[tokenName], `--${tokenName} missing from tokens.css :root`).toBeDefined();
      expect(tokens.dark[tokenName], `--${tokenName} missing from tokens.css [data-theme="dark"]`).toBeDefined();
    }
  });

  it('does not map --color-fd-accent to any --accent* token (it is a hover background, not the brand accent)', () => {
    expect(mapping.accent).toBeDefined();
    expect(mapping.accent?.startsWith('var(--accent')).toBe(false);
  });

  it('the mapping block appears after the Fumadocs @imports and covers both :root and html.dark', () => {
    const presetImportIndex = globalCss.indexOf("fumadocs-ui/css/preset.css");
    const blockIndex = globalCss.indexOf(':root,');
    expect(presetImportIndex).toBeGreaterThan(-1);
    expect(blockIndex).toBeGreaterThan(presetImportIndex);
    expect(globalCss.slice(blockIndex, blockIndex + 200)).toContain('html.dark');
  });

  const CONTRAST_PAIRS: ReadonlyArray<{ label: string; fg: string; bg: string }> = [
    { label: 'fd-foreground on fd-background', fg: 'foreground', bg: 'background' },
    { label: 'fd-muted-foreground on fd-background', fg: 'muted-foreground', bg: 'background' },
    { label: 'fd-card-foreground on fd-card', fg: 'card-foreground', bg: 'card' },
    { label: 'fd-primary-foreground on fd-primary', fg: 'primary-foreground', bg: 'primary' },
    { label: 'fd-foreground on fd-popover', fg: 'foreground', bg: 'popover' },
  ];

  function resolvedTokenValue(theme: 'light' | 'dark', fdName: string): string {
    const value = mapping[fdName];
    const tokenMatch = value === undefined ? null : VAR_FORM_RE.exec(value);
    const tokenName = tokenMatch?.[1];
    if (tokenName === undefined) throw new Error(`no var(--token) mapping for --color-fd-${fdName}`);
    const resolved = tokens[theme][tokenName];
    if (resolved === undefined) throw new Error(`--${tokenName} not found in tokens.css (${theme})`);
    return resolved;
  }

  for (const theme of ['light', 'dark'] as const) {
    for (const { label, fg, bg } of CONTRAST_PAIRS) {
      it(`${label} measures >= 4.5:1 in ${theme} mode`, () => {
        const ratio = contrastRatio(resolvedTokenValue(theme, fg), resolvedTokenValue(theme, bg));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('contains no hex/rgb color literal, no @font-face and no url(http', () => {
    expect(globalCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(globalCss).not.toMatch(/rgba?\(/);
    expect(globalCss).not.toMatch(/@font-face/);
    expect(globalCss).not.toMatch(/url\(http/);
  });
});
