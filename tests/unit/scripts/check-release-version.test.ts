import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkReleaseConsistency, parseReleaseTag } from '../../../scripts/check-release-version.mjs';
import { scanWorkflowPins } from '../../../scripts/check-workflow-pins.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const RELEASE_YML = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');

describe('parseReleaseTag', () => {
  it.each([
    ['v0.2.0', '0.2.0', false],
    ['0.2.0', '0.2.0', false],
    ['v0.2.0-rc.1', '0.2.0', true],
    ['v1.10.3-rc.12', '1.10.3', true],
  ])('accepts %s', (tag, base, prerelease) => {
    expect(parseReleaseTag(tag)).toMatchObject({ base, prerelease });
  });

  it.each(['v0.2.0-rc', 'v0.2.0-rc.0', 'v0.2.0-rc.0x', 'v0.2.0-rc.01', 'v0.2.0-rcfoo', 'v0.2.0-beta.1', 'v0.2', 'latest', 'v01.2.0', ''])(
    'rejects malformed tag %s',
    (tag) => {
      expect(parseReleaseTag(tag)).toBeNull();
    },
  );
});

describe('checkReleaseConsistency', () => {
  const versions = { 'package.json': '0.2.0', 'apps/web/package.json': '0.2.0' };

  it('passes when tag, packages and notes agree, for a final and for an rc tag', () => {
    expect(checkReleaseConsistency({ tag: 'v0.2.0', packageVersions: versions, notesExist: true })).toEqual([]);
    expect(checkReleaseConsistency({ tag: 'v0.2.0-rc.1', packageVersions: versions, notesExist: true })).toEqual([]);
  });

  it('fails when a package version disagrees with the tag', () => {
    const problems = checkReleaseConsistency({
      tag: 'v0.2.1',
      packageVersions: versions,
      notesExist: true,
    });
    expect(problems).toHaveLength(2);
  });

  it('fails when the release notes file is missing', () => {
    const problems = checkReleaseConsistency({ tag: 'v0.2.0', packageVersions: versions, notesExist: false });
    expect(problems.join('\n')).toContain('docs/releases/v0.2.0.md');
  });

  it('fails on a malformed tag', () => {
    expect(checkReleaseConsistency({ tag: 'v0.2.0-rc', packageVersions: versions, notesExist: true })).toHaveLength(1);
  });
});

describe('repository release state', () => {
  it('every workspace package.json and the release notes match 0.2.0', () => {
    const files = ['package.json'];
    for (const dir of ['apps', 'packages']) {
      for (const entry of readdirSync(path.join(ROOT, dir))) files.push(`${dir}/${entry}/package.json`);
    }
    const packageVersions: Record<string, string> = {};
    for (const file of files) {
      try {
        packageVersions[file] = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')).version ?? '(none)';
      } catch {
        // directory without a package.json
      }
    }
    let notesExist = true;
    try {
      readFileSync(path.join(ROOT, 'docs/releases/v0.2.0.md'), 'utf8');
    } catch {
      notesExist = false;
    }
    expect(checkReleaseConsistency({ tag: 'v0.2.0-rc.1', packageVersions, notesExist })).toEqual([]);
  });
});

describe('release.yml prerelease handling', () => {
  it('keeps every action pinned to a commit SHA', () => {
    expect(scanWorkflowPins(RELEASE_YML)).toEqual([]);
  });

  it('validates the tag with scripts/check-release-version.mjs before building', () => {
    expect(RELEASE_YML).toContain('scripts/check-release-version.mjs');
  });

  it('creates the GitHub Release with an explicit make_latest decision and a prerelease flag', () => {
    expect(RELEASE_YML).toMatch(/gh release create/);
    expect(RELEASE_YML).toMatch(/--prerelease/);
    expect(RELEASE_YML).toMatch(/--latest=false/);
  });

  it('never publishes the unversioned latest image tag', () => {
    expect(RELEASE_YML).not.toMatch(/:latest\b/);
  });

  it('gives only the release job contents: write and never grants write-all', () => {
    expect(RELEASE_YML).not.toMatch(/write-all/);
    const writes = RELEASE_YML.split('\n').filter((l) => !l.trim().startsWith('#') && /contents: write/.test(l));
    expect(writes).toHaveLength(1);
  });

  it('does not echo secrets', () => {
    expect(RELEASE_YML).not.toMatch(/echo[^\n]*secrets\./);
  });
});
