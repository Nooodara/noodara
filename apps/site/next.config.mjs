// D-11/D-12a (10-CONTEXT.md, amended quick-260928-gmm): `apps/site` is a static export with no
// server (D-13) -- basePath is always the empty string (root): Cloudflare Pages serves this
// export at the root on both `*.pages.dev` and any custom domain, so there is no subpath-preview
// case to compute. Version and license are likewise computed once here, never hand-typed in a UI
// component -- see site-config.mjs's own header for the full D-06 rationale (this repo has no git
// tags locally, only in CI).
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
  readLicenseName,
  resolveSiteVersion,
} from './site-config.mjs';

const siteRoot = import.meta.dirname;
const repoRoot = path.join(siteRoot, '../..');

const basePath = '';

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

// 10-05-PLAN.md Task 1/2 (RESEARCH.md Pattern 2). `createMDX` wraps -- never replaces -- the
// config above: it wires the fumadocs-mdx bundler plugin (loads `source.config.ts`, transforms
// the `defineDocs`/`loader` macro calls in `src/lib/source.ts`) without touching any key already
// set here.
//
// `macro.include` patterns are matched with picomatch's `basename: true` mode
// (fumadocs-mdx/dist/options-BNnYUjkM.js's `createMacroMatcher`), which tests every pattern's
// compiled regex against ONLY the file's basename (`picomatch.matchBase`), never the full
// relative path -- a directory-scoped glob like `src/lib/**/*.ts` can therefore never match
// anything (its regex requires a literal `src/lib/` prefix the bare basename never has), which
// silently breaks the whole `/docs` route at "Collecting page data" time with `[MDX] this macro
// was not compiled by the bundler plugin`, confirmed against the real installed
// fumadocs-mdx@15.4.5 by both `next build` and `next build --webpack`. `'source.ts'` matches this
// module's exact basename regardless of directory, which is both correct and as narrowly scoped
// as this bundler's matching mode allows.
export default createMDX({ macro: { include: ['source.ts'] } })(nextConfig);
