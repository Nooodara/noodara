#!/usr/bin/env node
// 10-07-PLAN.md Task 1 (D-14/D-16/SITE-01, T-10-05/T-10-03/T-10-21), amended quick-260928-gmm
// (D-12a): the post-build gate every `pnpm --filter @noodara/site build` runs (wired as
// `&& node scripts/check-export.mjs` in package.json's `build` script -- 10-03's PR gate and the
// Cloudflare Pages publish step both inherit it for free). Walks the real `apps/site/out`
// directory and fails the build (exit 1) the moment any exported HTML/CSS file loads a
// third-party asset, declares an `@font-face`, or leaks a control-plane secret env value --
// never trusted by review alone (10-06-SUMMARY.md's own "a rule checked by a command does not
// erode" precedent, scripts/check-ui-safety.mjs). basePath-mismatch checking was removed here:
// Cloudflare Pages always serves the export at the root, so that failure mode no longer exists.
//
// Zero third-party dependencies -- node builtins and this app's own site-config.mjs only
// (mirrors scripts/check-ui-safety.mjs's zero-dependency discipline). Every pure detection
// function below is exported disk-free so tests/unit/site/check-export.test.ts can exercise it
// with in-memory fixture strings, never a real `out/` directory (apps/site/scripts/sync-site-
// assets.mjs's own module/CLI-main split, 10-02).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { SITE_ORIGIN } from '../site-config.mjs';

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

// Every export must contain these. 10-11-PLAN.md Task 2 added 'index.html' once the landing page
// shipped (the composed `/` route, 10-02's placeholder replaced). quick-260928-gmm added
// '_headers' (Cloudflare Pages response-header config, checked via the exact-match branch in
// findMissingRequiredFiles below -- Next copies public/_headers into out/_headers verbatim, so no
// `.html`/`/index.html` variant ever applies to this entry).
export const REQUIRED_EXPORT_FILES = [
  '404.html',
  'sitemap.xml',
  'robots.txt',
  'api/search',
  'docs.html',
  'index.html',
  '_headers',
];

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

  const requiredFiles = REQUIRED_EXPORT_FILES;

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
