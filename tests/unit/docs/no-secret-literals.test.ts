// 24-05 H1: no docs page or doc file carries a secret-looking literal, even as an example.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['apps/site/content/docs', 'docs', 'README.md'];
const SKIP = new Set(['node_modules', 'ui-review']);
const SECRET_LITERALS: readonly [string, RegExp][] = [
  ['OpenAI/Anthropic key', /\bsk-[A-Za-z0-9_-]{8,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{8,}/],
  ['private key block', /BEGIN [A-Z ]*PRIVATE KEY/],
];

function files(entry: string): string[] {
  if (!existsSync(entry)) return [];
  if (!statSync(entry).isDirectory()) return /\.(mdx?|json)$/.test(entry) ? [entry] : [];
  return readdirSync(entry).filter((name) => !SKIP.has(name)).flatMap((name) => files(path.join(entry, name)));
}

describe('docs carry no secret-looking literal', () => {
  const all = ROOTS.flatMap(files);

  it('scans the site docs and the repo docs', () => {
    expect(all.some((f) => f.startsWith('apps/site/content/docs/operate/variables-and-secrets'))).toBe(true);
    expect(all.length).toBeGreaterThan(10);
  });

  for (const [label, pattern] of SECRET_LITERALS) {
    it(`finds no ${label}`, () => {
      const hits = all.filter((file) => pattern.test(readFileSync(file, 'utf8')));
      expect(hits).toEqual([]);
    });
  }
});
