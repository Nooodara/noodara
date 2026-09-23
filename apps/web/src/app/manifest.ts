import type { MetadataRoute } from 'next';
// 07-09-PLAN.md Task 2 (BRAND-02, D-11, D-12, rule 4/T-07-28): the Web App Manifest spec has no
// `var()`/CSS-custom-property concept, so `theme_color`/`background_color` cannot reference a
// design token the way every other surface in this repo does. Reading them from
// `./brand-colors.json` (synced from `packages/ui/brand/brand-colors.json`, itself generated from
// `tokens.css` by 07-06's own script and byte-locked by its own test) instead of writing a hex
// literal here keeps this file free of any colour literal `scripts/check-ui-safety.mjs`'s gate
// would count — the gate scans `.ts`/`.tsx`/`.css` files, and a JSON value is not a colour literal
// in component/config source, which is what that gate protects (T-07-28, accepted).
//
// `apps/web/public/` is intentionally not used (see sync-brand-assets.mjs's header) — the two PWA
// icon sizes are served through Next's numbered file convention (`app/icon1.png`/`icon2.png`)
// rather than `public/icon-192.png`/`public/icon-512.png`, and the `src`s below were verified
// against the actual served `<head>` in 07-09 Task 3's E2E run.
import brandColors from './brand-colors.json' with { type: 'json' };

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Noodara',
    short_name: 'Noodara',
    start_url: '/',
    display: 'standalone',
    theme_color: brandColors.themeColor,
    background_color: brandColors.backgroundColor,
    icons: [
      { src: '/icon1.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon2.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
