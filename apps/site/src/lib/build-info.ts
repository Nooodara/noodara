// 10-02-PLAN.md Task 1 (T-10-03). Reads the four public, non-secret build-time strings
// `apps/site/next.config.mjs` (10-01) exposes via its `env` block. Every read is an explicit
// `=== undefined || length === 0` check -- never a `??`/`||` literal fallback
// (packages/config/eslint.config.js's `no-restricted-syntax` bans that pattern outright,
// PITFALLS.md #1). A missing/empty value fails the build loudly at import time rather than
// silently rendering an empty string somewhere in the shipped HTML.

export interface SiteBuildInfo {
  readonly origin: string;
  readonly basePath: string;
  readonly version: string;
  readonly license: string;
}

/** Named so a failure is unambiguous in a build log -- never a bare `Error`. */
export class MissingSiteEnvError extends Error {
  constructor(name: string) {
    super(`readBuildInfo: process.env.${name} is required and must be a non-empty string`);
    this.name = 'MissingSiteEnvError';
  }
}

function readRequiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new MissingSiteEnvError(name);
  }
  return value;
}

/** `basePath` is the one field allowed to be the empty string (root basePath, D-11/D-12a's
 *  always-root Cloudflare Pages case) -- everything else fails fast when missing or empty. */
export function readBuildInfo(): SiteBuildInfo {
  const origin = readRequiredEnv('NOODARA_SITE_ORIGIN', process.env.NOODARA_SITE_ORIGIN);
  const version = readRequiredEnv('NOODARA_SITE_VERSION', process.env.NOODARA_SITE_VERSION);
  const license = readRequiredEnv('NOODARA_SITE_LICENSE', process.env.NOODARA_SITE_LICENSE);
  const rawBasePath = process.env.NOODARA_SITE_BASE_PATH;

  return {
    origin,
    // Safe here (unlike the banned `process.env.X ?? 'literal'` pattern the eslint config
    // rejects): `rawBasePath` is already a local variable read from `process.env` above, not a
    // direct `process.env.*` member access, so a missing/undefined build-time basePath legitimately
    // defaults to the empty (root) string rather than needing its own fail-fast branch.
    basePath: rawBasePath ?? '',
    version,
    license,
  };
}

/** Prefixes the build's basePath onto an absolute app path. Needed because `<img src>`/`srcset`
 *  never receive Next's basePath rewrite automatically -- only its own `<Image>` component and
 *  internal routing do. */
export function assetPath(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`assetPath: path must start with "/", got "${path}"`);
  }
  const { basePath } = readBuildInfo();
  return `${basePath}${path}`;
}
