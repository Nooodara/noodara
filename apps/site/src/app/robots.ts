import type { MetadataRoute } from 'next';
import { readBuildInfo } from '../lib/build-info';
import { buildRobots } from '../lib/seo';

// 10-07-PLAN.md Task 2 (D-14). Same force-static/canonical-origin reasoning as app/sitemap.ts.
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  const { origin } = readBuildInfo();
  return buildRobots(origin);
}
