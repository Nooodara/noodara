import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 10-01-PLAN.md Task 1 (D-06/D-11/D-12): these three build-time decisions -- basePath, the
// footer version string, and the footer license name -- must be pure, tested functions, never a
// hand-typed literal in `apps/site` UI/config code. This test is written before
// apps/site/site-config.mjs exists (RED), per CLAUDE.md's TDD gate.
import {
  PREVIEW_BASE_PATH,
  SITE_ORIGIN,
  describeLatestTag,
  readCname,
  readLicenseName,
  resolveBasePath,
  resolveSiteVersion,
} from '../../../apps/site/site-config.mjs';

describe('SITE_ORIGIN / PREVIEW_BASE_PATH', () => {
  it('SITE_ORIGIN is the canonical noodara.com origin (D-12)', () => {
    expect(SITE_ORIGIN).toBe('https://noodara.com');
  });

  it('PREVIEW_BASE_PATH is the GitHub Pages project-site fallback (D-12)', () => {
    expect(PREVIEW_BASE_PATH).toBe('/noodara');
  });
});

describe('resolveBasePath', () => {
  it('returns the empty string (root) when a CNAME exists', () => {
    expect(resolveBasePath({ cnameExists: true })).toBe('');
  });

  it('returns /noodara when no CNAME exists', () => {
    expect(resolveBasePath({ cnameExists: false })).toBe(PREVIEW_BASE_PATH);
  });
});

describe('readCname', () => {
  it('returns the trimmed first line of public/CNAME when present', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-site-config-'));
    mkdirSync(path.join(dir, 'public'), { recursive: true });
    writeFileSync(path.join(dir, 'public', 'CNAME'), 'noodara.com\n', 'utf8');

    expect(readCname(dir)).toBe('noodara.com');

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when public/CNAME is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-site-config-'));

    expect(readCname(dir)).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when public/CNAME is empty', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-site-config-'));
    mkdirSync(path.join(dir, 'public'), { recursive: true });
    writeFileSync(path.join(dir, 'public', 'CNAME'), '', 'utf8');

    expect(readCname(dir)).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveSiteVersion', () => {
  it('prefers a valid v* semver git tag over package.json', () => {
    expect(resolveSiteVersion({ latestTag: 'v0.2.0', packageVersion: '0.1.0' })).toBe('v0.2.0');
  });

  it('falls back to package.json when there is no tag', () => {
    expect(resolveSiteVersion({ latestTag: null, packageVersion: '0.1.0' })).toBe('v0.1.0');
  });

  it('ignores a non-semver tag and falls back to package.json', () => {
    expect(resolveSiteVersion({ latestTag: 'nightly', packageVersion: '0.1.0' })).toBe('v0.1.0');
  });

  it('throws when neither a valid tag nor a released package.json version exists', () => {
    expect(() => resolveSiteVersion({ latestTag: null, packageVersion: '0.0.0' })).toThrow(
      /no v\* git tag.*not a release/,
    );
  });
});

describe('describeLatestTag', () => {
  it('never throws -- returns null when git has no v* tag or is unavailable (D-14 timeout safety)', () => {
    // A freshly created empty temp dir has no git repository at all, so `git describe` always
    // fails here -- this exercises the "never throws" contract without depending on this
    // monorepo's own (non-existent-locally, see 10-RESEARCH.md) git tags.
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-site-config-git-'));

    expect(() => describeLatestTag(dir)).not.toThrow();
    expect(describeLatestTag(dir)).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('readLicenseName', () => {
  it('parses "Apache License 2.0" from the real repository LICENSE file', () => {
    const licenseText = readFileSync(path.join(process.cwd(), 'LICENSE'), 'utf8');

    expect(readLicenseName(licenseText)).toBe('Apache License 2.0');
  });

  it('throws when the text does not look like a license header', () => {
    expect(() => readLicenseName('random text with no license header')).toThrow();
  });
});
