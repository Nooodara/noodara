// @vitest-environment jsdom
// 10-02-PLAN.md Task 1 behavior spec: SITE_THEME_BOOTSTRAP_SCRIPT's own shape and runtime effect
// (T-10-11). Not named in the plan's file list explicitly, but the plan's <behavior> section
// spells out five separate assertions about this exact constant -- Rule 2 (missing critical test
// coverage for a security-relevant, already-specified behavior) adds this file rather than
// stuffing an unrelated import into site-theme.test.ts.

import { describe, expect, it } from 'vitest';
import { SITE_THEME_BOOTSTRAP_SCRIPT } from './theme-script';
import { SITE_THEME_STORAGE_KEY } from './site-theme';

describe('SITE_THEME_BOOTSTRAP_SCRIPT', () => {
  it('contains the literal value of SITE_THEME_STORAGE_KEY', () => {
    expect(SITE_THEME_BOOTSTRAP_SCRIPT).toContain(SITE_THEME_STORAGE_KEY);
  });

  it('contains classList and prefers-color-scheme', () => {
    expect(SITE_THEME_BOOTSTRAP_SCRIPT).toContain('classList');
    expect(SITE_THEME_BOOTSTRAP_SCRIPT).toContain('prefers-color-scheme');
  });

  it('contains no document.cookie', () => {
    expect(SITE_THEME_BOOTSTRAP_SCRIPT).not.toContain('document.cookie');
  });

  it('contains no ${ (never a template literal built from an interpolated value)', () => {
    expect(SITE_THEME_BOOTSTRAP_SCRIPT).not.toContain('${');
  });

  it('evaluated with new Function (stored "dark") leaves html with data-theme="dark" and class "dark"', () => {
    localStorage.setItem(SITE_THEME_STORAGE_KEY, 'dark');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');

    // `new Function` evaluates the constant against the real jsdom globals exactly like a real
    // <script> tag would in a browser -- the deliberate, reviewed exception here (apps/web/src/lib
    // /theme-script.test.tsx's own precedent).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    new Function(SITE_THEME_BOOTSTRAP_SCRIPT)();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');
  });
});
