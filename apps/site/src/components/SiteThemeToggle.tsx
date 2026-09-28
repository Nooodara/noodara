'use client';

// 10-02-PLAN.md Task 1 (D-15). The site's header theme toggle -- a single icon button, no icon
// library (UI-SPEC "Icon library: None" per docs/ui-build-prompt.md §9): the sun/moon glyphs
// below are hand-drawn inline SVG in `currentColor`, matching the "How it works" diagram's own
// no-third-party-icon rule.
//
// Reads the initial theme from `document.documentElement.dataset.theme` in an effect (not from
// React state seeded at module scope) to avoid a hydration mismatch: the bootstrap script
// (theme-script.ts) already set the real attribute before this component's own hydration, so the
// very first client render must read that value rather than guess 'light' and flip visibly a
// moment later.
//
// Press feedback mirrors packages/ui/src/press.ts's PRESS_CLASSES exactly (motion-safe scale,
// motion-reduce opacity, disabled override) -- reproduced here rather than imported because
// @noodara/ui's package.json `exports` map has no subpath for `./press` (only the barrel and the
// `/testing` entry), so a cross-package import of that internal module is not resolvable from
// apps/site.
import { useEffect, useState } from 'react';
import { applySiteTheme, persistSiteTheme, type SiteTheme } from '../lib/site-theme';

const PRESS_CLASSES =
  'motion-safe:transition-[transform] motion-safe:duration-[160ms] motion-safe:ease-[var(--ease-out)] ' +
  'motion-safe:active:scale-[0.97] motion-reduce:transition-[opacity] motion-reduce:duration-[160ms] ' +
  'motion-reduce:ease-[var(--ease-out)] motion-reduce:active:opacity-80';

const BUTTON_CLASSES =
  `inline-flex h-11 w-11 items-center justify-center rounded-sm text-ink-secondary ` +
  `transition-[opacity] duration-[var(--duration-micro)] ease-[var(--ease-standard)] hover:bg-surface-2 ${PRESS_CLASSES}`;

function SunIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 1.5v2M10 16.5v2M18.5 10h-2M3.5 10h-2M15.6 4.4l-1.4 1.4M5.8 14.2l-1.4 1.4M15.6 15.6l-1.4-1.4M5.8 5.8L4.4 4.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M17 11.6A7.2 7.2 0 1 1 8.4 3a5.8 5.8 0 0 0 8.6 8.6Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SiteThemeToggle() {
  const [theme, setTheme] = useState<SiteTheme>('light');

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);

  function handleClick(): void {
    const next: SiteTheme = theme === 'dark' ? 'light' : 'dark';
    applySiteTheme(next);
    persistSiteTheme(next);
    setTheme(next);
  }

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button type="button" aria-label={label} onClick={handleClick} className={BUTTON_CLASSES}>
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
