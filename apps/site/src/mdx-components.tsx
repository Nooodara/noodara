// 10-05-PLAN.md Task 2. `getMDXComponents` is the merge point every MDX page (docs page route
// today, plan 10-06's ScopeNote/ScopeTable later) uses to render its compiled body -- Fumadocs'
// own default component set (headings, tables, code blocks, callouts) plus whatever overrides a
// caller passes, never the default set alone (so a later plan can extend this file instead of
// duplicating it).
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
  };
}
