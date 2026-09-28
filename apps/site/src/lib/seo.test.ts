// 10-07-PLAN.md Task 2 (D-14, SITE-01, D-12): pure sitemap/robots builders -- no dates
// (no `lastModified`, D-14's own "no dates" carryover from D-10), always on the canonical
// origin regardless of the preview basePath (D-12). RED: written before seo.ts exists.

import { describe, expect, it } from 'vitest';
import { buildRobots, buildSitemapEntries } from './seo';

describe('buildSitemapEntries', () => {
  it('returns one entry per path, on the given origin, "/" first', () => {
    const entries = buildSitemapEntries(
      ['/', '/docs', '/docs/getting-started/install'],
      'https://noodara.com',
    );

    expect(entries).toEqual([
      { url: 'https://noodara.com/' },
      { url: 'https://noodara.com/docs' },
      { url: 'https://noodara.com/docs/getting-started/install' },
    ]);
  });

  it('de-duplicates repeated paths', () => {
    const entries = buildSitemapEntries(['/', '/docs', '/docs'], 'https://noodara.com');
    expect(entries).toHaveLength(2);
  });

  it('never carries a lastModified field (no dates in the artifact)', () => {
    const entries = buildSitemapEntries(['/'], 'https://noodara.com');
    expect(entries[0]).not.toHaveProperty('lastModified');
  });

  it('always uses the given canonical origin, independent of any preview basePath', () => {
    const entries = buildSitemapEntries(['/docs'], 'https://noodara.com');
    expect(entries[0]?.url.startsWith('https://noodara.com/')).toBe(true);
    expect(entries[0]?.url).not.toContain('/noodara/');
  });
});

describe('buildRobots', () => {
  it('allows everything and points at the canonical sitemap URL', () => {
    expect(buildRobots('https://noodara.com')).toEqual({
      rules: { userAgent: '*', allow: '/' },
      sitemap: 'https://noodara.com/sitemap.xml',
    });
  });
});
