import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { THEME_BOOTSTRAP_SCRIPT } from '../lib/theme-script';
import './globals.css';

// 07-09-PLAN.md Task 2 (BRAND-02, D-12): `metadataBase` is derived from `NOODARA_PUBLIC_URL`
// (already this app's own public origin, docs/adr/0006) with an explicit branch rather than a
// `??`/`||` literal fallback -- this repo's eslint config bans that pattern outright
// (PITFALLS.md #1) -- and omitted entirely when unset, matching apps/control-plane/src/env.ts's
// own fail-explicit-not-silent posture. No `icons` key here: the file-convention icons
// (favicon.ico, icon.svg, icon1.png, icon2.png, apple-icon.png, opengraph-image.png) are picked up
// automatically by Next.js from this same `app/` directory.
const publicUrl = process.env.NOODARA_PUBLIC_URL;

export const metadata: Metadata = {
  title: 'Noodara',
  description: 'Your infrastructure, understood.',
  openGraph: {
    title: 'Noodara',
    description: 'Your infrastructure, understood.',
    siteName: 'Noodara',
    type: 'website',
  },
  ...(publicUrl !== undefined && publicUrl.length > 0 ? { metadataBase: new URL(publicUrl) } : {}),
};

// D-10/UI-01: the authenticated shell (sidebar, toolbar) is a route-group layout a later plan
// (05-12) adds -- /setup and /login deliberately render outside it, and this root layout stays a
// bare document shell with no chrome of its own.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * T-5-29 (05-07-PLAN.md threat register): the single, deliberate, reviewed
         * `dangerouslySetInnerHTML` occurrence in this codebase. THEME_BOOTSTRAP_SCRIPT is a
         * module-level string constant with zero interpolated input -- never built from a
         * request-scoped, user-controlled, or per-render value -- so there is no injection surface
         * here. It must run before hydration and before any stylesheet paints (05-UI-SPEC.md's
         * no-flash requirement), which is why it is the first child of <head> as a plain <script>
         * rather than a React effect: an effect only runs after first paint, which is exactly the
         * flash this exists to prevent.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
