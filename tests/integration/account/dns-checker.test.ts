// D-03/ADR-0004: the one integration test that exercises the real `node:dns/promises` `Resolver`,
// against a domain that never resolves in DNS (RFC 2606 `.invalid` TLD). This never asserts a
// real-world domain resolves — only that the outcome lands in the bounded, non-'resolvable' set
// within the documented time budget, matching ADR 0004's "measure the real shape, assert the
// possible set" precedent for the SSH/Docker adapters.
import { describe, expect, it } from 'vitest';
import { createDnsChecker, EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS } from '../../../apps/control-plane/src/auth/dns-checker.js';

describe('createDnsChecker (real resolver)', () => {
  it('resolves a .invalid domain to unresolvable or unavailable within the timeout budget, never resolvable', async () => {
    const checker = createDnsChecker();
    const start = Date.now();

    const outcome = await checker.checkEmailDomain('noodara-phase9.invalid');

    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThanOrEqual(EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS + 500);
    expect(['unresolvable', 'unavailable']).toContain(outcome);
    // not.toBe: the whole point of this suite is that a `.invalid` domain never comes back
    // resolvable, whichever of the two non-resolvable outcomes the real resolver produces.
    expect(outcome).not.toBe('resolvable');
  });
});
