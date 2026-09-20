#!/usr/bin/env node
// Zero-dependency npm supply-chain provenance check.
//
// This script exists because 01-RESEARCH.md ran `slopcheck --ecosystem npm` over the phase-1
// dependency set and three packages did not come back clean: `vitest` [SUS], `commander` [SUS]
// and `@fastify/type-provider-zod` (approved-with-caveat, Assumption A1). The research author
// assessed all three as false positives with independent, verifiable evidence — the objective
// signal in every case is the one a human would read off the npm page: the package's registry
// `repository.url` field.
//
// This turns that lookup into a re-runnable, non-bypassable script instead of a one-off human
// read.
//
// 05-36 (gap closure, WR-C-14 finding): the original version of this script enumerated a
// hardcoded 29-entry list instead of the actual locked dependency tree, so it covered 27 of the
// 52 direct dependencies declared across this monorepo's seven workspace manifests — missing
// security-critical production packages (`ssh2`, `argon2`, `better-auth`, `pg`, `fastify`,
// `pino`, `zod`) entirely — and it resolved each package's registry `repository.url` at
// `dist-tags.latest`, not the version `pnpm-lock.yaml` actually pins. `enumerateLockedDependencies`
// below fixes both: it enumerates every direct dependency (both `dependencies` and
// `devDependencies`, across every workspace) from `pnpm list -r --depth 0 --json` — the locked,
// installed tree, not a manually maintained list — and `resolvePackageProvenance` resolves the
// registry entry for that exact locked version. A newly added dependency is now checked the next
// time this script runs, with zero edits to this file required for *enumeration* (though its
// EXPECTED_PACKAGES entry below still requires a human to add and review it — see "LIMITATION"
// below and the fail-closed behaviour in `main()`).
//
// LIMITATION (documented per 05-36-PLAN.md, T-5G-36-06, accepted risk): a registry `repository.url`
// is publisher-controlled, free-text metadata — the npm registry does not verify that a package's
// declared repository actually corresponds to the code it published. A malicious package named
// close to a legitimate one (a typosquat) could still declare the real project's repository URL
// in its own `package.json` and pass this check. This script only narrows that risk (exact
// `owner/repo` string match against a value a human reviewed at least once, not a fuzzy or
// substring match), it does not eliminate it. Closing that gap fully would require npm's
// provenance attestations (cryptographically binding a published tarball to the repository and
// CI run that built it), which is out of scope for this gap closure.
//
// Zero third-party dependencies by design: no root package.json existed yet at the point this
// script was first written, and its zero-dependency discipline is kept even now that one exists.
// Only `node:` builtins are imported; `pnpm` and `npm` are invoked as external CLIs already
// present in this project's toolchain, never installed by this script.

import { execFileSync } from 'node:child_process';

