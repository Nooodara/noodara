// 05-UI-SPEC.md "Theme switching": the no-flash theme bootstrap. This is the deliberate hand-rolled
// equivalent of `next-themes`' internal blocking script -- declined as a dependency for ~15 lines
// of code (05-UI-SPEC.md's own reasoning). Exported as a string constant (not inline JSX) so it
// stays lint-visible and testable, and so `apps/web/src/app/layout.tsx`'s single deliberate
// `dangerouslySetInnerHTML` occurrence (T-5-29) injects a compile-time constant with zero
// interpolated input -- never a template literal built from a request-scoped or user-controlled
// value.
//
// Behaviour: read `localStorage.getItem('noodara-theme')`; if it is 'light' or 'dark', use that;
// otherwise fall back to `matchMedia('(prefers-color-scheme: dark)')`. The whole body is wrapped in
// a try/catch so a privacy-mode `localStorage` throw (Safari private browsing, some extensions)
// cannot block rendering -- the page still paints, just without a persisted preference for this
// load. `ThemeToggle` (packages/ui, a later plan) is the only component that ever writes
// `localStorage`/`data-theme` after this initial load.
export const THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    var stored = localStorage.getItem('noodara-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    // Privacy-mode/blocked localStorage must never block rendering.
  }
})();`;
