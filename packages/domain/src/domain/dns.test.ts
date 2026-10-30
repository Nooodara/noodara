import { describe, expect, it } from 'vitest';
import { DNS_OUTCOMES, DNS_OUTCOME_MESSAGES, classifyDnsOutcome, dnsInstructions } from './dns.js';

describe('DNS outcomes (A3)', () => {
  it('is a closed vocabulary with a fixed actionable message each', () => {
    expect(DNS_OUTCOMES).toEqual(['RESOLVES', 'MISMATCH', 'UNRESOLVED', 'UNAVAILABLE']);
    expect(Object.isFrozen(DNS_OUTCOMES)).toBe(true);
    expect(Object.keys(DNS_OUTCOME_MESSAGES).sort()).toEqual([...DNS_OUTCOMES].sort());
    for (const outcome of DNS_OUTCOMES) {
      expect(DNS_OUTCOME_MESSAGES[outcome]).toMatch(/^[A-Z].+\.$/);
    }
    expect(DNS_OUTCOME_MESSAGES.MISMATCH).toMatch(/A\/AAAA record/);
    expect(DNS_OUTCOME_MESSAGES.UNRESOLVED).toMatch(/A\/AAAA record/);
    expect(DNS_OUTCOME_MESSAGES.UNAVAILABLE).toMatch(/again/);
  });

  it.each([
    [{ kind: 'addresses', addresses: ['198.51.100.7', '203.0.113.10'] }, 'RESOLVES'],
    [{ kind: 'addresses', addresses: ['2001:DB8::1'] }, 'RESOLVES'],
    [{ kind: 'addresses', addresses: ['198.51.100.7'] }, 'MISMATCH'],
    [{ kind: 'addresses', addresses: [] }, 'UNRESOLVED'],
    [{ kind: 'not-found' }, 'UNRESOLVED'],
    [{ kind: 'error' }, 'UNAVAILABLE'],
  ] as const)('classifies %j as %s', (answer, outcome) => {
    expect(classifyDnsOutcome(answer, ['203.0.113.10', '2001:db8::1'])).toBe(outcome);
  });

  it('is a MISMATCH when the server has no known IP', () => {
    expect(classifyDnsOutcome({ kind: 'addresses', addresses: ['203.0.113.10'] }, [])).toBe(
      'MISMATCH',
    );
  });
});

describe('dnsInstructions (A3, H2)', () => {
  it('returns A and AAAA records for the server IPs and the CNAME alternative as data', () => {
    const result = dnsInstructions(
      'app.example.com',
      ['2001:db8::1', '203.0.113.10', '203.0.113.10', 'not-an-ip', '300.1.1.1'],
      'vps.example.net',
    );
    expect(result).toEqual({
      ok: true,
      value: {
        hostname: 'app.example.com',
        records: [
          { type: 'A', name: 'app.example.com', value: '203.0.113.10' },
          { type: 'AAAA', name: 'app.example.com', value: '2001:db8::1' },
        ],
        cnameAlternative: {
          type: 'CNAME',
          name: 'app.example.com',
          target: 'vps.example.net',
        },
      },
    });
  });

  it('has no CNAME target when the server is known only by IP', () => {
    const result = dnsInstructions('app.example.com', ['203.0.113.10'], '203.0.113.10');
    expect(result.ok && result.value.cnameAlternative).toEqual({
      type: 'CNAME',
      name: 'app.example.com',
      target: null,
    });
    const noHost = dnsInstructions('app.example.com', ['203.0.113.10']);
    expect(noHost.ok && noHost.value.cnameAlternative.target).toBeNull();
  });

  it('returns no records when the server IPs are unknown', () => {
    const result = dnsInstructions('app.example.com', []);
    expect(result.ok && result.value.records).toEqual([]);
  });

  it.each([
    'app.local',
    'db.internal',
    'x.localhost',
    'svc.onion',
    'www.example',
    '10.in-addr.arpa',
    'localhost',
    '*.example.com',
    'https://app.example.com',
    'App.example.com',
    '203.0.113.10',
  ])('never emits a record for the rejected name %s', (hostname) => {
    const result = dnsInstructions(hostname, ['203.0.113.10', '2001:db8::1'], 'vps.example.net');
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('value');
  });
});
