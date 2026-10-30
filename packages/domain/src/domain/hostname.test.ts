import { describe, expect, it } from 'vitest';
import {
  HOSTNAME_ERROR_CODES,
  MAX_DOMAINS_PER_SERVICE,
  MAX_HOSTNAME_LENGTH,
  SPECIAL_USE_TLDS,
  isReservedHostname,
  normaliseHostname,
  validateHostname,
} from './hostname.js';

function codeOf(input: unknown): string | null {
  const result = validateHostname(input);
  return result.ok ? null : result.code;
}

const label = (length: number, char = 'a'): string => char.repeat(length);

describe('validateHostname: accepted (A1)', () => {
  it.each([
    'example.com',
    'app.example.com',
    'a.b',
    'my-app.example.co.uk',
    '1password.com',
    'x1.example.io',
    'xn--bcher-kva.com',
    'shop.xn--bcher-kva.de',
    'example.xn--p1ai',
    'api.fixture.test',
    'noodara.test',
  ])('accepts %s and returns it unchanged', (hostname) => {
    expect(validateHostname(hostname)).toEqual({ ok: true, value: hostname });
  });

  it('accepts a 63-character label and a 253-character name', () => {
    expect(codeOf(`${label(63)}.com`)).toBeNull();
    const name = [label(63), label(63), label(63), label(61)].join('.');
    expect(name).toHaveLength(MAX_HOSTNAME_LENGTH);
    expect(codeOf(name)).toBeNull();
  });
});

