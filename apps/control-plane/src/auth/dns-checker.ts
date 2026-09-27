// D-03/ADR-0004: the email-domain MX/A check for SET-02's email edit. Follows require-session.ts's
// narrow structural-interface DI pattern (`DnsResolverLike`, not `dns.promises.Resolver` itself)
// so tests substitute a hand-built fake and never touch the machine's real resolver — the same
// "measure the real shape, never assume it, never depend on the host's own DNS" discipline ADR
// 0004 established for the SSH/Docker adapters.
import { Resolver } from 'node:dns/promises';

export type DnsCheckOutcome = 'resolvable' | 'unresolvable' | 'unavailable';

export interface DnsResolverLike {
  resolveMx(hostname: string): Promise<readonly { exchange: string }[]>;
  resolve4(hostname: string): Promise<readonly string[]>;
  cancel?(): void;
}

export interface DnsChecker {
  checkEmailDomain(domain: string): Promise<DnsCheckOutcome>;
}

/** T-09-02: no email-domain lookup may hang a request beyond this bound. */
export const EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS = 3000;

// NXDOMAIN (ENOTFOUND) and "no records of this type" (ENODATA) both mean the domain has no MX/A
// records — a real, final answer, not a transient failure. Anything else (ETIMEOUT, ESERVFAIL,
// ECONNREFUSED, EREFUSED, ...) means the resolver itself could not get an answer, which must never
// be reported to the caller as "this domain is invalid" (T-09-15).
const UNRESOLVABLE_CODES = new Set(['ENOTFOUND', 'ENODATA']);

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
// T-09-21: a label must start and end with an alphanumeric character; hyphens are only allowed
// in the interior. No user-controlled resolver servers, no querying anything but MX/A, and no
// connection is ever opened to whatever the lookup resolves to.
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function isValidHostnameShape(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  const labels = domain.split('.');
  return labels.every(
    (label) => label.length > 0 && label.length <= MAX_LABEL_LENGTH && HOSTNAME_LABEL_PATTERN.test(label),
  );
}

function errorCode(reason: unknown): string | undefined {
  if (reason !== null && typeof reason === 'object' && 'code' in reason) {
    const code = (reason as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Whether a single settled lookup result (MX or A) counts as a definitive "no records" answer,
 *  as opposed to a transient resolver failure. */
function isDefinitivelyEmpty(result: PromiseSettledResult<readonly unknown[]>): boolean {
  if (result.status === 'fulfilled') {
    return result.value.length === 0;
  }
  const code = errorCode(result.reason);
  return code !== undefined && UNRESOLVABLE_CODES.has(code);
}

function hasRecords(result: PromiseSettledResult<readonly unknown[]>): boolean {
  return result.status === 'fulfilled' && result.value.length > 0;
}

/**
 * `createDnsChecker` builds a `DnsChecker` bound to an injected resolver (defaulting to a real
 * `node:dns/promises` `Resolver` tuned for a single, bounded try) and an explicit timeout. Never
 * throws: any unexpected exception, and the timeout itself, map to `'unavailable'` — a caller
 * (09-06's profile-edit service) can then show an honest "couldn't check right now" error instead
 * of falsely claiming the domain is invalid.
 */
export function createDnsChecker(options: { resolver?: DnsResolverLike; timeoutMs?: number } = {}): DnsChecker {
  const resolver = options.resolver ?? new Resolver({ timeout: 2000, tries: 1 });
  const timeoutMs = options.timeoutMs ?? EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS;

  return {
    async checkEmailDomain(domain: string): Promise<DnsCheckOutcome> {
      const lowered = domain.toLowerCase();
      if (!isValidHostnameShape(lowered)) {
        return 'unresolvable';
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timed-out');
        }, timeoutMs);
      });

      try {
        const raced = await Promise.race([
          Promise.allSettled([resolver.resolveMx(lowered), resolver.resolve4(lowered)]),
          timedOut,
        ]);

        if (raced === 'timed-out') {
          resolver.cancel?.();
          return 'unavailable';
        }

        const [mxResult, aResult] = raced;

        if (hasRecords(mxResult) || hasRecords(aResult)) {
          return 'resolvable';
        }

        if (isDefinitivelyEmpty(mxResult) && isDefinitivelyEmpty(aResult)) {
          return 'unresolvable';
        }

        return 'unavailable';
      } catch {
        return 'unavailable';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