// Expected GitHub `owner/repo` for every package this script may enumerate. Every package
// `enumerateLockedDependencies()` returns MUST have an entry here — an enumerated package with no
// entry fails the gate (see main()) rather than being silently skipped, closing WR-C-14 finding 1
// ("adding a typosquatted dependency tomorrow passes CI because nothing forces it into the list").
//
// Two entries from the original hardcoded list have been removed as stale (WR-C-14 finding 1,
// "the list is already stale in both directions"): `fastify-type-provider-zod` (turkerdev/…) and
// bare `playwright` are not direct dependencies of any workspace in this repository — only
// `@fastify/type-provider-zod` and `@playwright/test` are. `fastify-type-provider-zod`'s
// historical verification (as a documented comparison baseline for Plan 01-03's decision) remains
// on record in docs/adr/0001-fastify-zod-type-provider.md and docs/adr/0000-package-legitimacy-
// approvals.md; removing its now-unused entry here does not erase that record.
const EXPECTED_PACKAGES = [
  { name: 'vitest', expectedOwnerRepo: 'vitest-dev/vitest' },
  { name: 'commander', expectedOwnerRepo: 'tj/commander.js' },
  {
    name: '@fastify/type-provider-zod',
    expectedOwnerRepo: 'fastify/fastify-type-provider-zod',
  },
  { name: 'bullmq', expectedOwnerRepo: 'taskforcesh/bullmq' },
  {
    // 05-36: ioredis@5.11.1 (the version this repository actually pins — see ADR-0000's Phase 4
    // addition, RESP3-compatibility decision) declares `repository.url` -> luin/ioredis in its
    // own published package.json. Only later releases (registry dist-tags.latest is 6.0.0 at the
    // time of this change) moved the registry-asserted repository to redis/ioredis, after Redis
    // Inc's adoption of the project. Checking dist-tags.latest (the pre-05-36 behaviour) silently
    // verified a *different* release than the one this repository installs. This is the concrete
    // proof case for WR-C-14 finding 3 ("checks the registry's `latest`, not the pinned version");
    // resolvePackageProvenance()'s own test in
    // tests/unit/scripts/check-package-provenance.test.ts pins this exact fact.
    name: 'ioredis',
    expectedOwnerRepo: 'luin/ioredis',
  },
  {
    name: '@testcontainers/redis',
    expectedOwnerRepo: 'testcontainers/testcontainers-node',
  },

  // Phase 5 (05-03): the whole Next.js/Radix/Tailwind/Playwright frontend stack, plus the Vitest
  // component-test DOM stack. Repos verified in 05-RESEARCH.md's "Package Legitimacy Audit" (14
  // packages) and this plan's Task 1 blocking human checkpoint (8 packages absent from that
  // research pass), recorded in ADR-0000's "Phase 5 additions" section.
  //
  // `react` and `react-dom` legitimately resolve to `react/react`, not `facebook/react`: GitHub
  // redirects the renamed `facebook/react` org to `react/react` (evidence: 05-RESEARCH.md's
  // Package Legitimacy Audit table, confirmed live via `curl -I https://github.com/facebook/react`
  // -> 301 -> `github.com/react/react`).
  //
  // The four `@testing-library/*` packages deliberately do NOT share one repository expectation —
  // each has its own (`dom-testing-library`, `react-testing-library`, `jest-dom`, `user-event`) —
  // a single shared org string would weaken the gate against a typosquat landing under the right
  // org but the wrong repo.
  { name: 'next', expectedOwnerRepo: 'vercel/next.js' },
  { name: 'react', expectedOwnerRepo: 'react/react' },
  { name: 'react-dom', expectedOwnerRepo: 'react/react' },
  { name: 'tailwindcss', expectedOwnerRepo: 'tailwindlabs/tailwindcss' },
  {
    name: '@tailwindcss/postcss',
    expectedOwnerRepo: 'tailwindlabs/tailwindcss',
  },
  { name: '@types/react', expectedOwnerRepo: 'DefinitelyTyped/DefinitelyTyped' },
  {
    name: '@types/react-dom',
    expectedOwnerRepo: 'DefinitelyTyped/DefinitelyTyped',
  },
  { name: 'lucide-react', expectedOwnerRepo: 'lucide-icons/lucide' },
  { name: '@playwright/test', expectedOwnerRepo: 'microsoft/playwright' },
  { name: '@radix-ui/react-dialog', expectedOwnerRepo: 'radix-ui/primitives' },
  { name: '@radix-ui/react-tooltip', expectedOwnerRepo: 'radix-ui/primitives' },
  {
    name: '@radix-ui/react-collapsible',
    expectedOwnerRepo: 'radix-ui/primitives',
  },
  {
    name: '@radix-ui/react-radio-group',
    expectedOwnerRepo: 'radix-ui/primitives',
  },
  {
    name: '@radix-ui/react-scroll-area',
    expectedOwnerRepo: 'radix-ui/primitives',
  },
  {
    name: '@radix-ui/react-visually-hidden',
    expectedOwnerRepo: 'radix-ui/primitives',
  },
  {
    name: '@radix-ui/react-checkbox',
    expectedOwnerRepo: 'radix-ui/primitives',
  },
  { name: 'jsdom', expectedOwnerRepo: 'jsdom/jsdom' },
  {
    name: '@testing-library/dom',
    expectedOwnerRepo: 'testing-library/dom-testing-library',
  },
  {
    name: '@testing-library/react',
    expectedOwnerRepo: 'testing-library/react-testing-library',
  },
  {
    name: '@testing-library/jest-dom',
    expectedOwnerRepo: 'testing-library/jest-dom',
  },
  {
    name: '@testing-library/user-event',
    expectedOwnerRepo: 'testing-library/user-event',
  },

  // 05-36 gap closure (WR-C-14 finding 1): the 25 packages below were direct dependencies of some
  // workspace manifest all along but were never in this hardcoded list, so the pre-05-36 script
  // never checked them at all — regardless of enumeration source, an enumerated package with no
  // entry here still fails the gate (see main()), so every one of them needed an entry the moment
  // enumeration stopped being hardcoded. Repository values below were captured via
  // `npm view <name>@<locked-version> repository.url` against this repository's actual
  // pnpm-lock.yaml pins (never dist-tags.latest) on 2026-09-20.
  //
  // `ssh2`, `argon2`, `better-auth`, `pg`, `fastify`, `pino`, `zod` are the exact seven packages
  // WR-C-14 named as missing (T-5G-36-05).
  { name: 'ssh2', expectedOwnerRepo: 'mscdex/ssh2' },
  { name: 'argon2', expectedOwnerRepo: 'ranisalt/node-argon2' },
  { name: 'better-auth', expectedOwnerRepo: 'better-auth/better-auth' },
  { name: 'pg', expectedOwnerRepo: 'brianc/node-postgres' },
  { name: 'fastify', expectedOwnerRepo: 'fastify/fastify' },
  { name: 'pino', expectedOwnerRepo: 'pinojs/pino' },
  { name: 'zod', expectedOwnerRepo: 'colinhacks/zod' },
  { name: '@eslint/js', expectedOwnerRepo: 'eslint/eslint' },
  { name: 'eslint', expectedOwnerRepo: 'eslint/eslint' },
  {
    name: '@testcontainers/postgresql',
    expectedOwnerRepo: 'testcontainers/testcontainers-node',
  },
  { name: '@types/node', expectedOwnerRepo: 'DefinitelyTyped/DefinitelyTyped' },
  { name: '@types/pg', expectedOwnerRepo: 'DefinitelyTyped/DefinitelyTyped' },
  { name: '@types/ssh2', expectedOwnerRepo: 'DefinitelyTyped/DefinitelyTyped' },
  { name: '@vitest/coverage-v8', expectedOwnerRepo: 'vitest-dev/vitest' },
  { name: 'drizzle-kit', expectedOwnerRepo: 'drizzle-team/drizzle-orm' },
  { name: 'drizzle-orm', expectedOwnerRepo: 'drizzle-team/drizzle-orm' },
  { name: 'globals', expectedOwnerRepo: 'sindresorhus/globals' },
  { name: 'prettier', expectedOwnerRepo: 'prettier/prettier' },
  { name: 'set-cookie-parser', expectedOwnerRepo: 'nfriedly/set-cookie-parser' },
  { name: 'testcontainers', expectedOwnerRepo: 'testcontainers/testcontainers-node' },
  { name: 'tsx', expectedOwnerRepo: 'privatenumber/tsx' },
  { name: 'turbo', expectedOwnerRepo: 'vercel/turborepo' },
  { name: 'typescript', expectedOwnerRepo: 'microsoft/TypeScript' },
  {
    name: 'typescript-eslint',
    expectedOwnerRepo: 'typescript-eslint/typescript-eslint',
  },
  { name: 'uuidv7', expectedOwnerRepo: 'LiosK/uuidv7' },
];

