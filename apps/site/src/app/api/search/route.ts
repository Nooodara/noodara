// 10-05-PLAN.md Task 2 (D-08 static search, RESEARCH.md Pattern 3). `revalidate = false` +
// `staticGET` bake this response into the static export at build time (`○ /api/search`, not a
// live endpoint) -- required for `output: 'export'`, which has no server to run a dynamic route
// handler on. D-14: flexsearch, same origin, zero third-party search service.
import { flexsearchFromSource } from 'fumadocs-core/search/flexsearch';
import { source } from '../../../lib/source';

export const revalidate = false;

export const { staticGET: GET } = flexsearchFromSource(source);
