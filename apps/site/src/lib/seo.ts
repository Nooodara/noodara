// 10-07-PLAN.md Task 2 (D-14, SITE-01, D-12): pure sitemap/robots builders consumed by
// app/sitemap.ts and app/robots.ts. Never a `lastModified` field -- this artifact carries no
// dates (the same "no dates" rule 10-06's content-rules.ts enforces on prose, D-10). Always
// built against the caller-supplied canonical origin, never the preview build's basePath (D-12:
// "Canonical URLs always https://noodara.com/..., independent of the basePath computed for the
// non-CNAME preview build" -- 10-UI-SPEC.md SEO/Metadata Contract).

export interface SitemapEntry {
  readonly url: string;
}

/**
 * Builds one sitemap entry per distinct path, on `origin`, preserving first-seen order (so `/`,
 * listed first by the caller, stays first in the output).
 * @param paths - app-relative paths, e.g. ['/', '/docs', '/docs/getting-started/install']
 * @param origin - the canonical site origin, e.g. 'https://noodara.com'
 */
export function buildSitemapEntries(paths: readonly string[], origin: string): SitemapEntry[] {
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];

  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({ url: `${origin}${path}` });
  }

  return entries;
}

export interface RobotsConfig {
  readonly rules: { readonly userAgent: string; readonly allow: string };
  readonly sitemap: string;
}

/** Allows every crawler over the whole site and points at the canonical sitemap URL. */
export function buildRobots(origin: string): RobotsConfig {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${origin}/sitemap.xml`,
  };
}