const EXPECTED_BY_NAME = new Map(
  EXPECTED_PACKAGES.map(({ name, expectedOwnerRepo }) => [name, expectedOwnerRepo]),
);

/**
 * Normalise a registry repository URL to a bare `owner/repo` string.
 * Strips a leading `git+`, a trailing `.git`, protocol prefixes
 * (`ssh://git@`, `git://`, `https://`) and any `github.com[:/]` prefix,
 * then lowercases the result.
 *
 * Comparison must use exact string equality against the expected value,
 * never a loose substring match — a URL like `github.com/evil/vitest-dev-vitest`
 * would satisfy a substring check against `vitest-dev/vitest` while pointing at
 * an entirely different, attacker-controlled repository.
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
 * Enumerates every direct dependency (both `dependencies` and `devDependencies`) declared across
 * every workspace's package.json, at the exact version pnpm has resolved from `pnpm-lock.yaml` —
 * never the registry's `dist-tags.latest`. Uses `pnpm list -r --depth 0 --json` (the sanctioned,
 * already-installed enumeration source named in 05-36-PLAN.md's own interfaces section) rather
 * than hand-parsing pnpm-lock.yaml's YAML structure directly.
 *
 * Workspace-internal packages (`@noodara/*`, resolved by pnpm as `link:../...`) are excluded:
 * they have no npm registry entry to look up and are reviewed through this repository's normal
 * code review, not a registry provenance check.
 *
 * A package declared in more than one workspace keeps the version from whichever workspace pnpm
 * lists first — every current cross-workspace duplicate in this repository (e.g. `zod`) is
 * pinned to the identical version in every manifest that declares it, so this has no practical
 * effect today; a future mismatch would still resolve *a* real locked version, never a
 * fabricated one.
 */
