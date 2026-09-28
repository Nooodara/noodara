#!/usr/bin/env node
// 10-07-PLAN.md Task 1 (D-14/D-16/SITE-01, T-10-05/T-10-03/T-10-21): the post-build gate every
// `pnpm --filter @noodara/site build` runs (wired as `&& node scripts/check-export.mjs` in
// package.json's `build` script -- 10-03's PR gate and the Pages publish step both inherit it for
// free). Walks the real `apps/site/out` directory and fails the build (exit 1) the moment any
// exported HTML/CSS file loads a third-party asset, declares an `@font-face`, carries the
// preview `/noodara` base-path prefix in a CNAME-present (production) build, or leaks a
// control-plane secret env value -- never trusted by review alone (10-06-SUMMARY.md's own
// "a rule checked by a command does not erode" precedent, scripts/check-ui-safety.mjs).
//
// Zero third-party dependencies -- node builtins and this app's own site-config.mjs only
// (mirrors scripts/check-ui-safety.mjs's zero-dependency discipline). Every pure detection
// function below is exported disk-free so tests/unit/site/check-export.test.ts can exercise it
// with in-memory fixture strings, never a real `out/` directory (apps/site/scripts/sync-site-
// assets.mjs's own module/CLI-main split, 10-02).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PREVIEW_BASE_PATH, readCname, SITE_ORIGIN } from '../site-config.mjs';

const SITE_ORIGIN_ORIGIN = new URL(SITE_ORIGIN).origin;

// Only these tags ever legitimately load a resource the browser fetches on the site's behalf.
// `<a>` is deliberately excluded: a link the visitor clicks is navigation, not an asset the page
// itself loads, and `<meta>` (og:image etc.) is excluded the same way -- neither leaks anything
// unless the visitor already chose to follow it.
const ASSET_TAG_PATTERN = /<(script|link|img|source|iframe)\b([^>]*)>/gi;
const ASSET_ATTR_PATTERN = /\b(?:src|href|srcset)\s*=\s*["']([^"']+)["']/gi;
const REL_PATTERN = /\brel\s*=\s*["']([^"']+)["']/i;
const CSS_URL_PATTERN = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

/**
 * Splits a `srcset`-shaped attribute value ("url1 1x, url2 2x") into its individual URLs. A
 * plain `src`/`href` value is a single "item" and returns unchanged.
 * @param {string} value
 * @returns {string[]}
 */
function extractUrls(value) {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((url) => url !== undefined && url.length > 0);
}

/**
 * True when `url` is an absolute http(s) URL on an origin other than SITE_ORIGIN.
 * @param {string} url
 * @returns {boolean}
 */
function isThirdPartyUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return new URL(url).origin !== SITE_ORIGIN_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Finds every third-party asset reference in `text` -- HTML tag attributes (script/link/img/
 * source/iframe src|href|srcset) and CSS `url(...)` references alike, since the same function
 * scans both `.html` and `.css` export files (10-07-PLAN.md Task 1 behavior spec).
 * @param {string} text
 * @returns {Array<{ url: string, tag: string }>}
 */
export function findThirdPartyAssetUrls(text) {
  const findings = [];

  ASSET_TAG_PATTERN.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = ASSET_TAG_PATTERN.exec(text)) !== null) {
    const [, tagName, attrs] = tagMatch;
    if (tagName.toLowerCase() === 'link') {
      const relMatch = attrs.match(REL_PATTERN);
      if (relMatch !== null && relMatch[1].toLowerCase() === 'canonical') continue;
    }

    ASSET_ATTR_PATTERN.lastIndex = 0;
    let attrMatch;
    while ((attrMatch = ASSET_ATTR_PATTERN.exec(attrs)) !== null) {
      for (const url of extractUrls(attrMatch[1])) {
        if (isThirdPartyUrl(url)) findings.push({ url, tag: tagName.toLowerCase() });
      }
    }
  }

  CSS_URL_PATTERN.lastIndex = 0;
  let cssMatch;
  while ((cssMatch = CSS_URL_PATTERN.exec(text)) !== null) {
    const url = cssMatch[1];
    if (isThirdPartyUrl(url)) findings.push({ url, tag: 'css-url' });
  }

  return findings;
}

const FONT_FACE_PATTERN = /@font-face/gi;

