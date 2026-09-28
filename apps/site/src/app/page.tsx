// 10-02-PLAN.md deviation (Rule 3, blocking issue): `next build --output export` needs at least
// one route to export at all -- this plan's own scope is the theme/token/layout shell, not the
// landing page content (D-01..D-06, a later plan). This is a bare, unstyled placeholder so
// `pnpm --filter @noodara/site build` succeeds and `apps/site/out/` exists; the next landing plan
// replaces this file's body entirely.
export default function HomePage() {
  return <main>Noodara</main>;
}
