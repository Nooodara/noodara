// Parses `/etc/os-release` (DISC-01, DISC-04). It is a plain key=value file per
// freedesktop.org's os-release spec: one KEY=value pair per line, `#` comments and blank lines
// allowed, values optionally wrapped in a single layer of single or double quotes. `supported`
// never throws for an unrecognised distribution or version (DISC-04) — the caller still gets the
// distribution and version back, so the UI can show e.g. "Debian 12 (unsupported)" instead of
// nothing at all.

import type { ValidationResult } from '../validators/network.js';
import { fail, ok } from '../validators/network.js';
import { SUPPORTED_UBUNTU_VERSIONS } from './types.js';

export interface OsRelease {
  readonly distribution: string;
  readonly version: string;
  readonly supported: boolean;
}

function stripQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  const isDoubleQuoted = first === '"' && last === '"';
  const isSingleQuoted = first === "'" && last === "'";
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}

function parseFields(stdout: string): Map<string, string> {
  const fields = new Map<string, string>();

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripQuotes(line.slice(separatorIndex + 1).trim());
    fields.set(key, value);
  }

  return fields;
}

export function parseOsRelease(stdout: string): ValidationResult<OsRelease> {
  const fields = parseFields(stdout);
  const id = fields.get('ID');
  const versionId = fields.get('VERSION_ID');

  const missing: string[] = [];
  if (id === undefined) {
    missing.push('ID');
  }
  if (versionId === undefined) {
    missing.push('VERSION_ID');
  }
  if (id === undefined || versionId === undefined) {
    return fail(
      'OS_RELEASE_MISSING_FIELDS',
      `/etc/os-release output is missing required field(s): ${missing.join(', ')}`,
    );
  }

  const distribution = fields.get('NAME') ?? id;
  const isUbuntu = id.toLowerCase() === 'ubuntu';
  const isSupportedVersion = (SUPPORTED_UBUNTU_VERSIONS as readonly string[]).includes(versionId);

  return ok({
    distribution,
    version: versionId,
    supported: isUbuntu && isSupportedVersion,
  });
}
