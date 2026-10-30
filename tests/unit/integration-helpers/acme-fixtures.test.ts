// Unit guards for the v0.4 proxy/ACME fixtures (21-01, ADR 0011).
//   H1: the proxy contracts only pull digest-pinned images from PROXY_FIXTURE_IMAGES (no :latest).
//   H3: no integration or E2E fixture names a Let's Encrypt CA; every ACME directory URL is the
//       Pebble container's, so test runs can never consume real ACME rate limits.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const { PEBBLE_ACME_DIRECTORY_URL, PROXY_FIXTURE_IMAGES, TRAEFIK_IMAGE, assertAllowlistedImage } =
  await import('../../integration/helpers/pebble.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCANNED_DIRS = ['tests/integration', 'tests/e2e'];
const TEXT_FILE = /\.(?:[cm]?[jt]s|tsx|json|ya?ml|toml|sh|conf|env|txt|md)$|(?:^|\/)Dockerfile$/;
const CONTRACTS_V04 = 'tests/integration/deploy-engine/contracts-v04.test.ts';
const DIGEST = 'a'.repeat(64);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (TEXT_FILE.test(full) && statSync(full).size < 2_000_000) out.push(full);
  }
  return out;
}

const scanned = SCANNED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).map((file) => ({
  file: path.relative(ROOT, file),
  text: readFileSync(file, 'utf8'),
}));

describe('H1: proxy fixture image allowlist', () => {
  it('accepts every allowlisted image, each tag@sha256-pinned and never :latest', () => {
    expect(PROXY_FIXTURE_IMAGES.length).toBeGreaterThanOrEqual(3);
    for (const ref of PROXY_FIXTURE_IMAGES) {
      expect(ref).toMatch(/^[^@]+:[^@:]+@sha256:[0-9a-f]{64}$/);
      expect(ref).not.toMatch(/:latest@/);
      expect(assertAllowlistedImage(ref)).toBe(ref);
    }
  });

  it('rejects :latest, unpinned and unknown references', () => {
    expect(() => assertAllowlistedImage('traefik:latest')).toThrow(/not tag@sha256-pinned/);
    expect(() => assertAllowlistedImage(`traefik:latest@sha256:${DIGEST}`)).toThrow(/:latest/);
    expect(() => assertAllowlistedImage('traefik:v3.7.14')).toThrow(/not tag@sha256-pinned/);
    expect(() => assertAllowlistedImage('traefik')).toThrow(/not tag@sha256-pinned/);
    expect(() => assertAllowlistedImage(`traefik@sha256:${DIGEST}`)).toThrow(
      /not tag@sha256-pinned/,
    );
    expect(() => assertAllowlistedImage(`traefik:v3.7.14@sha256:${DIGEST}`)).toThrow(
      /not in PROXY_FIXTURE_IMAGES/,
    );
    const traefikTagged = TRAEFIK_IMAGE.split('@')[0] ?? '';
    expect(() => assertAllowlistedImage(traefikTagged)).toThrow(/not tag@sha256-pinned/);
  });

  it('the v0.4 contracts pull only through the allowlist and never let docker run/create pull', () => {
    const source = scanned.find((entry) => entry.file === CONTRACTS_V04)?.text;
    if (source === undefined) throw new Error(`${CONTRACTS_V04} not found`);
    expect(source).not.toMatch(/[a-z0-9]:latest\b/);
    const pulls = source.split('\n').filter((line) => /docker pull\b/.test(line));
    expect(pulls.length).toBeGreaterThan(0);
    for (const line of pulls) expect(line).toContain('assertAllowlistedImage(');
    const starts = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && /docker (?:run|create)\b/.test(line));
    expect(starts.length).toBeGreaterThan(0);
    for (const line of starts) expect(line).toContain('--pull never');
  });
});

describe('H3: integration and E2E fixtures only ever name the Pebble ACME directory', () => {
  it('no fixture names a Let\'s Encrypt production or staging CA', () => {
    const offenders = scanned
      .filter(({ text }) => /letsencrypt\.org|acme-v0\d|acme-staging/i.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('every caServer and every ACME directory URL is the Pebble container URL', () => {
    const caServers: string[] = [];
    const directories: string[] = [];
    for (const { file, text } of scanned) {
      for (const match of text.matchAll(/caServer["']?\s*[:=]\s*["']?(\$\{[A-Z_]+\}|[^\s"',}]+)/g)) {
        caServers.push(`${file}: ${match[1] ?? ''}`);
      }
      for (const match of text.matchAll(/https?:\/\/[^\s'"`)]+\/(?:dir|directory)(?=[\s'"`)]|$)/g)) {
        directories.push(`${file}: ${match[0]}`);
      }
    }
    // Not vacuous: the v0.4 contracts configure a resolver.
    expect(caServers.some((entry) => entry.startsWith(CONTRACTS_V04))).toBe(true);
    for (const entry of caServers) {
      expect(entry).toMatch(/: (?:\$\{PEBBLE_ACME_DIRECTORY_URL\}|https:\/\/pebble:14000\/dir)$/);
    }
    for (const entry of directories) expect(entry.endsWith(`: ${PEBBLE_ACME_DIRECTORY_URL}`)).toBe(true);
  });
});
