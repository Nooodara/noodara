import { describe, expect, it } from 'vitest';
import { validateHost, validateSshPort } from './network.js';

describe('validateSshPort', () => {
  it.each([1, 22, 65535])('accepts port %d', (port) => {
    const result = validateSshPort(port);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(port);
  });

  it.each([0, -1, 65536])('rejects out-of-range port %d', (port) => {
    const result = validateSshPort(port);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PORT_OUT_OF_RANGE');
  });

  it('rejects a non-integer port (22.5)', () => {
    const result = validateSshPort(22.5);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PORT_NOT_INTEGER');
  });

  it('rejects NaN', () => {
    const result = validateSshPort(Number.NaN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PORT_NOT_INTEGER');
  });

  it("rejects the string '22' (type-level rejection asserted at runtime)", () => {
    const result = validateSshPort('22');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('PORT_NOT_INTEGER');
  });
});

describe('validateHost', () => {
  describe('accepts', () => {
    it('a dotted IPv4 literal', () => {
      const result = validateHost('192.168.1.10');
      expect(result).toEqual({ ok: true, value: '192.168.1.10' });
    });

    it('an IPv6 literal (2001:db8::1)', () => {
      const result = validateHost('2001:db8::1');
      expect(result).toEqual({ ok: true, value: '2001:db8::1' });
    });

    it('an IPv6 literal (::1)', () => {
      const result = validateHost('::1');
      expect(result).toEqual({ ok: true, value: '::1' });
    });

    it('an RFC 1123 hostname', () => {
      const result = validateHost('srv-01.example.com');
      expect(result).toEqual({ ok: true, value: 'srv-01.example.com' });
    });

    it('normalises SRV-01.Example.COM. to srv-01.example.com (lowercased, trailing dot removed)', () => {
      const result = validateHost('SRV-01.Example.COM.');
      expect(result).toEqual({ ok: true, value: 'srv-01.example.com' });
    });
  });

  describe('rejects', () => {
    it('an empty string', () => {
      const result = validateHost('');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_EMPTY');
    });

    it('a label starting with a hyphen', () => {
      const result = validateHost('-bad.example.com');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_INVALID_LABEL');
    });

    it('a label ending with a hyphen', () => {
      const result = validateHost('bad-.example.com');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_INVALID_LABEL');
    });

    it('a label longer than 63 characters', () => {
      const longLabel = 'a'.repeat(64);
      const result = validateHost(`${longLabel}.example.com`);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_INVALID_LABEL');
    });

    it('a total length over 253 characters', () => {
      const label = 'a'.repeat(60);
      const longHost = Array.from({ length: 5 }, () => label).join('.');
      expect(longHost.length).toBeGreaterThan(253);
      const result = validateHost(longHost);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_TOO_LONG');
    });

    it('an IPv4 with an octet above 255', () => {
      const result = validateHost('192.168.1.999');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_INVALID_IPV4_OCTET');
    });

    it('a value containing a scheme (ssh://host)', () => {
      const result = validateHost('ssh://host');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_CONTAINS_SCHEME');
    });

    it('a value containing a port (host:22)', () => {
      const result = validateHost('host:22');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_CONTAINS_PORT');
    });

    it('a value containing whitespace', () => {
      const result = validateHost('srv 01.example.com');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_CONTAINS_WHITESPACE');
    });

    it.each([';', '|', '&', '$', '`', '(', ')', '<', '>'])(
      'a value containing the shell metacharacter %s',
      (metacharacter) => {
        const result = validateHost(`srv${metacharacter}host`);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.code).toBe('HOST_CONTAINS_METACHARACTER');
      },
    );

    it('validateHost("srv;rm -rf /") fails with a code naming the metacharacter rejection', () => {
      const result = validateHost('srv;rm -rf /');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('HOST_CONTAINS_METACHARACTER');
    });
  });
});
