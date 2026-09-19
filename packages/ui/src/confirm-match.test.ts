import { describe, expect, it } from 'vitest';
import { isConfirmationMatch } from './confirm-match.js';

describe('isConfirmationMatch', () => {
  it('matches when the typed value is exactly the required name', () => {
    expect(isConfirmationMatch('srv-1', 'srv-1')).toBe(true);
  });

  it('does not match when the typed value has leading whitespace', () => {
    expect(isConfirmationMatch('srv-1', ' srv-1')).toBe(false);
  });

  it('does not match when the typed value has trailing whitespace', () => {
    expect(isConfirmationMatch('srv-1', 'srv-1 ')).toBe(false);
  });

  it('does not match on a case difference', () => {
    expect(isConfirmationMatch('srv-1', 'SRV-1')).toBe(false);
  });

  it('does not match an empty typed value even when the required name is also empty', () => {
    expect(isConfirmationMatch('', '')).toBe(false);
  });

  it('does not match a partial prefix of the required name', () => {
    expect(isConfirmationMatch('srv-1', 'srv')).toBe(false);
  });
});