/**
 * Finds every `@font-face` declaration in `text` (D-16: this app self-hosts nothing that needs
 * one -- system fonts only -- so any occurrence is a defect, not a style choice to police).
 * @param {string} text
 * @returns {Array<{ match: string }>}
 */
export function findFontFaces(text) {
  const matches = text.match(FONT_FACE_PATTERN);
  return matches === null ? [] : matches.map((match) => ({ match }));
}

// Control-plane secret env var names (turbo.json passThroughEnv, T-10-03). NOODARA_ADMIN_PASSWORD
// legitimately appears as a documented variable NAME on the Supported variables docs page, so this
// only flags an actual `NAME=value` assignment with a non-placeholder value, never a bare mention.
const SECRET_ENV_NAMES = [
  'NOODARA_MASTER_KEY',
  'NOODARA_MASTER_KEY_PREVIOUS',
  'BETTER_AUTH_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'NOODARA_ADMIN_PASSWORD',
];

/** `<placeholder>`-shaped values (the docs' own convention for "put your value here") never
 *  count as a leak. */
function isPlaceholderValue(value) {
  return /^<[^>]*>$/.test(value);
}

/**
 * Finds every `NAME=value` assignment of a control-plane secret env var name in `text`, skipping
 * placeholder values and bare name mentions with no assignment.
 * @param {string} text
 * @returns {Array<{ name: string, value: string }>}
 */
export function findLeakedEnvNames(text) {
  const findings = [];
  for (const name of SECRET_ENV_NAMES) {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(<[^>]*>|[^\\s"'<>]+)`, 'g');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1];
      if (isPlaceholderValue(value)) continue;
      findings.push({ name, value });
    }
  }
  return findings;
}

/**
 * Finds every exported asset URL carrying the preview `/noodara` base-path prefix. Only
 * meaningful when `cnamePresent` is true (D-12: a CNAME-present build must resolve at the
 * production root, never the preview prefix) -- a non-CNAME preview build legitimately uses the
 * prefix everywhere, so this always returns `[]` when `cnamePresent` is false.
 * @param {string} html
 * @param {{ cnamePresent: boolean }} params
 * @returns {Array<{ path: string }>}
 */
export function findBasePathMismatch(html, { cnamePresent }) {
  if (!cnamePresent) return [];
  const PATTERN = /\b(?:src|href)\s*=\s*["'](\/noodara\/[^"']*)["']/gi;
  const findings = [];
  let match;
  while ((match = PATTERN.exec(html)) !== null) {
    findings.push({ path: match[1] });
  }
  return findings;
}

const ANCHOR_TAG_PATTERN = /<a\b([^>]*)>/gi;
const ANCHOR_HREF_PATTERN = /\bhref\s*=\s*["']([^"']+)["']/i;

/**
 * Finds every `<a href="...">` in `html` whose href is root-relative (starts with a single `/`,
 * not `//`) but is not itself `basePath` or prefixed with `${basePath}/`. Only meaningful when
 * `cnamePresent` is false (D-12: a non-CNAME preview build resolves at `<owner>.github.io/
 * <basePath>`, so every internal navigation link must carry the prefix -- Next only rewrites
 * `basePath` onto `next/link`/`<Image>`, never a plain `<a href>`, so a raw internal anchor left
 * unprefixed 404s under this build shape). Always returns `[]` when `cnamePresent` is true (a
 * CNAME-present/production build resolves at the root, so no prefix is expected) or `basePath` is
 * empty.
 * @param {string} html
 * @param {{ cnamePresent: boolean, basePath: string }} params
 * @returns {Array<{ path: string }>}
 */
export function findMissingBasePathPrefix(html, { cnamePresent, basePath }) {
  if (cnamePresent || !basePath) return [];

  const findings = [];
  ANCHOR_TAG_PATTERN.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = ANCHOR_TAG_PATTERN.exec(html)) !== null) {
    const hrefMatch = tagMatch[1].match(ANCHOR_HREF_PATTERN);
    if (hrefMatch === null) continue;

    const href = hrefMatch[1];
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    if (href === basePath || href.startsWith(`${basePath}/`)) continue;

    findings.push({ path: href });
  }
  return findings;
}

