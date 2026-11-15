// 35-03 A6: the SSH fixture timeout evidence under docs/testing/ssh-fixture-timeouts/ was captured
// from real CI and contributor runs. Every committed file must be free of home paths, IPs, host or
// user names, tokens and full UUIDs (shared rules in docs-hygiene-rules.ts plus a stricter UUID
// rule that also catches UUIDs glued to other word characters, which `\b` misses). Every JSON file
// must parse, the frozen runner archive must keep its recorded sha256, and evidence-index.json must
// describe the files actually committed (including the post-sanitization hashes).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HYGIENE_RULES, docFiles, findLeaks } from './docs-hygiene-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS_DIR = path.join(root, 'docs/testing/ssh-fixture-timeouts');
const EMBEDDED_UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/i;

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const rel = (file: string): string => path.relative(DOCS_DIR, file).split(path.sep).join('/');

function embeddedUuidLines(text: string): number[] {
  return text.split('\n').flatMap((line, index) => (EMBEDDED_UUID.test(line) ? [index + 1] : []));
}

interface EvidenceIndex {
  readonly frozenArchive: Record<string, string>;
  readonly files: Record<string, string>;
  readonly sanitization: { readonly files: Record<string, { readonly after: string }> };
}

describe('docs/testing/ssh-fixture-timeouts hygiene (35-03 A6)', () => {
  const files = docFiles(DOCS_DIR);
  const index = JSON.parse(readFileSync(path.join(DOCS_DIR, 'evidence-index.json'), 'utf8')) as EvidenceIndex;

  it('covers the closure record and the evidence index', () => {
    expect(files.map(rel)).toEqual(expect.arrayContaining(['README.md', 'evidence-index.json']));
  });

  it.each(files.map((file) => [rel(file), file]))('%s has no home paths, IPs, hostnames, tokens or full UUIDs', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(findLeaks(text)).toEqual([]);
    expect(embeddedUuidLines(text)).toEqual([]);
  });

  it('the embedded-UUID rule catches UUIDs glued to word characters that the shared rule misses', () => {
    // Assembled at runtime so this file never contains a UUID literal.
    const glued = `run_${['3f2b8c1d', '9a4e', '4b7f', '8c2d', '1e5f6a7b8c9d'].join('-')}x`;
    const shared = HYGIENE_RULES.find((rule) => rule.name === 'full UUID');
    expect(shared?.pattern.test(glued)).toBe(false);
    expect(embeddedUuidLines(glued)).toEqual([1]);
    expect(embeddedUuidLines(`commit ${'a'.repeat(40)}`)).toEqual([]);
  });

  it.each(files.filter((file) => file.endsWith('.json')).map((file) => [rel(file), file]))('%s parses as JSON', (_name, file) => {
    expect(() => JSON.parse(readFileSync(file, 'utf8')) as unknown).not.toThrow();
  });

  it('keeps the frozen runner archive byte-identical', () => {
    expect(Object.keys(index.frozenArchive).sort()).toEqual(['runner.config.ts', 'runner.mjs', 'runner.test.ts']);
    for (const [name, expected] of Object.entries(index.frozenArchive)) {
      expect(sha256(path.join(DOCS_DIR, name)), name).toBe(expected);
    }
  });

  it('indexes exactly the committed evidence files with their current sha256', () => {
    const committed = files.map(rel).filter((name) => name !== 'README.md' && name !== 'evidence-index.json').sort();
    expect(Object.keys(index.files).sort()).toEqual(committed);
    for (const name of committed) expect(sha256(path.join(DOCS_DIR, name)), name).toBe(index.files[name]);
  });

  it('records the post-sanitization sha256 of every sanitized file', () => {
    const sanitized = Object.entries(index.sanitization.files);
    expect(sanitized.length).toBeGreaterThan(0);
    for (const [name, record] of sanitized) expect(sha256(path.join(DOCS_DIR, name)), name).toBe(record.after);
  });
});
