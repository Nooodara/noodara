// 08-02-PLAN.md Task 1 (fix, discovered during the real capture run): `capture-ui-review.ts`
// seeds the connected fixture server and the error fixture server against the SAME real sshd
// Testcontainer (08-01-SUMMARY.md's own documented decision — one container, not two), but
// `apps/control-plane`'s `servers_host_port_unique_idx` rejects a second server row at the exact
// same (host, port) pair. `alternateHostForSameEndpoint` picks a second, equally valid way to
// address that same real container so the DB row is legitimately distinct while the TCP endpoint
// it dials is identical — never a stub, never a second container.
import { describe, expect, it } from 'vitest';
import { alternateHostForSameEndpoint } from '../../../scripts/ui/fixture-host.js';

describe('alternateHostForSameEndpoint', () => {
  it('maps localhost to 127.0.0.1', () => {
    expect(alternateHostForSameEndpoint('localhost')).toBe('127.0.0.1');
  });

  it('maps 127.0.0.1 to localhost', () => {
    expect(alternateHostForSameEndpoint('127.0.0.1')).toBe('localhost');
  });

  it('never returns the same string it was given, for either alias', () => {
    expect(alternateHostForSameEndpoint('localhost')).not.toBe('localhost');
    expect(alternateHostForSameEndpoint('127.0.0.1')).not.toBe('127.0.0.1');
  });
});