// Every export must contain these. 10-11-PLAN.md Task 2 added 'index.html' once the landing page
// shipped (the composed `/` route, 10-02's placeholder replaced).
export const REQUIRED_EXPORT_FILES = ['404.html', 'sitemap.xml', 'robots.txt', 'api/search', 'docs.html', 'index.html'];

/**
 * Checks every `requiredFiles` entry against `producedFiles` (a Set of export-relative paths)
 * and returns the entries that are missing. Each entry is accepted only via one of the exact leaf
 * shapes `next export` can plausibly produce: the entry itself (e.g. `api/search`, the real flat
 * file a route handler exports today), `<entry>.html`, or `<entry>/index.html` -- never an
 * arbitrarily deep `startsWith` match, which would stay green even if a future export nested the
 * output somewhere unexpected without anyone verifying what shape was actually produced (WR-01).
 * @param {Set<string>} producedFiles
 * @param {string[]} requiredFiles
 * @returns {string[]}
 */
export function findMissingRequiredFiles(producedFiles, requiredFiles) {
  const missing = [];
  for (const requiredFile of requiredFiles) {
    const found =
      producedFiles.has(requiredFile) ||
      producedFiles.has(`${requiredFile}.html`) ||
      producedFiles.has(`${requiredFile}/index.html`);
    if (!found) missing.push(requiredFile);
  }
  return missing;
}

/**
 * Recursively lists every file under `dir`, returned as paths relative to `dir` with forward
 * slashes (so a Windows checkout still matches REQUIRED_EXPORT_FILES's posix-style entries).
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesRecursive(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(absPath).map((f) => path.join(entry.name, f)));
    } else {
      files.push(entry.name);
    }
  }
  return files.map((f) => f.split(path.sep).join('/'));
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const siteRoot = path.join(import.meta.dirname, '..');
  const outDir = path.join(siteRoot, 'out');

  if (!existsSync(outDir)) {
    console.error(`check-export: "${outDir}" does not exist -- run \`next build\` first.`);
    process.exit(1);
  }

  const cnamePresent = readCname(siteRoot) !== null;
  const requiredFiles = cnamePresent ? [...REQUIRED_EXPORT_FILES, 'CNAME'] : REQUIRED_EXPORT_FILES;

  const allFindings = [];
  let checkedFiles = 0;

  for (const relPath of listFilesRecursive(outDir)) {
    const absPath = path.join(outDir, relPath);
    if (!statSync(absPath).isFile()) continue;

    if (relPath.endsWith('.html')) {
      checkedFiles += 1;
      const content = readFileSync(absPath, 'utf8');
      for (const finding of findThirdPartyAssetUrls(content)) {
        allFindings.push({ file: relPath, kind: 'third-party-asset', ...finding });
      }
      for (const finding of findBasePathMismatch(content, { cnamePresent })) {
        allFindings.push({ file: relPath, kind: 'base-path-mismatch', ...finding });
      }
      for (const finding of findMissingBasePathPrefix(content, { cnamePresent, basePath: PREVIEW_BASE_PATH })) {
        allFindings.push({ file: relPath, kind: 'missing-preview-base-path', ...finding });
      }
      for (const finding of findLeakedEnvNames(content)) {
        allFindings.push({ file: relPath, kind: 'leaked-env', ...finding });
      }
    } else if (relPath.endsWith('.css')) {
      checkedFiles += 1;
      const content = readFileSync(absPath, 'utf8');
      for (const finding of findThirdPartyAssetUrls(content)) {
        allFindings.push({ file: relPath, kind: 'third-party-asset', ...finding });
      }
      for (const finding of findFontFaces(content)) {
        allFindings.push({ file: relPath, kind: 'font-face', ...finding });
      }
    }
  }

  const producedFiles = new Set(listFilesRecursive(outDir));
  for (const requiredFile of findMissingRequiredFiles(producedFiles, requiredFiles)) {
    allFindings.push({ file: requiredFile, kind: 'missing-required-file' });
  }

  if (allFindings.length > 0) {
    console.error(`check-export: ${String(allFindings.length)} finding(s):`);
    for (const finding of allFindings) {
      console.error(`  [${finding.kind}] ${finding.file}: ${JSON.stringify(finding)}`);
    }
    process.exit(1);
  }

  console.log(`check-export: ${String(checkedFiles)} files, zero third-party assets`);
}
