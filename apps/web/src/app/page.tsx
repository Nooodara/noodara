import { redirect } from 'next/navigation';

// WR-B-15 (05-VERIFICATION.md gap 8 / 05-35-PLAN.md Task 1): the bare origin printed by an
// installer, or bookmarked by an admin, had no route at all -- an authenticated visitor hit
// Next's default 404. This Server Component redirects to /servers, the product's home surface
// (05-UI-SPEC.md). It never fetches, never renders a client bundle, and never makes its own
// authorization decision:
//
//   - An authenticated visitor lands directly on /servers (which itself sits behind
//     `apps/web/src/proxy.ts`'s matcher and the shell layout's own `requireSession()` mount
//     check, same as every other protected route -- no new auth logic here).
//   - An unauthenticated visitor never reaches this component at all: `proxy.ts`'s matcher
//     already covers `/` (its negative-lookahead excludes only api/_next/favicon/login/setup),
//     so the redirect to /login happens one hop earlier, before this file's own redirect would
//     ever run. This file does not special-case that path -- inventing a second unauthenticated
//     branch here would be exactly the divergent auth logic the plan's threat model forbids
//     (T-5G-35-01).
export default function RootPage(): never {
  redirect('/servers');
}
