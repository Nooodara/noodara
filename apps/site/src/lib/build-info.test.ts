// 10-02-PLAN.md Task 1 (T-10-03): the site's build-time env reader -- next.config.mjs's `env`
// block (10-01) exposes exactly four public, non-secret strings; this module reads them
// fail-fast, never a `??`/`||` literal fallback (packages/config/eslint.config.js bans that
// pattern outright). RED: written before build-info.ts exists.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetPath, readBuildInfo } from './build-info';

afterEach(() => {
  vi.unstubAllEnvs();
});

const VALID_ENV = {
  NOODARA_SITE_ORIGIN: 'https://noodara.com',
  NOODARA_SITE_BASE_PATH: '',
  NOODARA_SITE_VERSION: 'v0.1.0',
  NOODARA_SITE_LICENSE: 'Apache License 2.0',
};

function stubValidEnv(overrides: Partial<Record<keyof typeof VALID_ENV, string | undefined>> = {}): void {
  const merged = { ...VALID_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    vi.stubEnv(key, value);
  }
}

describe('readBuildInfo', () => {
  it('returns { origin, basePath, version, license } from the NOODARA_SITE_* env', () => {
    stubValidEnv();

    expect(readBuildInfo()).toEqual({
      origin: 'https://noodara.com',
      basePath: '',
      version: 'v0.1.0',
      license: 'Apache License 2.0',
    });
  });

  it('accepts a non-empty basePath', () => {
    stubValidEnv({ NOODARA_SITE_BASE_PATH: '/noodara' });
    expect(readBuildInfo().basePath).toBe('/noodara');
  });

  it('throws a named error when NOODARA_SITE_ORIGIN is missing', () => {
    stubValidEnv({ NOODARA_SITE_ORIGIN: undefined });
    vi.stubEnv('NOODARA_SITE_ORIGIN', '');
    expect(() => readBuildInfo()).toThrow(/NOODARA_SITE_ORIGIN/);
  });

  it('throws a named error when NOODARA_SITE_VERSION is empty', () => {
    stubValidEnv({ NOODARA_SITE_VERSION: '' });
    expect(() => readBuildInfo()).toThrow(/NOODARA_SITE_VERSION/);
  });

  it('throws a named error when NOODARA_SITE_LICENSE is empty', () => {
    stubValidEnv({ NOODARA_SITE_LICENSE: '' });
    expect(() => readBuildInfo()).toThrow(/NOODARA_SITE_LICENSE/);
  });

  it('basePath may be the empty string without throwing', () => {
    stubValidEnv({ NOODARA_SITE_BASE_PATH: '' });
    expect(() => readBuildInfo()).not.toThrow();
  });
});

describe('assetPath', () => {
  it('prefixes the basePath onto an absolute path', () => {
    stubValidEnv({ NOODARA_SITE_BASE_PATH: '/noodara' });
    expect(assetPath('/screenshots/servers-light.png')).toBe('/noodara/screenshots/servers-light.png');
  });

  it('returns the bare path when basePath is empty', () => {
    stubValidEnv({ NOODARA_SITE_BASE_PATH: '' });
    expect(assetPath('/screenshots/servers-light.png')).toBe('/screenshots/servers-light.png');
  });

  it('throws when the argument does not start with "/"', () => {
    stubValidEnv();
    expect(() => assetPath('screenshots/servers-light.png')).toThrow(/must start with/);
  });
});
