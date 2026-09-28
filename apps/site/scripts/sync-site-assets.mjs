#!/usr/bin/env node
// 10-02-PLAN.md Task 2 (D-14 self-hosted OG image, D-16 brand SVG only, D-17 only approved
// captures, copied at build, never new unapproved captures; T-10-13): keeps apps/site's
// favicon/apple-touch-icon/OG-image family in sync with packages/ui/brand/* (07-06's generated,
// byte-locked source of truth), and its five-screen/two-theme screenshot set in sync with
// docs/ui/approved/* (the Phase 8 human-approved set, D-17 "la captura tal cual") -- never a
// one-off manual `cp`. Modelled on apps/web/scripts/sync-brand-assets.mjs's own allowlist/byte-
// compare/never-delete discipline, extended for nested dest/src relative paths (this script's
// destinations span both `src/app/` and `public/screenshots/`, not one flat directory).
//
// WHY THIS RUNS ON EVERY `dev`/`build`. Next.js's file-based icon convention needs the actual
// bytes physically present under `apps/site/src/app/`, and the landing's screenshots need to be
// real files under `apps/site/public/` for `<picture>`/`<img>` to serve at build/export time --
// there is no workspace-import escape hatch for either. Invoked as
// `node scripts/sync-site-assets.mjs && next dev|build` (apps/site/package.json) so drift is
// structurally impossible.
//
// ALLOWLIST, NEVER A GLOB. SITE_ASSET_FILES names every dest file this script may ever write --
// exactly 16 keys (4 brand files + 6 screens x 2 themes) -- so a stray or renamed file under
// packages/ui/brand/ or docs/ui/approved/ can never land somewhere new under apps/site unnoticed,
// and a renamed/removed approved capture fails the build loudly instead of silently vanishing
// from the shipped site. This script never removes a file: a foreign file already present in a
// destination directory is left untouched, by design -- sync is additive/idempotent only, never
// destructive.
//
// 10-12-PLAN.md Round 1 (D-02a): "setup" now ships too -- the ProductTour's six tabs
// (setup/login/servers/server-detail/activity/settings) need all six approved captures. Order
// here follows site-facts.ts's own APPROVED_SCREENS order.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCREENS = ['setup', 'login', 'servers', 'server-detail', 'activity', 'settings'];
const THEMES = ['light', 'dark'];

/** dest (relative to apps/site) -> src (relative to repo root). Frozen so a caller can never
 *  mutate the allowlist at runtime. */
export const SITE_ASSET_FILES = Object.freeze({
  'src/app/favicon.ico': 'packages/ui/brand/favicon.ico',
  'src/app/icon.svg': 'packages/ui/brand/favicon.svg',
  'src/app/apple-icon.png': 'packages/ui/brand/apple-touch-icon.png',
  'src/app/opengraph-image.png': 'packages/ui/brand/og-image.png',
  ...Object.fromEntries(
    SCREENS.flatMap((screen) =>
      THEMES.map((theme) => [
        `public/screenshots/${screen}-${theme}.png`,
        `docs/ui/approved/${screen}-${theme}.png`,
      ]),
    ),
  ),
});

/**
 * Copies every SITE_ASSET_FILES entry from `repoRoot` into `siteRoot`, comparing bytes first so
 * an unchanged file is never rewritten (idempotent). Never deletes, never writes a path outside
 * the allowlist. A missing source throws immediately, naming the missing path -- this never
 * silently skips, so a renamed approved capture or brand file fails the build instead of
 * shipping a stale/broken image.
 *
 * @param {{ repoRoot: string, siteRoot: string }} options
 * @returns {{ written: string[], unchanged: string[] }}
 */
export function syncSiteAssets({ repoRoot, siteRoot }) {
  const written = [];
  const unchanged = [];

  for (const [destRel, srcRel] of Object.entries(SITE_ASSET_FILES)) {
    const srcPath = path.join(repoRoot, srcRel);
    let srcBytes;
    try {
      srcBytes = readFileSync(srcPath);
    } catch {
      throw new Error(
        `syncSiteAssets: source "${srcPath}" is missing -- a renamed or removed approved capture ` +
          '/ brand asset must fail the build, never be silently skipped (T-10-13).',
      );
    }

    const destPath = path.join(siteRoot, destRel);
    let destBytes;
    try {
      destBytes = readFileSync(destPath);
    } catch {
      destBytes = undefined;
    }

    if (destBytes !== undefined && destBytes.equals(srcBytes)) {
      unchanged.push(destRel);
      continue;
    }

    mkdirSync(path.dirname(destPath), { recursive: true });
    writeFileSync(destPath, srcBytes);
    written.push(destRel);
  }

  return { written, unchanged };
}

// Guards the CLI entrypoint so this module can be imported by
// tests/unit/site/sync-site-assets.test.ts with zero filesystem side effects -- only running this
// file directly (or via the `dev`/`build` package.json scripts, which do the same) syncs the real
// repo -> apps/site pair. Matches apps/web/scripts/sync-brand-assets.mjs's own `isMainModule`
// guard pattern.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const siteRoot = path.join(import.meta.dirname, '..');
  const repoRoot = path.join(siteRoot, '../..');
  const { written, unchanged } = syncSiteAssets({ repoRoot, siteRoot });
  if (written.length === 0) {
    console.log('sync-site-assets: no files changed (fully idempotent run).');
  } else {
    console.log(`sync-site-assets: ${String(written.length)} file(s) changed:`);
    for (const name of written) console.log(`  ${name}`);
  }
  if (unchanged.length > 0) {
    console.log(`sync-site-assets: ${String(unchanged.length)} file(s) already up to date.`);
  }
}
