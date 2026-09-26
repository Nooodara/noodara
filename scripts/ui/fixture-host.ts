// 08-02-PLAN.md Task 1 (fix, discovered during the real capture run): `capture-ui-review.ts`
// deliberately seeds the connected fixture server and the error fixture server against the SAME
// real sshd Testcontainer (08-01-SUMMARY.md's own documented decision: one container, a
// deliberately wrong password for the error case, never a second container). But
// `apps/control-plane`'s `servers_host_port_unique_idx` rejects a second `Server` row at the
// exact same (host, port) pair, so creating the error fixture with the connected fixture's own
// `sshd.host` string always fails.
//
// `alternateHostForSameEndpoint` gives the error fixture a second, equally valid way to address
// that same real container: Testcontainers' own `resolveHost` (container-runtime/utils/
// resolve-host.js) only ever returns `localhost` on this stack (no `TESTCONTAINERS_HOST_OVERRIDE`,
// not running inside a container), and `localhost`/`127.0.0.1` are both real, reachable, RFC-1123-
// or-IPv4-valid addresses for the exact same Docker-published port on this machine — never a
// second container, never a stub.

/** Flips between the two host strings Docker Desktop resolves identically on this machine.
 *  Deliberately a two-value swap, not a general alias table: the only value
 *  `startCriticalPathSshd()`'s `sshd.host` is ever observed to hold on this stack is `localhost`
 *  (see this file's header comment); documented here rather than generalized to inputs this
 *  script never actually produces. */
export function alternateHostForSameEndpoint(host: string): string {
  return host === 'localhost' ? '127.0.0.1' : 'localhost';
}
