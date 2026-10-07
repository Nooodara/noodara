#!/usr/bin/env node
// Release version consistency gate (Plan 14-14, H1). One tag drives everything: the image tag
// release.yml publishes, every workspace package.json version, and the release notes file
// docs/releases/v<base>.md. A release candidate tag (vX.Y.Z-rc.N) shares its base version with
// the final release: the packages and notes carry X.Y.Z, only the tag carries the -rc.N suffix.
//
// Only `node:` builtins are imported.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Strict: numeric core without leading zeros, optional -rc.N with N >= 1 and no leading zero.
// Rejects v0.2.0-rc, v0.2.0-rc.0, v0.2.0-rc.0x, v0.2.0-rc.01 and v0.2.0-rcfoo.
const TAG_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

/**
 * @param {string} tag a git tag or workflow_dispatch input, with or without a leading "v"
 * @returns {{ version: string, base: string, prerelease: boolean } | null} null when malformed
 */
export function parseReleaseTag(tag) {
  const match = TAG_RE.exec(tag);
  if (!match) return null;
  const base = `${match[1]}.${match[2]}.${match[3]}`;
  const rc = match[4];
  return { version: rc === undefined ? base : `${base}-rc.${rc}`, base, prerelease: rc !== undefined };
}

/**
 * @param {{ tag: string, packageVersions: Record<string, string>, notesExist: boolean }} input
 * @returns {string[]} human-readable problems; empty when consistent
 */
export function checkReleaseConsistency({ tag, packageVersions, notesExist }) {
  const parsed = parseReleaseTag(tag);
  if (!parsed) {
    return [`tag "${tag}" is not vX.Y.Z or vX.Y.Z-rc.N (N >= 1, no leading zeros)`];
  }
  const problems = [];
  for (const [file, version] of Object.entries(packageVersions)) {
    if (version !== parsed.base) {
      problems.push(`${file} version is "${version}", expected "${parsed.base}" for tag ${tag}`);
    }
  }
  if (!notesExist) {
    problems.push(`docs/releases/v${parsed.base}.md is missing for tag ${tag}`);
  }
  return problems;
}

const PACKAGE_FILES = [
  'package.json',
  'apps/control-plane/package.json',
  'apps/web/package.json',
  'apps/site/package.json',
  'apps/agent/package.json',
  'packages/config/package.json',
  'packages/docker/package.json',
  'packages/domain/package.json',
  'packages/git/package.json',
  'packages/ssh/package.json',
  'packages/ui/package.json',
];

function main() {
  const tag = process.argv[2] ?? '';
  const root = process.argv[3] ?? '.';
  const packageVersions = {};
  for (const file of PACKAGE_FILES) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    packageVersions[file] = JSON.parse(readFileSync(full, 'utf8')).version ?? '(none)';
  }
  const parsed = parseReleaseTag(tag);
  const notesExist = parsed !== null && existsSync(path.join(root, 'docs', 'releases', `v${parsed.base}.md`));
  const problems = checkReleaseConsistency({ tag, packageVersions, notesExist });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-release-version: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check-release-version: ${tag} consistent (prerelease=${parsed?.prerelease})`);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
