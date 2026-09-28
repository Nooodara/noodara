// 10-05-PLAN.md Task 1 (D-08). This test reads the five meta.json files and every MDX file under
// `apps/site/content/docs` straight off disk with `node:fs` -- no Fumadocs import at all -- so it
// pins the sidebar's four-group order and the "no forbidden claim" content rule independently of
// whether Fumadocs' own loader parses the tree the same way (that's proven separately by the real
// `pnpm --filter @noodara/site build` route summary in Task 2). Runs under the `apps` vitest
// project (apps/*/src/**/*.test.ts, node environment) -- see vitest.config.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTENT_DOCS_DIR = path.join(import.meta.dirname, '../../content/docs');

interface MetaJson {
  readonly title?: string;
  readonly pages?: readonly string[];
}

function readMetaJson(...segments: string[]): MetaJson {
  const raw = readFileSync(path.join(CONTENT_DOCS_DIR, ...segments), 'utf8');
  return JSON.parse(raw) as MetaJson;
}

/** Every MDX file under content/docs, relative to that directory (e.g. `index.mdx`,
 *  `getting-started/install.mdx`). Walks recursively; no external glob dependency needed for a
 *  tree this shallow. */
function listMdxFiles(dir: string = CONTENT_DOCS_DIR, prefix = ''): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...listMdxFiles(absolute, `${prefix}${entry}/`));
    } else if (entry.endsWith('.mdx')) {
      files.push(`${prefix}${entry}`);
    }
  }
  return files;
}

/** Minimal frontmatter reader: extracts a top-level `key: "value"` or `key: value` line between
 *  the first two `---` markers. Deliberately not a full YAML parser -- this repo has no
 *  `gray-matter` dependency and every frontmatter value this test reads is a single-line string. */
function readFrontmatterField(mdx: string, field: string): string | undefined {
  const match = mdx.match(/^---\n([\s\S]*?)\n---/);
  if (match === null) return undefined;
  const frontmatter = match[1] as string;
  const fieldMatch = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (fieldMatch === undefined || fieldMatch === null) return undefined;
  return (fieldMatch[1] as string).trim().replace(/^["']|["']$/g, '');
}

describe('content/docs meta.json tree (D-08 four-group sidebar order)', () => {
  it('root meta.json orders index before the four groups', () => {
    const root = readMetaJson('meta.json');
    expect(root.pages).toEqual(['index', 'getting-started', 'concepts', 'operate', 'reference']);
  });

  it('getting-started/meta.json has the D-08 title and page order', () => {
    const meta = readMetaJson('getting-started', 'meta.json');
    expect(meta.title).toBe('Getting started');
    expect(meta.pages).toEqual(['install', 'first-login', 'first-server']);
  });

  it('concepts/meta.json has the D-08 title and page order', () => {
    const meta = readMetaJson('concepts', 'meta.json');
    expect(meta.title).toBe('Concepts');
    expect(meta.pages).toEqual(['server', 'project', 'environment', 'service', 'deployment']);
  });

  it('operate/meta.json has the D-08 title and page order', () => {
    const meta = readMetaJson('operate', 'meta.json');
    expect(meta.title).toBe('Operate');
    expect(meta.pages).toEqual(['upgrade', 'rollback', 'backups', 'troubleshooting']);
  });

  it('reference/meta.json has the D-08 title and page order', () => {
    const meta = readMetaJson('reference', 'meta.json');
    expect(meta.title).toBe('Reference');
    expect(meta.pages).toEqual(['variables', 'exit-codes', 'error-codes', 'scope']);
  });

  it('no page slug appears in more than one group', () => {
    const groups = ['getting-started', 'concepts', 'operate', 'reference'] as const;
    const seen = new Map<string, string>();
    for (const group of groups) {
      const meta = readMetaJson(group, 'meta.json');
      for (const slug of meta.pages ?? []) {
        const owner = seen.get(slug);
        expect(owner, `"${slug}" appears in both "${owner}" and "${group}"`).toBeUndefined();
        seen.set(slug, group);
      }
    }
  });

  it('every MDX file under content/docs has a non-empty title and description', () => {
    const mdxFiles = listMdxFiles();
    expect(mdxFiles.length).toBeGreaterThan(0);
    for (const relativePath of mdxFiles) {
      const raw = readFileSync(path.join(CONTENT_DOCS_DIR, relativePath), 'utf8');
      const title = readFrontmatterField(raw, 'title');
      const description = readFrontmatterField(raw, 'description');
      expect(title, `${relativePath}: missing/empty title`).toBeTruthy();
      expect(description, `${relativePath}: missing/empty description`).toBeTruthy();
    }
  });
});