describe('validateHostname: rejected with a named error (A1, H2)', () => {
  it.each<[string, unknown, string]>([
    ['non-string', 42, 'HOSTNAME_REQUIRED'],
    ['undefined', undefined, 'HOSTNAME_REQUIRED'],
    ['empty', '', 'HOSTNAME_REQUIRED'],
    ['too long', [label(63), label(63), label(63), label(62)].join('.'), 'HOSTNAME_TOO_LONG'],
    ['inner whitespace', 'my app.example.com', 'HOSTNAME_CONTAINS_WHITESPACE'],
    ['leading whitespace', ' example.com', 'HOSTNAME_CONTAINS_WHITESPACE'],
    ['tab', 'example.com\t', 'HOSTNAME_CONTAINS_WHITESPACE'],
    ['https scheme', 'https://example.com', 'HOSTNAME_CONTAINS_SCHEME'],
    ['http scheme', 'http://example.com/', 'HOSTNAME_CONTAINS_SCHEME'],
    ['path', 'example.com/app', 'HOSTNAME_CONTAINS_PATH'],
    ['query', 'example.com?x=1', 'HOSTNAME_CONTAINS_PATH'],
    ['fragment', 'example.com#top', 'HOSTNAME_CONTAINS_PATH'],
    ['backslash', 'example.com\\app', 'HOSTNAME_CONTAINS_PATH'],
    ['port', 'example.com:8080', 'HOSTNAME_CONTAINS_PORT'],
    ['ipv4', '203.0.113.10', 'HOSTNAME_IP_LITERAL'],
    ['ipv4 out of range', '999.1.1.1', 'HOSTNAME_IP_LITERAL'],
    ['ipv6', '2001:db8::1', 'HOSTNAME_IP_LITERAL'],
    ['ipv6 loopback', '::1', 'HOSTNAME_IP_LITERAL'],
    ['bracketed ipv6', '[2001:db8::1]', 'HOSTNAME_IP_LITERAL'],
    ['bracketed ipv6 with port', '[::1]:443', 'HOSTNAME_IP_LITERAL'],
    ['numeric tld', '127.1', 'HOSTNAME_NUMERIC_TLD'],
    ['numeric tld 3 parts', 'example.com.123', 'HOSTNAME_NUMERIC_TLD'],
    ['wildcard', '*.example.com', 'HOSTNAME_WILDCARD'],
    ['inner wildcard', 'a.*.example.com', 'HOSTNAME_WILDCARD'],
    ['trailing dot', 'example.com.', 'HOSTNAME_TRAILING_DOT'],
    ['uppercase', 'Example.com', 'HOSTNAME_UPPERCASE'],
    ['localhost', 'localhost', 'HOSTNAME_LOCALHOST'],
    ['single label', 'intranet', 'HOSTNAME_SINGLE_LABEL'],
    ['empty label', 'a..example.com', 'HOSTNAME_EMPTY_LABEL'],
    ['leading dot', '.example.com', 'HOSTNAME_EMPTY_LABEL'],
    ['label too long', `${label(64)}.com`, 'HOSTNAME_LABEL_TOO_LONG'],
    ['underscore', 'my_app.example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['unicode', 'bücher.de', 'HOSTNAME_INVALID_CHARACTER'],
    ['userinfo', 'user@example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['shell metacharacter', 'a;b.example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['leading hyphen', '-app.example.com', 'HOSTNAME_LABEL_HYPHEN'],
    ['trailing hyphen', 'app-.example.com', 'HOSTNAME_LABEL_HYPHEN'],
    ['bare xn--', 'xn--.example.com', 'HOSTNAME_LABEL_HYPHEN'],
    ['reserved R-LDH label', 'ab--cd.example.com', 'HOSTNAME_RESERVED_LABEL'],
    ['.localhost', 'app.localhost', 'HOSTNAME_SPECIAL_USE_TLD'],
    ['.local', 'printer.local', 'HOSTNAME_SPECIAL_USE_TLD'],
    ['.internal', 'db.internal', 'HOSTNAME_SPECIAL_USE_TLD'],
    ['.arpa', '10.in-addr.arpa', 'HOSTNAME_SPECIAL_USE_TLD'],
    ['home.arpa', 'nas.home.arpa', 'HOSTNAME_SPECIAL_USE_TLD'],
    ['.onion', 'abc.onion', 'HOSTNAME_SPECIAL_USE_TLD'],
    ['.example', 'www.example', 'HOSTNAME_SPECIAL_USE_TLD'],
    ['.invalid', 'foo.invalid', 'HOSTNAME_SPECIAL_USE_TLD'],
  ])('%s', (_name, input, code) => {
    expect(codeOf(input)).toBe(code);
  });

  it('keeps .test accepted for fixtures while every listed special-use TLD is rejected', () => {
    expect(SPECIAL_USE_TLDS).not.toContain('test');
    for (const tld of ['localhost', 'local', 'internal', 'arpa', 'onion', 'example']) {
      expect(SPECIAL_USE_TLDS).toContain(tld);
      expect(codeOf(`app.${tld}`)).toBe('HOSTNAME_SPECIAL_USE_TLD');
    }
  });

  it('every failure code is in the closed vocabulary and carries a message without the input', () => {
    const inputs: unknown[] = [
      42,
      'a b.c',
      'https://x.y',
      'x.y/z',
      'x.y:1',
      '1.2.3.4',
      '*.x.y',
      'x.y.',
      'X.y',
      'localhost',
      'x',
      'a..b',
      `${label(64)}.b`,
      'a_b.c',
      '-a.b',
      'ab--c.d',
      'a.local',
      'a.12',
      `${label(300)}.com`,
    ];
    for (const input of inputs) {
      const result = validateHostname(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(HOSTNAME_ERROR_CODES).toContain(result.code);
      expect(result.message.length).toBeGreaterThan(0);
      if (typeof input === 'string' && input.length > 3) {
        expect(result.message).not.toContain(input);
      }
    }
  });
});

describe('normaliseHostname', () => {
  it.each([
    ['  Example.COM  ', 'example.com'],
    ['example.com.', 'example.com'],
    ['APP.Example.com.. ', 'app.example.com'],
    ['example.com', 'example.com'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normaliseHostname(input)).toBe(expected);
  });

  it('is linear on a long run of whitespace that is not at the end', () => {
    const input = `${' '.repeat(200_000)}x`;
    const started = Date.now();
    expect(normaliseHostname(input)).toBe('x');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// Deterministic PRNG (mulberry32): the property runs are reproducible from the seed in the
// failure message, without a property-testing dependency.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ...Array.from('abcdefghijklmnopqrstuvwxyz0123456789'),
  ...Array.from('ABCXYZ'),
  '-',
  '.',
  '.',
  '.',
  '*',
  ':',
  '/',
  '_',
  ' ',
  '\t',
  '@',
  '[',
  ']',
  'ü',
  'İ',
  '\u0000',
  '‮',
  'x',
  'n',
];

function randomString(next: () => number, maxLength: number): string {
  const length = Math.floor(next() * (maxLength + 1));
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? 'a';
  }
  return out;
}

function randomValidHostname(next: () => number): string {
  const labels: string[] = [];
  const count = 2 + Math.floor(next() * 3);
  for (let i = 0; i < count; i += 1) {
    const length = 1 + Math.floor(next() * 12);
    let part = '';
    for (let j = 0; j < length; j += 1) {
      const pool = j === 0 || j === length - 1 ? 'abcdefghijklmnopqrstuvwxyz0123456789' : 'abc-019';
      part += pool[Math.floor(next() * pool.length)] ?? 'a';
    }
    labels.push(part.includes('--') ? part.replaceAll('-', 'a') : part);
  }
  labels.push(['com', 'io', 'dev', 'test', 'xn--p1ai'][Math.floor(next() * 5)] ?? 'com');
  return labels.join('.');
}

describe('validateHostname properties (H1)', () => {
  const SEED = 0x5eed_2102;

  it('never throws on random strings and every outcome is ok or a named error', () => {
    const next = mulberry32(SEED);
    for (let i = 0; i < 5000; i += 1) {
      const input = randomString(next, i % 10 === 0 ? 300 : 40);
      let result: ReturnType<typeof validateHostname> | undefined;
      expect(
        () => {
          result = validateHostname(input);
        },
        `seed ${SEED.toString()} run ${i.toString()}: ${JSON.stringify(input)}`,
      ).not.toThrow();
      if (result !== undefined && !result.ok) {
        expect(HOSTNAME_ERROR_CODES).toContain(result.code);
      }
    }
  });

  it('normalising then validating is idempotent for valid hostnames', () => {
    const next = mulberry32(SEED + 1);
    for (let i = 0; i < 2000; i += 1) {
      const hostname = randomValidHostname(next);
      const first = validateHostname(normaliseHostname(hostname));
      expect(first, hostname).toEqual({ ok: true, value: hostname });
      if (!first.ok) continue;
      expect(validateHostname(normaliseHostname(first.value))).toEqual(first);
      const noisy = ` ${hostname.toUpperCase()}. `;
      expect(validateHostname(normaliseHostname(noisy))).toEqual(first);
    }
  });

  it('normaliseHostname is idempotent on random strings', () => {
    const next = mulberry32(SEED + 2);
    for (let i = 0; i < 3000; i += 1) {
      const once = normaliseHostname(randomString(next, 40));
      expect(normaliseHostname(once)).toBe(once);
    }
  });

  it('accepted hostnames are always lowercase LDH within the length bounds', () => {
    const next = mulberry32(SEED + 3);
    for (let i = 0; i < 5000; i += 1) {
      const result = validateHostname(normaliseHostname(randomString(next, 40)));
      if (!result.ok) continue;
      expect(result.value).toMatch(/^[a-z0-9.-]+$/);
      expect(result.value.length).toBeLessThanOrEqual(MAX_HOSTNAME_LENGTH);
      expect(result.value.split('.').length).toBeGreaterThan(1);
    }
  });
});

describe('MAX_DOMAINS_PER_SERVICE and isReservedHostname (A4)', () => {
  it('caps a service at 10 domains', () => {
    expect(MAX_DOMAINS_PER_SERVICE).toBe(10);
  });

  it('reserves exactly the panel host, compared after normalisation', () => {
    expect(isReservedHostname('panel.example.com', 'panel.example.com')).toBe(true);
    expect(isReservedHostname('panel.example.com', 'PANEL.example.com.')).toBe(true);
    expect(isReservedHostname('app.example.com', 'panel.example.com')).toBe(false);
    expect(isReservedHostname('app.panel.example.com', 'panel.example.com')).toBe(false);
  });

  it('reserves nothing when the panel has no host or is served on an IP', () => {
    expect(isReservedHostname('panel.example.com', null)).toBe(false);
    expect(isReservedHostname('panel.example.com', undefined)).toBe(false);
    expect(isReservedHostname('panel.example.com', '')).toBe(false);
    expect(isReservedHostname('panel.example.com', '203.0.113.10')).toBe(false);
  });
});
