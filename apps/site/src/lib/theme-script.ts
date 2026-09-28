// 10-02-PLAN.md Task 1 (D-15, T-10-11). The no-flash theme bootstrap for the public site --
// modelled on apps/web/src/lib/theme-script.ts's IIFE shape, trimmed to this app's simpler
// reality: `apps/site` is a static export with no server (D-13), so there is no
// `noodara-prefs` mirror cookie and no SSR-set `data-theme` to defer to. This script is the ONLY
// thing that ever sets `data-theme` before hydration.
//
// Exported as a string constant (not inline JSX) so it stays lint-visible and testable, and so
// `apps/site/src/app/layout.tsx`'s single deliberate `dangerouslySetInnerHTML` occurrence
// (T-10-11, scripts/check-ui-safety.mjs's per-file allowlist gate) injects a compile-time
// constant with zero interpolated input -- never a template literal built from a request-scoped
// or user-controlled value. There is no server-side-preference cookie branch at all here (unlike
// apps/web): this site has no concept of a cookie mirror.
//
// The storage key literal is spelled out again below rather than imported from site-theme.ts's
// SITE_THEME_STORAGE_KEY export, deliberately: this script runs before any JS bundle (this
// module included) is even parsed, so it cannot import from here -- see site-theme.ts's own
// header for the "single writer after first paint" half of this split (theme-script.test.ts's
// own assertion pins this file's literal to that export's value).
//
// The whole body stays wrapped in a try/catch so a privacy-mode `localStorage`/`matchMedia`
// throw (Safari private browsing, some extensions) can never block rendering -- the page still
// paints, just without a persisted preference for this load.
export const SITE_THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    var stored = localStorage.getItem('noodara-site-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    root.style.colorScheme = theme;
  } catch (e) {
    // Privacy-mode/blocked localStorage or matchMedia must never block rendering.
  }
})();`;
