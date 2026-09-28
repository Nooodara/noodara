// Build-time configuration for @noodara/site.
//
// Three decisions live here as pure, tested functions -- never a hand-typed literal in
// next.config.mjs or any UI component:
//
// D-06 (footer version/license): the footer version resolves from the latest `v*` git tag,
// falling back to apps/site/package.json's own version, and the license name is parsed from the
// repository's real LICENSE file -- neither is ever hand-typed in UI code.
// D-11 (custom domain): SITE_ORIGIN below is the single place the production origin literal is
// spelled out anywhere in this repo's build-time config.
// D-12 (CNAME-gated basePath): basePath is '' when apps/site/public/CNAME exists at build time
// (production, custom domain already routes to the repo root) and '/noodara' otherwise (so the
// site still works from <owner>.github.io/noodara before DNS/CNAME is configured).
//
// Why the version falls back to package.json: this monorepo is nested inside a larger, untagged
// personal repository locally (`git describe` always fails here -- 10-RESEARCH.md "Assumptions
// Log"), while a real CI checkout (actions/checkout with fetch-depth 0) has the project's own
// `v0.1.0`/`v0.2.0`... tags. `describeLatestTag` must never throw for this reason -- a missing or
// unreachable git binary, or a repo with no matching tag, is the *expected* local-dev case, not an
// error.
//
// ESM, node builtins only (no third-party dependency at config-evaluation time).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SITE_ORIGIN = 'https://noodara.com';
export const PREVIEW_BASE_PATH = '/noodara';

/**
 * @param {{ cnameExists: boolean }} params
 * @returns {string}
 */
export function resolveBasePath({ cnameExists }) {
  return cnameExists ? '' : PREVIEW_BASE_PATH;
}

/**
 * Reads `<siteRoot>/public/CNAME`, returning its trimmed first line, or `null` when the file is
 * absent or empty.
 * @param {string} siteRoot
 * @returns {string | null}
 */
export function readCname(siteRoot) {
  const cnamePath = path.join(siteRoot, 'public', 'CNAME');
  if (!existsSync(cnamePath)) return null;

  const contents = readFileSync(cnamePath, 'utf8').trim();
  return contents.length > 0 ? contents : null;
}

/**
 * Runs `git describe --tags --abbrev=0 --match 'v[0-9]*'` in `cwd`, with an explicit 5s timeout
 * (CLAUDE.md SS2.3: timeouts explicit on every remote/subprocess operation -- T-10-14). Never
 * throws: git being missing, timing out, or the repository having no `v*` tag are all the
 * expected "no tag yet" case, not an error -- the caller falls back to package.json's version.
 * @param {string} cwd
 * @returns {string | null}
 */
export function describeLatestTag(cwd) {
  try {
    const result = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
      cwd,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

const SEMVER_TAG_PATTERN = /^v\d+\.\d+\.\d+/;
const SEMVER_PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+/;

/**
 * @param {{ latestTag: string | null, packageVersion: string }} params
 * @returns {string}
 */
export function resolveSiteVersion({ latestTag, packageVersion }) {
  if (latestTag !== null && SEMVER_TAG_PATTERN.test(latestTag)) {
    return latestTag;
  }

  if (SEMVER_PACKAGE_VERSION_PATTERN.test(packageVersion) && packageVersion !== '0.0.0') {
    return `v${packageVersion}`;
  }

  throw new Error(
    'Site version unresolved: no v* git tag and apps/site/package.json version is not a release',
  );
}

// Matches the first two non-empty lines of the Apache License 2.0 header:
//   "Apache License"
//   "Version 2.0, January 2004"
const LICENSE_NAME_PATTERN = /^\s*(.+?License)\s*$/m;
const LICENSE_VERSION_PATTERN = /^\s*Version\s+(\d+(?:\.\d+)*)/m;

/**
 * Parses "Apache License 2.0" (name + version) out of the raw LICENSE file text.
 * @param {string} licenseText
 * @returns {string}
 */
export function readLicenseName(licenseText) {
  const nameMatch = licenseText.match(LICENSE_NAME_PATTERN);
  const versionMatch = licenseText.match(LICENSE_VERSION_PATTERN);

  if (!nameMatch || !versionMatch) {
    throw new Error(
      'readLicenseName: could not parse a license name and version out of the given text',
    );
  }

  return `${nameMatch[1].trim()} ${versionMatch[1]}`;
}
