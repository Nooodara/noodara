import { Toolbar } from '../../../components/Toolbar';

// Temporary placeholder body: Plan 05-13 replaces this with the real list screen
// (05-UI-SPEC.md SS2.3). This plan (05-12) needs at least one real page inside the `(shell)`
// route group -- without one, `/servers` has no matching route and the shell layout (sidebar,
// toolbar, keyboard path, responsive breakpoints) never renders for a real navigation, which
// would make this plan's own must_haves/E2E coverage unsatisfiable. Login already redirects here
// on success (Plan 05-11).
export default function ServersPage() {
  return (
    <>
      <Toolbar title="Servers" />
      <div className="p-8" />
    </>
  );
}
