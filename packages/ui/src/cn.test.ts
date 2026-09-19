import { describe, expect, it } from 'vitest';
import { cn } from './cn.js';

describe('cn', () => {
  it('drops false, null and undefined', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c');
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
