import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOsRelease } from './os-release.js';

function readFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const UBUNTU_22_04 = readFixture('./fixtures/ubuntu-22.04/os_release.txt');
const UBUNTU_24_04 = readFixture('./fixtures/ubuntu-24.04/os_release.txt');

describe('parseOsRelease', () => {
  it('parses the captured Ubuntu 22.04 fixture as Ubuntu 22.04, supported', () => {
    const result = parseOsRelease(UBUNTU_22_04);

    expect(result).toEqual({
      ok: true,
      value: { distribution: 'Ubuntu', version: '22.04', supported: true },
    });
  });

  it('parses the captured Ubuntu 24.04 fixture as Ubuntu 24.04, supported', () => {
    const result = parseOsRelease(UBUNTU_24_04);

    expect(result).toEqual({
      ok: true,
      value: { distribution: 'Ubuntu', version: '24.04', supported: true },
    });
  });

  // Synthetic: no fixture image runs Debian (fixtures/ubuntu-22.04 and ubuntu-24.04 are Ubuntu
  // only). DISC-04 requires an unsupported distro to still return its distribution/version.
  it('reports a Debian input as unsupported, without throwing and without losing the facts', () => {
    const debianOsRelease = [
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
      'NAME="Debian"',
      'VERSION_ID="12"',
      'VERSION="12 (bookworm)"',
      'ID=debian',
    ].join('\n');

    const result = parseOsRelease(debianOsRelease);

    expect(result).toEqual({
      ok: true,
      value: { distribution: 'Debian', version: '12', supported: false },
    });
  });

  // Synthetic: an unsupported *version* of a supported distro — no fixture captures this since
  // the sshd images only exist for 22.04 and 24.04.
  it('reports an Ubuntu 20.04 input as unsupported, with distribution and version populated', () => {
    const ubuntu2004 = ['NAME="Ubuntu"', 'VERSION_ID="20.04"', 'ID=ubuntu'].join('\n');

    const result = parseOsRelease(ubuntu2004);

    expect(result).toEqual({
      ok: true,
      value: { distribution: 'Ubuntu', version: '20.04', supported: false },
    });
  });

  // Synthetic: ID is lowercase by convention, not by guarantee — the comparison must tolerate a
  // differently-cased ID without a fixture existing for that shape.
  it('is case-insensitive on ID when deciding support', () => {
    const upperCaseId = ['NAME="Ubuntu"', 'VERSION_ID="24.04"', 'ID=Ubuntu'].join('\n');

    const result = parseOsRelease(upperCaseId);

    expect(result).toEqual({
      ok: true,
      value: { distribution: 'Ubuntu', version: '24.04', supported: true },
    });
  });

  // Synthetic: exercises quoted/unquoted values, an '=' inside a value, comment lines, blank
  // lines and CRLF line endings all in one input, none of which any real fixture combines.
  it('handles quoted and unquoted values, "=" inside a value, comments, blank lines and CRLF', () => {
    const messyOsRelease = [
      '# this is a comment and must be skipped',
      '',
      'NAME=Ubuntu',
      'VERSION_ID="24.04"',
      'ID=ubuntu',
      'HOME_URL="https://example.com/path?a=b&c=d"',
      '',
      '# trailing comment',
    ].join('\r\n');

    const result = parseOsRelease(messyOsRelease);

    expect(result).toEqual({
      ok: true,
      value: { distribution: 'Ubuntu', version: '24.04', supported: true },
    });
  });

  it('fails on empty input, naming both missing fields', () => {
    const result = parseOsRelease('');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('OS_RELEASE_MISSING_FIELDS');
    expect(!result.ok && result.message).toContain('ID');
    expect(!result.ok && result.message).toContain('VERSION_ID');
  });

  it('fails when VERSION_ID is missing, naming it specifically', () => {
    const result = parseOsRelease(['NAME="Ubuntu"', 'ID=ubuntu'].join('\n'));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('OS_RELEASE_MISSING_FIELDS');
    expect(!result.ok && result.message).toContain('VERSION_ID');
    expect(!result.ok && result.message).not.toContain('ID, ');
  });

  it('fails when ID is missing, naming it specifically', () => {
    const result = parseOsRelease(['NAME="Ubuntu"', 'VERSION_ID="24.04"'].join('\n'));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('OS_RELEASE_MISSING_FIELDS');
    expect(!result.ok && result.message).toContain('ID');
  });

  it('falls back to ID for distribution when NAME is absent', () => {
    const noName = ['VERSION_ID="24.04"', 'ID=ubuntu'].join('\n');

    const result = parseOsRelease(noName);

    expect(result).toEqual({
      ok: true,
      value: { distribution: 'ubuntu', version: '24.04', supported: true },
    });
  });
});
