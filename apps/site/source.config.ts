// 10-05-PLAN.md Task 1 (RESEARCH.md Pattern 2). Global Fumadocs MDX options. The docs collection
// itself is declared through the macro API in `src/lib/source.ts` (`defineDocs`/`loader`), not
// here -- this file only carries options that apply across every collection (MDX plugin config,
// remark/rehype extensions), of which this plan needs none yet.
import { defineConfig } from 'fumadocs-mdx/config';

export default defineConfig({});
