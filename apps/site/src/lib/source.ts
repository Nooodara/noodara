// 10-05-PLAN.md Task 1 (DOCS-01, D-08). The Fumadocs MDX loader: `defineDocs` is a build-time
// macro (transformed by `fumadocs-mdx/next`'s `createMDX({ macro: { include: [...] } })`, wired
// in next.config.mjs) that globs `content/docs/**/*.mdx` and `**/meta.json` and returns a
// `MacroDocsCollection`; `loader()` turns that into the runtime API (`source.pageTree`,
// `source.getPage()`, `source.generateParams()`) the docs route and search route both read.
//
// `dir` must be a statically analyzable string literal (fumadocs-mdx's own macro constraint), so
// it is written out in full here rather than composed from a shared constant.
//
// No docs versioning (D-08: "sin versionado de docs, solo la versión actual") -- a single,
// un-namespaced `content/docs` tree, one `baseUrl`, no `i18n` option.
import { loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({ dir: 'content/docs' });

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
