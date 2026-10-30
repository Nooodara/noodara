// Advisory DNS check for a Domain (DMN-02, ADR 0011 A3). The control plane resolves the hostname
// through the `DnsResolverLike` seam; this module only classifies the answer and describes the
// records the user should create. Both are pure. A rejected hostname never yields a record.

import { type ValidationResult, ok } from '../validators/network.js';
import { type Hostname, ipFamily, validateHostname } from './hostname.js';

export const DNS_OUTCOMES = Object.freeze([
  'RESOLVES',
  'MISMATCH',
  'UNRESOLVED',
  'UNAVAILABLE',
] as const);

export type DnsOutcome = (typeof DNS_OUTCOMES)[number];

export const DNS_OUTCOME_MESSAGES: Readonly<Record<DnsOutcome, string>> = Object.freeze({
  RESOLVES: 'The domain points at this server.',
  MISMATCH:
    'The domain resolves, but not to this server. Change its A/AAAA record to the server IP.',
  UNRESOLVED:
    'The domain has no A/AAAA record yet. Add one pointing at the server IP; DNS changes can take a few minutes.',
  UNAVAILABLE: 'DNS could not be checked right now. Run the DNS check again in a moment.',
});

/** What the resolver returned: addresses, NXDOMAIN/no data, or an error or timeout. */
export type DnsAnswer =
  | { readonly kind: 'addresses'; readonly addresses: readonly string[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'error' };

/** RESOLVES when any A/AAAA answer equals a server IP (case-insensitive). */
export function classifyDnsOutcome(answer: DnsAnswer, serverIps: readonly string[]): DnsOutcome {
  if (answer.kind === 'error') return 'UNAVAILABLE';
  if (answer.kind === 'not-found' || answer.addresses.length === 0) return 'UNRESOLVED';
  const server = new Set(serverIps.map((ip) => ip.toLowerCase()));
  return answer.addresses.some((address) => server.has(address.toLowerCase()))
    ? 'RESOLVES'
    : 'MISMATCH';
}

export interface DnsAddressRecord {
  readonly type: 'A' | 'AAAA';
  readonly name: Hostname;
  readonly value: string;
}

export interface DnsCnameAlternative {
  readonly type: 'CNAME';
  readonly name: Hostname;
  /** The server's own hostname, or null when the server is known only by IP. */
  readonly target: Hostname | null;
}

export interface DnsInstructions {
  readonly hostname: Hostname;
  readonly records: readonly DnsAddressRecord[];
  readonly cnameAlternative: DnsCnameAlternative;
}

/**
 * The A/AAAA records pointing `hostname` at the server (A first, deduplicated, non-IP entries
 * dropped) and the CNAME alternative. Fails with the hostname's error when it is rejected.
 */
export function dnsInstructions(
  hostname: string,
  serverIps: readonly string[],
  serverHostname?: string | null,
): ValidationResult<DnsInstructions> {
  const validated = validateHostname(hostname);
  if (!validated.ok) return validated;
  const name = validated.value;

  const unique = [...new Set(serverIps)];
  const a = unique.filter((ip) => ipFamily(ip) === 4);
  const aaaa = unique.filter((ip) => ipFamily(ip) === 6);
  const records: DnsAddressRecord[] = [
    ...a.map((value) => ({ type: 'A' as const, name, value })),
    ...aaaa.map((value) => ({ type: 'AAAA' as const, name, value })),
  ];

  const target = validateHostname(serverHostname);
  return ok({
    hostname: name,
    records,
    cnameAlternative: {
      type: 'CNAME',
      name,
      target: target.ok ? target.value : null,
    },
  });
}
