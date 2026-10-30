import { describe, expect, it } from 'vitest';
import {
  InvalidProxyStatusTransitionError,
  PROXY_ERROR_CODES,
  PROXY_ERROR_MESSAGES,
  PROXY_STATUSES,
  type ProxyStatus,
  canTransitionProxyStatus,
  initialProxyStatus,
  transitionProxyStatus,
} from './proxy-status.js';

const ALLOWED: ReadonlySet<string> = new Set([
  'NOT_INSTALLED->INSTALLING',
  'INSTALLING->RUNNING',
  'INSTALLING->FAILED',
  'RUNNING->INSTALLING',
  'RUNNING->FAILED',
  'RUNNING->NOT_INSTALLED',
  'FAILED->INSTALLING',
  'FAILED->RUNNING',
  'FAILED->NOT_INSTALLED',
]);

const PAIRS: readonly (readonly [ProxyStatus, ProxyStatus])[] = PROXY_STATUSES.flatMap((from) =>
  PROXY_STATUSES.map((to) => [from, to] as const),
);

describe('PROXY_STATUSES', () => {
  it('is the closed, ordered vocabulary (the pg enum is derived from it)', () => {
    expect([...PROXY_STATUSES]).toEqual(['NOT_INSTALLED', 'INSTALLING', 'RUNNING', 'FAILED']);
    expect(Object.isFrozen(PROXY_STATUSES)).toBe(true);
  });

  it('starts at NOT_INSTALLED', () => {
    expect(initialProxyStatus()).toBe('NOT_INSTALLED');
  });
});

describe('proxy status transitions', () => {
  it('covers all 16 ordered pairs', () => {
    expect(PAIRS).toHaveLength(16);
  });

  it.each(PAIRS)('%s -> %s follows the table', (from, to) => {
    const allowed = ALLOWED.has(`${from}->${to}`);
    expect(canTransitionProxyStatus(from, to)).toBe(allowed);
    if (allowed) {
      expect(transitionProxyStatus(from, to)).toBe(to);
    } else {
      expect(() => transitionProxyStatus(from, to)).toThrow(InvalidProxyStatusTransitionError);
    }
  });

  it('the error carries both ends and a fixed message', () => {
    try {
      transitionProxyStatus('NOT_INSTALLED', 'RUNNING');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProxyStatusTransitionError);
      const typed = error as InvalidProxyStatusTransitionError;
      expect(typed.from).toBe('NOT_INSTALLED');
      expect(typed.to).toBe('RUNNING');
      expect(typed.name).toBe('InvalidProxyStatusTransitionError');
      expect(typed.message).toBe('Invalid proxy status transition: NOT_INSTALLED -> RUNNING');
    }
  });
});

describe('proxy error codes', () => {
  it('is the closed vocabulary', () => {
    expect([...PROXY_ERROR_CODES]).toEqual([
      'PROXY_PORT_IN_USE',
      'PROXY_INSTALL_FAILED',
      'PROXY_UNAVAILABLE',
      'PROXY_IN_USE',
      'PROXY_ROUTE_FAILED',
    ]);
    expect(Object.isFrozen(PROXY_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(PROXY_ERROR_MESSAGES)).toBe(true);
    expect(Object.keys(PROXY_ERROR_MESSAGES).sort()).toEqual([...PROXY_ERROR_CODES].sort());
  });

  it.each(PROXY_ERROR_CODES)('%s has a fixed actionable message without remote detail', (code) => {
    const message = PROXY_ERROR_MESSAGES[code];
    expect(message).toMatch(/^[A-Z].+\. .+\.$/);
    expect(message).toMatch(/\b(Check|Free|Remove|Install|install|try)\b/);
    expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+|\/|exit \d+|[A-Z]{2,}_[A-Z]+/);
    expect(message.length).toBeLessThanOrEqual(180);
  });

  it('messages are distinct', () => {
    const messages = Object.values(PROXY_ERROR_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
