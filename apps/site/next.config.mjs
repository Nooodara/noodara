// D-11/D-12 (10-CONTEXT.md), 10-RESEARCH.md Pattern 1/Pitfall 4: `apps/site` is a static export
// with no server (D-13) -- basePath/assetPrefix are computed once, at build time, from whether
// `public/CNAME` exists on disk: root when it does (production, noodara.com already routes to the
// repo root), `/noodara` when it does not (so the export still resolves correctly from
// `<owner>.github.io/noodara` before DNS/CNAME is configured). Version and license are likewise
// computed once here, never hand-typed in a UI component -- see site-config.mjs's own header for
// the full D-06 rationale (this repo has no git tags locally, only in CI).
//
// This config has no request-pipeline hooks and no self-contained-server output mode: a static
// export has no request pipeline to attach either to -- those belong to apps/web's own
// next.config.ts, which proxies to a real, running control plane. This app never does.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createMDX } from 'fumadocs-mdx/next';

import {
  SITE_ORIGIN,
  describeLatestTag,
  readCname,
  readLicenseName,
  resolveBasePath,
  resolveSiteVersion,
} from './site-config.mjs';

const siteRoot = import.meta.dirname;
const repoRoot = path.join(siteRoot, '../..');

const cname = readCname(siteRoot);
const basePath = resolveBasePath({ cnameExists: cname !== null });

const packageVersion = JSON.parse(readFileSync(path.join(siteRoot, 'package.json'), 'utf8')).version;
const version = resolveSiteVersion({
  latestTag: describeLatestTag(repoRoot),
  packageVersion,
});

const license = readLicenseName(readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath,
  assetPrefix: basePath === '' ? undefined : basePath,
  images: { unoptimized: true },
  trailingSlash: false,
  env: {
    // T-10-03: only four public, non-secret strings are ever exposed here -- no `process.env`
    // passthrough of any kind, and no secret exists in this build in the first place.
    NOODARA_SITE_ORIGIN: SITE_ORIGIN,
    NOODARA_SITE_BASE_PATH: basePath,
    NOODARA_SITE_VERSION: version,
    NOODARA_SITE_LICENSE: license,
  },
};

// 10-05-PLAN.md Task 1 (RESEARCH.md Pattern 2). `createMDX` wraps -- never replaces -- the config
// above: it wires the fumadocs-mdx bundler plugin (loads `source.config.ts`, transforms the
// `defineDocs`/`loader` macro calls in `src/lib/source.ts`) without touching any key already set
// here. `macro.include` is deliberately narrow (only the one file that calls the macro API), per
// fumadocs-mdx/next's own `CreateMDXOptions.macro.include` contract.
export default createMDX({ macro: { include: ['src/lib/**/*.ts'] } })(nextConfig);
