'use client';

// 10-05-PLAN.md Task 2 (D-16). Isolated `'use client'` boundary around the one `@noodara/ui`
// import `apps/site/src/app/docs/layout.tsx` needs: `@noodara/ui`'s barrel (`index.ts`) re-exports
// several components that use hooks with no `'use client'` directive of their own (the same
// pattern every apps/web consumer of `@noodara/ui` already relies on -- see e.g.
// apps/web/src/app/setup/page.tsx). `docs/layout.tsx` itself stays a Server Component; only this
// file crosses into the client graph, so the barrel's other (client-only, hook-using) exports
// never load into a Server Component's module graph.
import { Lockup } from '@noodara/ui';

export function DocsNavTitle() {
  return <Lockup title="Noodara" height={20} />;
}
