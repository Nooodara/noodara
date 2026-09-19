import { describe, expect, it } from 'vitest';
import { cn } from './cn.js';

// A function boundary with a declared `boolean` return type, not the literal `false` this file
// passes it -- so ESLint's no-unnecessary-condition/no-constant-binary-expression rules see a
// genuinely widened `boolean` at the `&&` call site below and don't flag it as
// statically-known-falsy. The runtime behaviour under test is identical either way.
function widen(value: boolean): boolean {
  return value;
}

describe('cn', () => {
  it('drops false, null and undefined', () => {
    expect(cn('a', widen(false) && 'b', undefined, 'c')).toBe('a c');
  });

  it('drops an explicit null', () => {
    expect(cn('a', null, 'b')).toBe('a b');
  });

  it('returns an empty string with no arguments', () => {
    expect(cn()).toBe('');
  });

  it('trims and collapses duplicate whitespace', () => {
    expect(cn('  a  ', '  b   c ')).toBe('a b c');
  });
});
