// Writes (or verifies) every static brand asset (07-06-PLAN.md Task 2, D-10, D-11, D-12).
//
// `pnpm brand:generate` is the ONLY legitimate way `packages/ui/brand/*` is ever written (D-10) --
// re-run it after any geometry change (a D-16 adjustment round, a future concept swap); never
// hand-edit a file under `packages/ui/brand/`. Every byte comes from `asset-manifest.ts`'s pure
// functions, which themselves render `packages/ui/src/brand/static-svg.ts`'s output (07-03) --
// nothing here draws.
//
// PNG/ICO BYTES ARE NOT PORTABLE ACROSS MACHINES. A `sharp`/libvips upgrade can change compression
// output byte-for-byte while rendering the identical pixels, so `--check` (and the Task 3
// exactness test) compare PNG/ICO assets by decoded dimensions and alpha, never by raw bytes --
// only the `.svg`/`.json` text assets are diffed byte-for-byte, because `renderToStaticMarkup` and
// `JSON.stringify` are deterministic in this repo's own toolchain (see `geometry.ts`'s `fmt`).
//
// `pnpm brand:check` is what CI runs (07-10): read-only, exits 1 with a named list of every
// drifting file, never writes anything. This script never regenerates on `next build` or any other
// build-time hook (07-RESEARCH.md's Anti-Patterns section) -- assets are committed, reviewed and
// approved (D-17) like any other source file.
//
// Only the 13 names in `ASSET_FILES` are ever written under `BRAND_DIR`, and this script never
// deletes a file (T-07-17) -- `writeIfChanged` (07-02) has no delete API to begin with.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONCEPT } from '../../packages/ui/src/brand/geometry.js';
import {
  BRAND_DIR,
  buildTextAssets,
  rasterSpecs,
  readBrandTokens,
  type RasterSpec,
} from './asset-manifest.js';
import { pngMetadata, pngsToIco, svgToPng } from './raster.js';
import { changedFiles, writeIfChanged } from './write-if-changed.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const TOKENS_CSS_PATH = path.join(REPO_ROOT, 'packages', 'ui', 'tokens.css');
const FAVICON_ICO_PATH = path.join(BRAND_DIR, 'favicon.ico');

const CHECK_MODE = process.argv.includes('--check');

/** Rasterizes one spec at its own declared size, flattening onto `spec.background` when set. */
async function rasterize(spec: RasterSpec): Promise<Buffer> {
  return svgToPng(
    spec.svg,
    { width: spec.width, height: spec.height },
    spec.background === undefined ? undefined : { background: spec.background },
  );
}

/** The four raster specs written directly as their own file (everything except the three favicon
 *  tile sizes, which only ever end up packed inside `favicon.ico`). */
function directRasterSpecs(specs: readonly RasterSpec[]): readonly RasterSpec[] {
  return specs.filter((spec) => spec.packInto === undefined);
}

function faviconTileSpecs(specs: readonly RasterSpec[]): readonly RasterSpec[] {
  return specs.filter((spec) => spec.packInto === 'favicon.ico');
}

async function generate(): Promise<void> {
  const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const tokens = readBrandTokens(tokensCss);

  for (const [name, content] of buildTextAssets(tokens, DEFAULT_CONCEPT)) {
    writeIfChanged(path.join(BRAND_DIR, name), content);
  }

  const specs = rasterSpecs(tokens, DEFAULT_CONCEPT);

  for (const spec of directRasterSpecs(specs)) {
    const png = await rasterize(spec);
    writeIfChanged(path.join(BRAND_DIR, spec.filename), png);
  }

  const tilePngs = await Promise.all(faviconTileSpecs(specs).map((spec) => rasterize(spec)));
  const ico = await pngsToIco(tilePngs);
  writeIfChanged(FAVICON_ICO_PATH, ico);

  if (changedFiles.length === 0) {
    console.log('generate-brand-assets: no files changed (fully idempotent run).');
    return;
  }
  console.log(`generate-brand-assets: ${String(changedFiles.length)} file(s) changed:`);
  for (const file of changedFiles) {
    console.log(`  ${file}`);
  }
}

interface Drift {
  readonly filename: string;
  readonly reason: string;
}

function readTextOrUndefined(absPath: string): string | undefined {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

function readBufferOrUndefined(absPath: string): Buffer | undefined {
  try {
    return readFileSync(absPath);
  } catch {
    return undefined;
  }
}

async function check(): Promise<void> {
  const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const tokens = readBrandTokens(tokensCss);
  const drift: Drift[] = [];

  for (const [name, expected] of buildTextAssets(tokens, DEFAULT_CONCEPT)) {
    const actual = readTextOrUndefined(path.join(BRAND_DIR, name));
    if (actual === undefined) {
      drift.push({ filename: name, reason: 'missing on disk' });
    } else if (actual !== expected) {
      drift.push({ filename: name, reason: 'content differs from asset-manifest.ts' });
    }
  }

  const specs = rasterSpecs(tokens, DEFAULT_CONCEPT);
  for (const spec of directRasterSpecs(specs)) {
    const actual = readBufferOrUndefined(path.join(BRAND_DIR, spec.filename));
    if (actual === undefined) {
      drift.push({ filename: spec.filename, reason: 'missing on disk' });
      continue;
    }
    const meta = await pngMetadata(actual);
    const expectOpaque = spec.background !== undefined;
    if (meta.width !== spec.width || meta.height !== spec.height) {
      drift.push({
        filename: spec.filename,
        reason: `expected ${String(spec.width)}x${String(spec.height)}, found ${String(meta.width)}x${String(meta.height)}`,
      });
    } else if (expectOpaque && meta.hasAlpha) {
      drift.push({ filename: spec.filename, reason: 'expected an opaque (no-alpha) PNG' });
    }
  }

  const icoBuffer = readBufferOrUndefined(FAVICON_ICO_PATH);
  const expectedTileCount = faviconTileSpecs(specs).length;
  if (icoBuffer === undefined) {
    drift.push({ filename: 'favicon.ico', reason: 'missing on disk' });
  } else {
    const header = icoBuffer.subarray(0, 4);
    const expectedHeader = Buffer.from([0x00, 0x00, 0x01, 0x00]);
    const entryCount = icoBuffer.readUInt16LE(4);
    if (!header.equals(expectedHeader) || entryCount !== expectedTileCount) {
      drift.push({ filename: 'favicon.ico', reason: 'ICO header or entry count mismatch' });
    }
  }

  if (drift.length === 0) {
    console.log('generate-brand-assets --check: OK, no drift.');
    return;
  }
  console.error('generate-brand-assets --check: drift detected:');
  for (const item of drift) {
    console.error(`  ${item.filename}: ${item.reason}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  if (CHECK_MODE) {
    await check();
  } else {
    await generate();
  }
}

main().catch((err: unknown) => {
  console.error('generate-brand-assets: FATAL', err);
  process.exit(1);
});
