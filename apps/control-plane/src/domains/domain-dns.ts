// 22-03 (A3): the advisory DNS check of a domain and its instructions. Only two names are ever
// resolved: the validated domain hostname and the server's host (when it is not an IP literal).
// Every lookup goes through the DnsResolverLike seam, bounded by DOMAIN_DNS_TIMEOUT_MS; a check
// of one domain is rate-limited per process.
import { Resolver } from 'node:dns/promises';
import {
  classifyDnsOutcome,
  dnsInstructions,
  ipFamily,
  validateHostname,
  type DnsAnswer,
  type DnsOutcome,
} from '@noodara/domain';
import type { DnsInstructionsView } from '@noodara/domain/api-contract';

export const DOMAIN_DNS_TIMEOUT_MS = 3000;
/** Minimum spacing of two checks of the same domain. */
export const DOMAIN_DNS_CHECK_INTERVAL_MS = 10_000;

export interface DnsResolverLike {
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
  cancel?(): void;
}

const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA']);

function codeOf(reason: unknown): string | undefined {
  if (reason !== null && typeof reason === 'object' && 'code' in reason) {
    const code = (reason as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function createSystemDnsResolver(): DnsResolverLike {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  return {
    resolve4: (hostname) => resolver.resolve4(hostname),
    resolve6: (hostname) => resolver.resolve6(hostname),
    cancel: () => {
      resolver.cancel();
    },
  };
}

/** A and AAAA of one name, bounded; never rejects. */
export async function lookupAddresses(resolver: DnsResolverLike, hostname: string, timeoutMs = DOMAIN_DNS_TIMEOUT_MS): Promise<DnsAnswer> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    handle = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const settled = await Promise.race([
      Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]),
      timedOut,
    ]);
    if (settled === 'timeout') {
      resolver.cancel?.();
      return { kind: 'error' };
    }
    const addresses = settled.flatMap((result) => (result.status === 'fulfilled' ? [...result.value] : []));
    if (addresses.length > 0) return { kind: 'addresses', addresses };
    const allNotFound = settled.every((result) => result.status === 'fulfilled' || NOT_FOUND_CODES.has(codeOf(result.reason) ?? ''));
    return allNotFound ? { kind: 'not-found' } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/** The server's IPs: the host itself when it is an IP literal, else its A/AAAA answer (bounded). */
export async function serverAddresses(resolver: DnsResolverLike, serverHost: string): Promise<readonly string[] | null> {
  if (ipFamily(serverHost) !== null) return [serverHost];
  const host = validateHostname(serverHost);
  if (!host.ok) return null;
  const answer = await lookupAddresses(resolver, host.value);
  return answer.kind === 'addresses' ? answer.addresses : null;
}

export async function checkDomainDns(resolver: DnsResolverLike, hostname: string, serverHost: string): Promise<DnsOutcome> {
  const validated = validateHostname(hostname);
  if (!validated.ok) return 'UNAVAILABLE';
  const [answer, ips] = await Promise.all([lookupAddresses(resolver, validated.value), serverAddresses(resolver, serverHost)]);
  if (answer.kind === 'addresses' && ips === null) return 'UNAVAILABLE';
  return classifyDnsOutcome(answer, ips ?? []);
}

/** Instructions without any lookup: A/AAAA when the server host is an IP, the CNAME alternative otherwise. */
export function instructionsFor(hostname: string, serverHost: string): DnsInstructionsView | null {
  const isIp = ipFamily(serverHost) !== null;
  const built = dnsInstructions(hostname, isIp ? [serverHost] : [], isIp ? null : serverHost);
  if (!built.ok) return null;
  return {
    hostname: built.value.hostname,
    records: built.value.records.map((record) => ({ type: record.type, name: record.name, value: record.value })),
    cnameAlternative: {
      type: 'CNAME',
      name: built.value.cnameAlternative.name,
      target: built.value.cnameAlternative.target,
    },
  };
}

export interface DnsCheckLimiter {
  /** True when the check may run now; records the attempt. */
  take(domainId: string): boolean;
}

export function createDnsCheckLimiter(intervalMs = DOMAIN_DNS_CHECK_INTERVAL_MS, now: () => number = Date.now): DnsCheckLimiter {
  const last = new Map<string, number>();
  const MAX_ENTRIES = 10_000;
  return {
    take(domainId) {
      const at = now();
      const previous = last.get(domainId);
      if (previous !== undefined && at - previous < intervalMs) return false;
      if (last.size >= MAX_ENTRIES) {
        for (const [id, seen] of last) if (at - seen >= intervalMs) last.delete(id);
        if (last.size >= MAX_ENTRIES) last.clear();
      }
      last.set(domainId, at);
      return true;
    },
  };
}
