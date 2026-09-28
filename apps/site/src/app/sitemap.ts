import type { MetadataRoute } from 'next';
import { readBuildInfo } from '../lib/build-info';
import { buildSitemapEntries } from '../lib/seo';
import { source } from '../lib/source';

// 10-07-PLAN.md Task 2 (D-14, D-12a). `force-static`: this export has no server, so the sitemap
// must be computable entirely at build time, same as every other route in this app. Always on
// readBuildInfo().origin -- the canonical https://noodara.com origin -- basePath is always root
// on Cloudflare Pages (D-12a).
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const { origin } = readBuildInfo();
  const paths = ['/', ...source.getPages().map((page) => page.url)];
  return buildSitemapEntries(paths, origin);
}
