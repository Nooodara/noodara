import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_VERSION } from './config-version.js';

// This file lives at src/config-version.test.ts, so `apps/control-plane/package.json` sits one
// level up — the same relative depth `config-version.ts` itself resolves against (RESEARCH.md
// Pattern 6). Reads the file independently through `node:fs` rather than importing the constant
// under test a second time, so a real drift between the two reads would actually fail this test.
function readPackageVersion(): string {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const contents = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  return contents.version;
}

describe('CONTROL_PLANE_VERSION', () => {
  it('equals the version field independently read from package.json, never a hardcoded literal', () => {
    expect(CONTROL_PLANE_VERSION).toBe(readPackageVersion());
  });

  it('is a non-empty, semver-ish string', () => {
    expect(CONTROL_PLANE_VERSION.length).toBeGreaterThan(0);
    expect(CONTROL_PLANE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
