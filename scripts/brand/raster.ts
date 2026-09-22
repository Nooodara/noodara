// SVG -> PNG -> ICO rasterization for the brand asset pipeline (07-02-PLAN.md Task 3).
//
// This exists because of D-10/D-11 (07-CONTEXT.md): every static brand export (favicon, apple
// touch icon, PWA icons, OG image) must be generated from the same geometry module that draws the
// in-app `currentColor` components, never hand-drawn a second time. Rasterization is the one
// genuinely new mechanical capability that generation needs, so it is proven here, on a
// placeholder ring, before any real concept goes through this pipeline (07-06).
//
// BUILD-TIME ONLY. Nothing in this module ever runs in the request path -- it is invoked by a
// `tsx`-run generation script (07-06) and by this module's own tests. Its outputs are committed
// to `packages/ui/brand/` and verified by an exactness test, never regenerated on `next build`
// (07-RESEARCH.md's Anti-Patterns section).
//
// BACKEND DECISION (07-RESEARCH.md open question 1, closed by this plan's Task 3 fidelity probe):
// `sharp` (libvips/librsvg) faithfully renders the nonzero-winding ring construct 07-01's
// `geometry.ts` actually ships (an outer circle wound with an inner circle wound against it, no
// `fill-rule="evenodd"` anywhere) -- verified by tests/unit/brand/raster.test.ts's fidelity probe,
// which imports `ring()` from geometry.ts directly rather than a hand-rolled stand-in. RASTER_
// BACKEND is therefore 'sharp'. Had the probe failed (hole filled in, band missing, or any other
// visibly wrong render), or had 07-02 Task 1's package-legitimacy checkpoint rejected `sharp`,
// this file would instead implement `svgToPng` via a headless Chromium page
// (`chromium.launch()` -> `page.setContent()` -> `page.screenshot({ omitBackground })`) and set
// RASTER_BACKEND = 'playwright' -- the exported API is identical either way, so no caller needs to
// change if that branch is ever taken in a future plan.

export type RasterBackend = 'sharp' | 'playwright';

export const RASTER_BACKEND: RasterBackend = 'sharp';

export interface RasterSize {
  readonly width: number;
  readonly height: number;
}

export interface RasterOptions {
  /** CSS colour to composite under the SVG before rasterizing, producing an opaque PNG. Omitted
   *  means the output keeps its transparent background (07-RESEARCH.md Pitfall 5 -- callers that
   *  need an always-opaque export, like the Apple touch icon, must pass this explicitly). */
  readonly background?: string;
}

export interface PngMetadata {
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
}

async function loadSharp() {
  try {
    const mod = await import('sharp');
    return mod.default;
  } catch (err) {
    throw new Error(
      'Could not import "sharp" — run pnpm install (07-02-PLAN.md Task 2).\n' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function loadPngToIco() {
  try {
    const mod = await import('png-to-ico');
    return mod.default;
  } catch (err) {
    throw new Error(
      'Could not import "png-to-ico" — run pnpm install (07-02-PLAN.md Task 2).\n' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Rasterizes an SVG string to a PNG buffer at an exact pixel size. Transparent background unless
 *  `options.background` is set, in which case the SVG is composited (flattened) onto that colour
 *  first so the output is fully opaque. */
export async function svgToPng(svg: string, size: RasterSize, options?: RasterOptions): Promise<Buffer> {
  const sharp = await loadSharp();

  let pipeline = sharp(Buffer.from(svg), { density: 384 }).resize(size.width, size.height, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  if (options?.background !== undefined) {
    pipeline = pipeline.flatten({ background: options.background });
  }

  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

/** Packs one or more PNG buffers into a real multi-resolution `.ico` container. */
export async function pngsToIco(pngs: readonly Buffer[]): Promise<Buffer> {
  const pngToIco = await loadPngToIco();
  return pngToIco(Array.from(pngs));
}

/** Reads back a PNG buffer's width, height and whether it carries an alpha channel. */
export async function pngMetadata(png: Buffer): Promise<PngMetadata> {
  const sharp = await loadSharp();
  const metadata = await sharp(png).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    hasAlpha: metadata.hasAlpha ?? false,
  };
}
