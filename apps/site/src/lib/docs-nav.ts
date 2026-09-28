// 10-12-PLAN.md Round 1 fix batch (orchestrator review, item 6). SiteFooter's four docs columns
// showed one link each ("Getting started: Install", "Concepts: Server", ...) -- looked broken,
// like an incomplete list. Fixed by reading every page of each D-08 group straight from its real
// meta.json + MDX frontmatter `title`, mirroring docs-tree.test.ts's own fs-based reading
// discipline (that test proves the same four meta.json files independently) rather than
// hand-typing a second copy of the sidebar that could drift from the real one.
//
// Build-time only (node:fs) -- SiteFooter.tsx is a Server Component, never imported by a
// 'use client' module, so this file is never bundled for the browser.
//
// CONTENT_DOCS_DIR can't commit to one resolution strategy: this module runs in two different
// environments that disagree about both `import.meta.dirname` and `process.cwd()`.
//   - Under Vitest/tsx (unbundled ESM), `import.meta.dirname` resolves correctly regardless of
//     cwd (matches docs-tree.test.ts's own precedent) -- tried first.
//   - Under `next build`/`next dev` (Next's own webpack/Turbopack bundling of this Server
//     Component graph), `import.meta.dirname` does not survive bundling (confirmed: `next build`
//     failed with "path.join(undefined, ...)"); `process.cwd()` is reliable there instead, since
//     turbo/pnpm always run that command with cwd = apps/site.
// existsSync picks whichever candidate is actually real on disk rather than assuming which
// environment is running.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function resolveContentDocsDir(): string {
  const fromModuleDir =
    typeof import.meta.dirname === 'string' ? path.join(import.meta.dirname, '../../content/docs') : undefined;
  const fromCwd = path.join(process.cwd(), 'content/docs');
  const candidates = [fromModuleDir, fromCwd].filter((candidate): candidate is string => candidate !== undefined);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`docs-nav: could not locate content/docs (tried: ${candidates.join(', ')})`);
  }
  return found;
}

const CONTENT_DOCS_DIR = resolveContentDocsDir();

interface MetaJson {
  readonly title?: string;
  readonly pages?: readonly string[];
}

function readMetaJson(...segments: string[]): MetaJson {
  const raw = readFileSync(path.join(CONTENT_DOCS_DIR, ...segments), 'utf8');
  return JSON.parse(raw) as MetaJson;
}

/** Minimal frontmatter reader -- mirrors docs-tree.test.ts's own (not a full YAML parser; every
 *  frontmatter value this reads is a single-line string). */
function readFrontmatterTitle(group: string, slug: string): string {
  const mdx = readFileSync(path.join(CONTENT_DOCS_DIR, group, `${slug}.mdx`), 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(mdx);
  const frontmatter = match?.[1];
  if (frontmatter === undefined) throw new Error(`docs-nav: ${group}/${slug}.mdx has no frontmatter block`);
  const titleMatch = /^title:\s*(.+)$/m.exec(frontmatter);
  const rawTitle = titleMatch?.[1];
  if (rawTitle === undefined) throw new Error(`docs-nav: ${group}/${slug}.mdx frontmatter has no title`);
  return rawTitle.trim().replace(/^["']|["']$/g, '');
}

export interface DocsNavLink {
  readonly label: string;
  readonly href: string;
}

export interface DocsNavGroup {
  readonly heading: string;
  readonly links: readonly DocsNavLink[];
}

// D-08 order: Getting started, Concepts, Operate, Reference.
const GROUP_SLUGS = ['getting-started', 'concepts', 'operate', 'reference'] as const;

function readGroup(slug: (typeof GROUP_SLUGS)[number]): DocsNavGroup {
  const meta = readMetaJson(slug, 'meta.json');
  const heading = meta.title;
  const pages = meta.pages;
  if (heading === undefined) throw new Error(`docs-nav: ${slug}/meta.json has no title`);
  if (pages === undefined) throw new Error(`docs-nav: ${slug}/meta.json has no pages`);
  return {
    heading,
    links: pages.map((page) => ({ label: readFrontmatterTitle(slug, page), href: `/docs/${slug}/${page}` })),
  };
}

export const DOCS_NAV_GROUPS: readonly DocsNavGroup[] = GROUP_SLUGS.map(readGroup);
