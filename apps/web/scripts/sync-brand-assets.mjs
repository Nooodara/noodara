#!/usr/bin/env node
// 07-09-PLAN.md Task 1 (BRAND-02, D-11, D-12, RESEARCH.md Common Pitfalls #3): keeps
// `apps/web/src/app`'s favicon/apple-touch-icon/PWA-icon/OG-image/manifest-colours family in sync
// with `packages/ui/brand/*` (07-06's generated, byte-locked source of truth) — never a one-off
// manual `cp`.
//
// WHY THIS RUNS ON EVERY `dev`/`build`. Next.js's file-based icon convention
// (`app/favicon.ico`, `app/icon.svg`, `app/icon1.png`, `app/icon2.png`, `app/apple-icon.png`,
// `app/opengraph-image.png`) requires the actual bytes to be physically present under
// `apps/web/src/app/` — there is no workspace-import escape hatch for these exact reserved
// filenames (confirmed via Context7 against /vercel/next.js). A brand-kit adjustment round
// (D-16) regenerates `packages/ui/brand/*` correctly, but a hand-copied `apps/web` file would
// silently keep serving the previous draft forever. This script is invoked as
// `node scripts/sync-brand-assets.mjs && next dev|build` (`apps/web/package.json`) so drift is
// structurally impossible: every dev run and every build re-syncs before Next.js ever starts.
//
// `apps/web/public/` IS INTENTIONALLY NOT USED. `apps/web/Dockerfile`'s runner stage has no
// `public/` copy step by design (06-RESEARCH.md Pattern 10) — do not "fix" that by adding one.
// The two PWA icon sizes therefore use Next's numbered file convention (`app/icon1.png` = 192,
// `app/icon2.png` = 512) instead of `public/icon-192.png`/`public/icon-512.png`.
//
// ALLOWLIST, NEVER A GLOB. `BRAND_SYNC_FILES` names every dest file this script may ever write —
// copying is scoped to exactly those 7 keys, so a stray or renamed file under `packages/ui/brand/`
// can never land somewhere new under `apps/web/src/app/` unnoticed (T-07-25). This script never
// calls `unlink`/`rm`/`rmSync`: a foreign file already present in the destination directory is
// left untouched, by design — sync is additive/idempotent only, never destructive.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** dest (relative to apps/web/src/app) -> src (relative to packages/ui/brand). Frozen so a caller
 *  can never mutate the allowlist at runtime. */
export const BRAND_SYNC_FILES = Object.freeze({
  'favicon.ico': 'favicon.ico',
  'icon.svg': 'favicon.svg',
  'icon1.png': 'icon-192.png',
  'icon2.png': 'icon-512.png',
  'apple-icon.png': 'apple-touch-icon.png',
  'opengraph-image.png': 'og-image.png',
  'brand-colors.json': 'brand-colors.json',
});

/**
 * Copies every `BRAND_SYNC_FILES` entry from `srcDir` into `destDir`, comparing bytes first so an
 * unchanged file is never rewritten (idempotent — mirrors `scripts/capture-discovery-fixtures.mjs`'s
 * own `writeIfChanged` discipline). Never deletes, never writes a name outside the allowlist.
 *
 * @param {{ srcDir: string, destDir: string }} options
 * @returns {{ written: string[], unchanged: string[] }}
 */
export function syncBrandAssets({ srcDir, destDir }) {
  const written = [];
  const unchanged = [];

  for (const [destName, srcName] of Object.entries(BRAND_SYNC_FILES)) {
    const srcPath = path.join(srcDir, srcName);
    let srcBytes;
    try {
      srcBytes = readFileSync(srcPath);
    } catch {
      throw new Error(
        `syncBrandAssets: source "${srcPath}" is missing — run \`pnpm brand:generate\` first ` +
          '(packages/ui/brand/* must exist before apps/web can sync its icons from it).',
      );
    }

    const destPath = path.join(destDir, destName);
    let destBytes;
    try {
      destBytes = readFileSync(destPath);
    } catch {
      destBytes = undefined;
    }

    if (destBytes !== undefined && destBytes.equals(srcBytes)) {
      unchanged.push(destName);
      continue;
    }

    writeFileSync(destPath, srcBytes);
    written.push(destName);
  }

  return { written, unchanged };
}

// Guards the CLI entrypoint so this module can be imported by
// tests/unit/brand/sync-brand-assets.test.ts with zero filesystem side effects — only running
// this file directly (or via the `dev`/`build` package.json scripts, which do the same) syncs the
// real packages/ui/brand -> apps/web/src/app pair. Matches
// scripts/check-package-provenance.mjs's own `isMainModule` guard pattern.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const srcDir = path.join(import.meta.dirname, '../../../packages/ui/brand');
  const destDir = path.join(import.meta.dirname, '../src/app');
  const { written, unchanged } = syncBrandAssets({ srcDir, destDir });
  if (written.length === 0) {
    console.log('sync-brand-assets: no files changed (fully idempotent run).');
  } else {
    console.log(`sync-brand-assets: ${String(written.length)} file(s) changed:`);
    for (const name of written) console.log(`  ${name}`);
  }
  if (unchanged.length > 0) {
    console.log(`sync-brand-assets: ${String(unchanged.length)} file(s) already up to date.`);
  }
}
