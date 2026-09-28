import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_STATUSES } from '../../../packages/domain/src/server/server-state';
import { STATUS_WORDS } from '../../../packages/ui/src/tone';

const DOCS_DIR = 'apps/site/content/docs';
const WEB_SRC_DIR = 'apps/web/src';

const docsPage = (rel: string) => readFileSync(path.join(DOCS_DIR, `${rel}.mdx`), 'utf8');

/** Every non-test .tsx/.ts file under apps/web/src, concatenated -- the real source of UI label
 *  strings. A label bolded in the guide must occur verbatim somewhere in this text. */
function listSourceFiles(dir: string, extensions: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      results.push(...listSourceFiles(absolute, extensions));
    } else if (extensions.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      results.push(absolute);
    }
  }
  return results;
}

const webSrcText = () =>
  listSourceFiles(WEB_SRC_DIR, /\.(tsx|ts)$/)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

/** Every `**...**` bold span in a Markdown string, in order of appearance. */
function boldSpans(text: string): string[] {
  return [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1] ?? '').filter((s) => s.length > 0);
}

const FORBIDDEN_UI_PHRASES = ['in the panel you can', 'click', 'the UI lets', 'open the'];

describe('getting-started/first-server.mdx matches the real UI', () => {
  const page = docsPage('getting-started/first-server');
  const src = webSrcText();

  it('every bold span occurs verbatim in a non-test file under apps/web/src', () => {
    const spans = boldSpans(page);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(src.includes(span), `bold span "${span}" not found verbatim under apps/web/src`).toBe(true);
    }
  });

  it('covers install, first login, add a server, trust the fingerprint, discovery and server detail, in order', () => {
    const markers = [
      '/docs/getting-started/install',
      '/docs/getting-started/first-login',
      'Add server',
      'Trust new fingerprint',
      'Discovery',
      'server detail',
    ];
    let lastIndex = -1;
    for (const marker of markers) {
      const index = page.indexOf(marker);
      expect(index, `"${marker}" not found in first-server.mdx`).toBeGreaterThan(-1);
      expect(index, `"${marker}" appears out of order in first-server.mdx`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('mentions no agent is installed on the server, and links to Troubleshooting and Error codes', () => {
    expect(page).toMatch(/\bno agent\b/i);
    expect(page).toContain('/docs/operate/troubleshooting');
    expect(page).toContain('/docs/reference/error-codes');
  });
});

describe('concepts/server.mdx statuses match the domain', () => {
  it('the Statuses table lists exactly SERVER_STATUSES mapped through STATUS_WORDS', () => {
    const page = docsPage('concepts/server');
    const match = page.match(/## Statuses\n([\s\S]*?)(\n## |$)/);
    expect(match, '"## Statuses" section not found').toBeTruthy();
    const section = match?.[1] ?? '';
    const words = [...section.matchAll(/^\|\s*([A-Za-z]+)\s*\|/gm)].map((m) => m[1] ?? '');

    const expectedWords = SERVER_STATUSES.map((status) => STATUS_WORDS[status]);
    expect(new Set(words)).toEqual(new Set(expectedWords));
    expect(words.length).toBe(expectedWords.length);
  });
});

describe('concepts pages carry the right in-context scope notes', () => {
  it('service.mdx contains both deploy-services and app-config ScopeNotes', () => {
    const page = docsPage('concepts/service');
    expect(page).toMatch(/<ScopeNote id="deploy-services"\s*\/>/);
    expect(page).toMatch(/<ScopeNote id="app-config"\s*\/>/);
  });

  it('environment.mdx contains the app-config ScopeNote', () => {
    expect(docsPage('concepts/environment')).toMatch(/<ScopeNote id="app-config"\s*\/>/);
  });

  it('deployment.mdx contains the deploy-services ScopeNote', () => {
    expect(docsPage('concepts/deployment')).toMatch(/<ScopeNote id="deploy-services"\s*\/>/);
  });
});

describe('the model is described, not unbuilt UI', () => {
  for (const slug of ['project', 'environment', 'service', 'deployment']) {
    it(`concepts/${slug}.mdx never claims the panel manages this entity`, () => {
      const page = docsPage(`concepts/${slug}`).toLowerCase();
      for (const phrase of FORBIDDEN_UI_PHRASES) {
        expect(page.includes(phrase.toLowerCase()), `"${phrase}" found in concepts/${slug}.mdx`).toBe(false);
      }
    });
  }
});
