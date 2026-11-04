import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A3: provider SDKs are imported only under packages/ai/src/providers, the key is revealed only
// there, and packages/domain never imports packages/ai. ESLint enforces the same rule.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SELF = 'packages/ai/src/import-boundaries.test.ts';
const PROVIDERS_DIR = 'packages/ai/src/providers/';
const SDK = /^(@anthropic-ai\/|openai(\/|$)|@aws-sdk\/|@azure\/openai(\/|$))/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(path);
  }
  return out;
}

function workspaceSources(): string[] {
  const files: string[] = [];
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, name, 'src');
      try {
        if (statSync(src).isDirectory()) files.push(...sourceFiles(src));
      } catch {
        // workspace without src
      }
    }
  }
  return files;
}

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? '');
}

interface Violation {
  readonly file: string;
  readonly rule: string;
}

function violations(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  const inProviders = file.startsWith(PROVIDERS_DIR);
  for (const specifier of specifiers(source)) {
    if (SDK.test(specifier) && !inProviders) found.push({ file, rule: `provider SDK ${specifier}` });
    if (file.startsWith('packages/domain/') && specifier.startsWith('@noodara/ai')) found.push({ file, rule: 'domain imports ai' });
  }
  if (file.startsWith('packages/ai/src/') && !inProviders && !file.endsWith('.test.ts') && /\brevealSecret\b/.test(source)) {
    found.push({ file, rule: 'revealSecret outside providers' });
  }
  return found;
}

describe('AI import boundaries (A3)', () => {
  it('the scanner catches each kind of violation', () => {
    expect(violations('apps/control-plane/src/x.ts', "import Anthropic from '@anthropic-ai/sdk';")).toHaveLength(1);
    expect(violations('packages/ai/src/x.ts', "const m = await import('openai');")).toHaveLength(1);
    expect(violations('packages/ai/src/x.ts', "export { a } from 'openai/resources';")).toHaveLength(1);
    expect(violations('packages/domain/src/x.ts', "import { createAIProvider } from '@noodara/ai';")).toHaveLength(1);
    expect(violations('packages/ai/src/call.ts', 'revealSecret(key)')).toHaveLength(1);
    expect(violations('packages/ai/src/providers/openai/index.ts', "import OpenAI from 'openai';\nrevealSecret(k)")).toEqual([]);
    expect(violations('packages/ai/src/x.ts', "import { z } from 'zod';")).toEqual([]);
  });

  it('no workspace source breaks the rules', () => {
    const files = workspaceSources();
    expect(files.some((file) => file.includes(join('packages', 'ai', 'src', 'providers')))).toBe(true);
    const found = files.flatMap((path) => {
      const file = relative(ROOT, path).split('\\').join('/');
      // This file quotes forbidden imports as scanner fixtures.
      if (file === SELF) return [];
      return violations(file, readFileSync(path, 'utf8'));
    });
    expect(found).toEqual([]);
  });

  it('packages/domain does not depend on @noodara/ai', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/domain/package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      expect(Object.keys(pkg[field] ?? {})).not.toContain('@noodara/ai');
    }
  });
});
