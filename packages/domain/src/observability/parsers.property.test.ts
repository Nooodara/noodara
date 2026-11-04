import { describe, expect, it } from 'vitest';
import { parseContainerSample } from './container-sample.js';
import { parseHostSample } from './host-sample.js';
import { OBSERVABILITY_PARSE_ERRORS } from './output-bounds.js';

// A1 property test without a new dependency: a seeded PRNG (mulberry32) keeps every run
// reproducible, so a failure prints the seed and the input that broke the parser.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  'CPU ', 'cpu ', 'MEM ', 'MemTotal: ', 'MemAvailable: ', ' kB', 'DF ', 'UP ', 'I ', 'S ',
  '{', '}', '[', ']', '"', ':', ',', '\t', '\n', ' ', '/', '%', ' / ', 'MiB', 'GiB', '--',
  '0', '1', '9', '-1', '1e309', 'NaN', 'Infinity', '18446744073709551615', '.', 'null', 'true',
  '"id"', '"status"', '"running"', '"health"', '"healthExitCodes"', '"memoryLimit"', 'é', '\u0000',
];

function randomInput(next: () => number): string {
  const parts: string[] = [];
  const length = Math.floor(next() * 60);
  for (let i = 0; i < length; i += 1) {
    if (next() < 0.7) {
      parts.push(FRAGMENTS[Math.floor(next() * FRAGMENTS.length)] ?? '');
    } else {
      parts.push(String.fromCharCode(Math.floor(next() * 0x2fff)));
    }
  }
  return parts.join('');
}

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}

const SEED = 0x26_02;
const RUNS = 3000;

describe('observability parsers are total over random strings (A1)', () => {
  it.each([
    ['parseHostSample', (s: string) => parseHostSample(s)],
    ['parseContainerSample', (s: string) => parseContainerSample(s)],
  ])('%s never throws, never yields NaN or Infinity, and fails with a named error', (_name, parse) => {
    const next = mulberry32(SEED);
    for (let run = 0; run < RUNS; run += 1) {
      const input = randomInput(next);
      let result: ReturnType<typeof parse>;
      try {
        result = parse(input);
      } catch (error) {
        throw new Error(`seed ${String(SEED)} run ${String(run)} threw on ${JSON.stringify(input)}: ${String(error)}`);
      }
      if (result.ok) {
        expect(numbersIn(result.value).every((n) => Number.isFinite(n)), JSON.stringify(input)).toBe(true);
      } else {
        expect(OBSERVABILITY_PARSE_ERRORS, JSON.stringify(input)).toContain(result.code);
      }
    }
  });

  it('also survives near-valid inputs built from real line prefixes', () => {
    const next = mulberry32(SEED + 1);
    for (let run = 0; run < RUNS; run += 1) {
      const lines = Array.from({ length: 1 + Math.floor(next() * 8) }, () => {
        const prefix = ['CPU cpu ', 'MEM MemTotal: ', 'MEM MemAvailable: ', 'DF / ', 'UP ', 'I ', 'S '][
          Math.floor(next() * 7)
        ];
        return `${prefix ?? ''}${randomInput(next).replaceAll('\n', ' ')}`;
      });
      const input = `${lines.join('\n')}\n`;
      expect(() => parseHostSample(input)).not.toThrow();
      expect(() => parseContainerSample(input)).not.toThrow();
    }
  });
});
