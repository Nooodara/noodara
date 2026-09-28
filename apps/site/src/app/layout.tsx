import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { SiteSearchDialog } from '../components/SiteSearchDialog';
import { readBuildInfo } from '../lib/build-info';
import { SITE_THEME_BOOTSTRAP_SCRIPT } from '../lib/theme-script';
import './global.css';

// 10-02-PLAN.md Task 3 (D-11/D-12a, SITE-03). `metadataBase` is `readBuildInfo().origin` --
// always `https://noodara.com` (Cloudflare Pages always serves this export at the root, quick-
// 260928-gmm) -- read once at build time, never hand-typed (matches
// apps/site/next.config.mjs's own SITE_ORIGIN/site-config.mjs discipline). No `icons` key: the
// file-convention icons (favicon.ico, icon.svg, apple-icon.png, opengraph-image.png) are synced
// into this same `app/` directory by scripts/sync-site-assets.mjs before every dev/build run and
// picked up automatically by Next.js.
const { origin } = readBuildInfo();

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: {
    default: 'Noodara — Your infrastructure, understood.',
    template: '%s — Noodara',
  },
  description:
    'Connect a server over SSH, watch Noodara discover it, and see exactly what is running -- no agent, no black box.',
  openGraph: {
    siteName: 'Noodara',
    type: 'website',
  },
  alternates: {
    canonical: '/',
  },
};

// Not async, and reads no request-scoped API at all: unlike apps/web's own root layout, this is a
// static export with no server (D-13). SITE_THEME_BOOTSTRAP_SCRIPT (the
// first child of <head>, as a plain <script>, not a React effect -- an effect only runs after
// first paint, which is exactly the flash this exists to prevent) is the only thing that ever
// sets `data-theme`/the `dark` class before hydration.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * T-10-11 (10-02-PLAN.md threat register): the single, deliberate, reviewed inline-script
         * injection in apps/site (scripts/check-ui-safety.mjs's per-file allowlist gate: exactly
         * one per app root layout). SITE_THEME_BOOTSTRAP_SCRIPT is a module-level string constant
         * with zero interpolated input -- never built from a request-scoped, user-controlled, or
         * per-render value -- so there is no injection surface here.
         */}
        <script dangerouslySetInnerHTML={{ __html: SITE_THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        {/* theme.enabled: false -- this site has its own SiteThemeToggle/bootstrap script
            (D-15), not next-themes' own cookie-less client-only toggle. search.SearchDialog --
            10-05-PLAN.md: the static Fumadocs search dialog over the flexsearch index this app's
            own /api/search route bakes into the export at build time. */}
        <RootProvider theme={{ enabled: false }} search={{ SearchDialog: SiteSearchDialog }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
