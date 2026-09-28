// 10-12-PLAN.md Round 1 fix batch (orchestrator review, item 6). RED: written before docs-nav.ts
// exists. Proves DOCS_NAV_GROUPS matches the real meta.json/frontmatter tree independently
// (separate fs reads, same discipline as docs-tree.test.ts) so the footer's per-group page lists
// can never silently drift from the real docs sidebar.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_NAV_GROUPS } from './docs-nav';

const CONTENT_DOCS_DIR = path.join(import.meta.dirname, '../../content/docs');

interface MetaJson {
  readonly title?: string;
  readonly pages?: readonly string[];
}

function readMetaJson(...segments: string[]): MetaJson {
  return JSON.parse(readFileSync(path.join(CONTENT_DOCS_DIR, ...segments), 'utf8')) as MetaJson;
}

function readFrontmatterTitle(group: string, slug: string): string {
  const mdx = readFileSync(path.join(CONTENT_DOCS_DIR, group, `${slug}.mdx`), 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(mdx);
  const titleMatch = /^title:\s*(.+)$/m.exec(match?.[1] ?? '');
  return (titleMatch?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
}

const GROUP_SLUGS = ['getting-started', 'concepts', 'operate', 'reference'] as const;

describe('DOCS_NAV_GROUPS', () => {
  it('has exactly 4 groups in D-08 order', () => {
    expect(DOCS_NAV_GROUPS.map((g) => g.heading)).toEqual(['Getting started', 'Concepts', 'Operate', 'Reference']);
  });

  it('every group lists every page from its real meta.json, with the real frontmatter title and href', () => {
    for (const [index, slug] of GROUP_SLUGS.entries()) {
      const meta = readMetaJson(slug, 'meta.json');
      const group = DOCS_NAV_GROUPS[index];
      if (group === undefined) throw new Error(`missing DOCS_NAV_GROUPS[${String(index)}]`);
      const pages = meta.pages ?? [];
      expect(group.links).toHaveLength(pages.length);
      for (const [pageIndex, page] of pages.entries()) {
        const link = group.links[pageIndex];
        expect(link).toEqual({ label: readFrontmatterTitle(slug, page), href: `/docs/${slug}/${page}` });
      }
    }
  });

  it('every group has more than one page (the defect this fixes: footer showed only one link per group)', () => {
    for (const group of DOCS_NAV_GROUPS) {
      expect(group.links.length).toBeGreaterThan(1);
    }
  });
});