function enumerateLockedDependencies() {
  const raw = execFileSync('pnpm', ['list', '-r', '--depth', '0', '--json'], {
    encoding: 'utf8',
  });
  const workspaces = JSON.parse(raw);

  const byName = new Map();
  for (const workspace of workspaces) {
    for (const section of ['dependencies', 'devDependencies']) {
      for (const [name, info] of Object.entries(workspace[section] ?? {})) {
        const version = info?.version;
        if (typeof version !== 'string' || version.startsWith('link:')) continue;
        if (!byName.has(name)) byName.set(name, version);
      }
    }
  }

  return [...byName.entries()]
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a package's registry `repository.url` at its exact **locked** version.
 * Primary path: `npm view <pkg>@<lockedVersion> repository.url` via execFileSync (npm ships with
 * Node and works without a local package.json). Falls back to the public registry JSON API's
 * `versions[<lockedVersion>]` entry (never `dist-tags.latest`) via global `fetch` if npm view is
 * unavailable or errors.
 */
async function resolvePackageProvenance(pkgName, lockedVersion) {
  const spec = `${pkgName}@${lockedVersion}`;

  try {
    const repoUrl = execFileSync(
      'npm',
      ['view', spec, 'repository.url'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

    if (repoUrl) {
      return { repoUrl, source: 'npm view (locked version)' };
    }
    // npm view succeeded but returned an empty repository.url — fall through to the registry API
    // fallback rather than treating this as fatal.
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
  // Deliberately reads data.versions[lockedVersion] — never data['dist-tags'].latest. The whole
  // point of this fallback path is the exact locked version, not whatever the registry currently
  // tags "latest" (WR-C-14 finding 3; see the `ioredis` EXPECTED_PACKAGES comment above for the
  // concrete case where those two differ).
  const versionEntry = data.versions?.[lockedVersion];
  const repoUrl = versionEntry?.repository?.url ?? null;

  return {
    repoUrl,
    source: 'registry.npmjs.org fetch fallback (locked version)',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const enumerated = enumerateLockedDependencies();

  // `--list`: prints just the enumerated package names, one per line, with no network call —
  // used by 05-36-PLAN.md's acceptance check and by CI-adjacent tooling that only needs to know
  // what this gate currently covers.
  if (args.includes('--list')) {
    for (const { name } of enumerated) {
      console.log(name);
    }
    return;
  }

  const successes = [];
  const failures = [];

  for (const { name, version } of enumerated) {
    const expectedOwnerRepo = EXPECTED_BY_NAME.get(name);

    if (!expectedOwnerRepo) {
      failures.push({
        name,
        version,
        expectedOwnerRepo: '<none configured>',
        observed:
          '<no EXPECTED_PACKAGES entry — add one to scripts/check-package-provenance.mjs after reviewing this package on npmjs.com>',
      });
      continue;
    }

    let provenance;
    try {
      provenance = await resolvePackageProvenance(name, version);
    } catch (err) {
      failures.push({
        name,
        version,
        expectedOwnerRepo,
        observed: `<unresolvable: ${err.message}>`,
      });
      continue;
    }

    const { repoUrl } = provenance;

    if (!repoUrl) {
      failures.push({
        name,
        version,
        expectedOwnerRepo,
        observed: '<missing repository field>',
      });
      continue;
    }

    const normalised = normaliseRepoUrl(repoUrl);

    if (normalised !== expectedOwnerRepo.toLowerCase()) {
      failures.push({
        name,
        version,
        expectedOwnerRepo,
        observed: repoUrl,
      });
      continue;
    }

    successes.push({ name, version, repoUrl });
  }

  for (const { name, version, repoUrl } of successes) {
    console.log(`OK ${name}@${version} -> ${repoUrl}`);
  }

  console.log(
    `\nCoverage: ${successes.length}/${enumerated.length} locked direct dependencies verified.`,
  );

  if (failures.length > 0) {
    for (const { name, version, expectedOwnerRepo, observed } of failures) {
      console.error(
        `FAIL ${name}@${version}: expected repository under "${expectedOwnerRepo}", observed "${observed}"`,
      );
      console.error(
        'SUPPLY CHAIN CHECK FAILED - a human must review this package on npmjs.com before it is installed',
      );
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

// Guards the `main()` call so this module can be `import`ed (e.g. from
// tests/unit/scripts/check-package-provenance.test.ts) without triggering a full network
// provenance scan as a side effect — only running this file directly as `node
// scripts/check-package-provenance.mjs` (or via a package.json script that does the same) runs
// the gate itself.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(`Unexpected error running provenance check: ${err.message}`);
    console.error(
      'SUPPLY CHAIN CHECK FAILED - a human must review this package on npmjs.com before it is installed',
    );
    process.exitCode = 1;
  });
}

export { enumerateLockedDependencies, normaliseRepoUrl, resolvePackageProvenance, EXPECTED_PACKAGES };
