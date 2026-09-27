// 05-UI-SPEC.md "Theme switching": the no-flash theme bootstrap. This is the deliberate hand-rolled
// equivalent of `next-themes`' internal blocking script -- declined as a dependency for ~15 lines
// of code (05-UI-SPEC.md's own reasoning). Exported as a string constant (not inline JSX) so it
// stays lint-visible and testable, and so `apps/web/src/app/layout.tsx`'s single deliberate
// `dangerouslySetInnerHTML` occurrence (T-5-29, T-09-24) injects a compile-time constant with zero
// interpolated input -- never a template literal built from a request-scoped or user-controlled
// value.
//
// 09-07-PLAN.md Task 2 (D-09, D-11): narrowed division of labour now that the root layout
// (layout.tsx) itself sets data-theme/data-motion/data-density from the `noodara-prefs` SSR cookie
// for an explicit light/dark preference. This script only ever has work left in two cases:
//
//   1. `data-theme` is already present -- the SSR layout resolved an explicit preference; do
//      nothing, so this script can never clobber a correct server-rendered value.
//   2. `data-theme` is absent -- either no `noodara-prefs` cookie exists at all (first visit),
//      or the cookie exists but says `theme: 'auto'` (preferencesToRootAttributes deliberately
//      omits `data-theme` for 'auto', D-09). A present-but-auto cookie means the SSR read the
//      preference and already decided "resolve via OS", so this script goes straight to
//      `matchMedia` and does not fall back to the legacy `noodara-theme` localStorage cache --
//      only a cookie-less visit (this app existed before the cookie mirror, or a user who cleared
//      cookies but kept localStorage) still reads that cache first.
//
// The whole body stays wrapped in a try/catch so a privacy-mode `localStorage`/`document.cookie`
// throw (Safari private browsing, some extensions) can never block rendering -- the page still
// paints, just without a persisted preference for this load. `applyPreferences`
// (packages/ui/src/ThemeToggle.tsx, a later plan) is the only function that ever writes
// `localStorage`/`document.cookie`/the three attributes after this initial load (P17).
export const THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    if (document.documentElement.getAttribute('data-theme')) {
      return;
    }
    var hasPreferencesCookie = document.cookie.indexOf('noodara-prefs=') !== -1;
    var stored = hasPreferencesCookie ? null : localStorage.getItem('noodara-theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    // Privacy-mode/blocked localStorage or document.cookie must never block rendering.
  }
})();`;
