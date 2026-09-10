#!/usr/bin/env node
// Zero-dependency npm supply-chain provenance check.
//
// This script exists because 01-RESEARCH.md ran `slopcheck --ecosystem npm`
// over the phase-1 dependency set and three packages did not come back
// clean: `vitest` [SUS], `commander` [SUS] and `@fastify/type-provider-zod`
// (approved-with-caveat, Assumption A1). The research author assessed all
// three as false positives with independent, verifiable evidence — the
// objective signal in every case is the one a human would read off the npm
// page: the package's registry `repository.url` field.
//
// This turns that lookup into a re-runnable, non-bypassable script instead
// of a one-off human read. A typosquat cannot satisfy it, because a
// typosquat cannot claim the real org's repository and still be a
// different package.
//
// Zero third-party dependencies by design: no root package.json exists yet
// at this point in the phase, and none may be created here. Only `node:`
// builtins are imported.

import { execFileSync } from 'node:child_process';

// Hardcoded table mapping package name to expected GitHub owner/repo, per
// the research evidence in 01-RESEARCH.md "## Package Legitimacy Audit".
const EXPECTED_PACKAGES = [
  { name: 'vitest', expectedOwnerRepo: 'vitest-dev/vitest' },
  { name: 'commander', expectedOwnerRepo: 'tj/commander.js' },
  {
    name: '@fastify/type-provider-zod',
    expectedOwnerRepo: 'fastify/fastify-type-provider-zod',
  },
  {
    name: 'fastify-type-provider-zod',
    expectedOwnerRepo: 'turkerdev/fastify-type-provider-zod',
  },
];

/**
 * Normalise a registry repository URL to a bare `owner/repo` string.
 * Strips a leading `git+`, a trailing `.git`, protocol prefixes
 * (`ssh://git@`, `git://`, `https://`) and any `github.com[:/]` prefix,
 * then lowercases the result.
 *
 * Comparison must use exact string equality against the expected value,
 * never `.includes()` — a URL like `github.com/evil/vitest-dev-vitest`
 * would satisfy `.includes('vitest-dev/vitest')` while pointing at an
 * entirely different, attacker-controlled repository.
 */
function normaliseRepoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let url = rawUrl.trim();

  if (url.startsWith('git+')) url = url.slice('git+'.length);
  if (url.endsWith('.git')) url = url.slice(0, -'.git'.length);

  url = url.replace(/^ssh:\/\/git@/, '');
  url = url.replace(/^git:\/\//, '');
  url = url.replace(/^https:\/\//, '');

  url = url.replace(/^github\.com[:/]/, '');

  return url.toLowerCase();
}

/**
 * Resolve a package's registry `repository.url` and latest version.
 * Primary path: `npm view <pkg> repository.url` / `npm view <pkg> version`
 * via execFileSync (npm ships with Node and works without a local
 * package.json). Falls back to the public registry JSON API via global
 * `fetch` (Node 22 ships this without any dependency) if npm view is
 * unavailable or errors.
 */
async function resolvePackageProvenance(pkgName) {
  try {
    const repoUrl = execFileSync(
      'npm',
      ['view', pkgName, 'repository.url'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const version = execFileSync(
      'npm',
      ['view', pkgName, 'version'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

    if (repoUrl) {
      return { repoUrl, version: version || null, source: 'npm view' };
    }
    // npm view succeeded but returned an empty repository.url — fall through
    // to the registry API fallback rather than treating this as fatal.
  } catch {
    // npm view unavailable or errored — fall back to the registry API.
  }

  const encodedName = encodeURIComponent(pkgName).replace('%40', '@');
  const response = await fetch(
    `https://registry.npmjs.org/${encodedName}`,
  );
  if (!response.ok) {
    throw new Error(
      `registry.npmjs.org responded ${response.status} for ${pkgName}`,
    );
  }
  const data = await response.json();
  const latestTag = data['dist-tags']?.latest;
  const latestVersion = latestTag ? data.versions?.[latestTag] : undefined;
  const repoUrl = latestVersion?.repository?.url ?? null;

  return {
    repoUrl,
    version: latestTag ?? null,
    source: 'registry.npmjs.org fetch fallback',
  };
}

async function main() {
  const successes = [];
  const failures = [];

  for (const { name, expectedOwnerRepo } of EXPECTED_PACKAGES) {
    let provenance;
    try {
      provenance = await resolvePackageProvenance(name);
    } catch (err) {
      failures.push({
        name,
        expectedOwnerRepo,
        observed: `<unresolvable: ${err.message}>`,
      });
      continue;
    }

    const { repoUrl, version } = provenance;

    if (!repoUrl) {
      failures.push({
        name,
        expectedOwnerRepo,
        observed: '<missing repository field>',
      });
      continue;
    }

    const normalised = normaliseRepoUrl(repoUrl);

    if (normalised !== expectedOwnerRepo.toLowerCase()) {
      failures.push({
        name,
        expectedOwnerRepo,
        observed: repoUrl,
      });
      continue;
    }

    successes.push({ name, version, repoUrl });
  }

  for (const { name, version, repoUrl } of successes) {
    console.log(
      `OK ${name}@${version ?? 'unknown'} -> ${repoUrl}`,
    );
  }

  if (failures.length > 0) {
    for (const { name, expectedOwnerRepo, observed } of failures) {
      console.error(
        `FAIL ${name}: expected repository under "${expectedOwnerRepo}", observed "${observed}"`,
      );
      console.error(
        'SUPPLY CHAIN CHECK FAILED - a human must review this package on npmjs.com before it is installed',
      );
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`Unexpected error running provenance check: ${err.message}`);
  console.error(
    'SUPPLY CHAIN CHECK FAILED - a human must review this package on npmjs.com before it is installed',
  );
  process.exit(1);
});
