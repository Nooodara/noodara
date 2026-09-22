import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

// 07-02-PLAN.md Task 3: this test proves the raster pipeline (SVG -> PNG -> ICO) before any
// concept from 07-01 is rasterized for real, closing 07-RESEARCH.md's open question 1 (does the
// installed backend faithfully render the arc/winding constructs the concepts use?).
//
// The fidelity probe below renders the REAL construct the concepts ship, not a hand-rolled
// stand-in: `ring()` is imported straight from packages/ui/src/brand/geometry.ts (07-01), whose
// paths assume the SVG default (nonzero) fill rule -- see that module's own header. A ring's
// counter is a real hole only because the inner circle is wound *against* the outer one; there is
// no `fill-rule="evenodd"` anywhere in the SVG this test builds, and none may ever be added (an
// evenodd ring built from geometry.ts's overlapping parts would punch spurious holes at every
// overlap in the real monogram/wordmark, not just at the ring's own counter).
import { ring } from '../../../packages/ui/src/brand/geometry.js';
import { pngMetadata, pngsToIco, RASTER_BACKEND, svgToPng } from '../../../scripts/brand/raster.js';
import { changedFiles, resetChangedFiles, writeIfChanged } from '../../../scripts/brand/write-if-changed.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The real nonzero-winding ring construct: viewBox 0 0 24 24 (geometry.ts's own 24-unit grid),
 *  `ring(12, 12, 9, 5)` centred in it, plain `fill="black"` (no `fill-rule`, no `stroke`) so this
 *  is exactly the shape a consumer of geometry.ts is allowed to paint. */
function nonzeroRingSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${ring(12, 12, 9, 5)}" fill="black"/></svg>`;
}

/** A second, deliberately DIFFERENT construct used only to document RESEARCH.md's open question 1
 *  about `fill-rule="evenodd"` two-arc rings. This is NOT what 07-01's geometry module ships (it
 *  never sets `fill-rule`), so this probe's result never gates `RASTER_BACKEND` -- see the
 *  gating fidelity test below, which uses `nonzeroRingSvg()` exclusively. */
function evenoddRingSvg(): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill-rule="evenodd">' +
    '<path d="M32 8 A24 24 0 1 1 31.99 8 Z M32 18 A14 14 0 1 0 32.01 18 Z" fill="black"/>' +
    '</svg>'
  );
}

async function readRgbaPixel(png: Buffer, x: number, y: number): Promise<{ readonly alpha: number }> {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const offset = (y * info.width + x) * channels;
  return { alpha: data[offset + 3] as number };
}

describe('scripts/brand/raster.ts', () => {
  it('svgToPng produces a buffer starting with the PNG signature, and pngMetadata reports the requested size with alpha', async () => {
    const png = await svgToPng(nonzeroRingSvg(), { width: 16, height: 16 });

    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);

    const meta = await pngMetadata(png);
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
    expect(meta.hasAlpha).toBe(true);
  });

  it('svgToPng with a background composites an opaque (non-transparent) PNG', async () => {
    const png = await svgToPng(nonzeroRingSvg(), { width: 64, height: 64 }, { background: 'white' });
    const meta = await pngMetadata(png);

    if (meta.hasAlpha) {
      // Some backends always report an alpha channel even after flattening -- in that case every
      // pixel must be fully opaque (alpha 255), which is the behaviourally equivalent guarantee.
      const centre = await readRgbaPixel(png, 32, 32);
      const corner = await readRgbaPixel(png, 2, 2);
      expect(centre.alpha).toBe(255);
      expect(corner.alpha).toBe(255);
    } else {
      expect(meta.hasAlpha).toBe(false);
    }
  });

  it('fidelity probe: the real nonzero-winding ring() from geometry.ts rasterizes with an open counter, a painted band and a transparent corner', async () => {
    const png = await svgToPng(nonzeroRingSvg(), { width: 64, height: 64 });

    // viewBox is 24 units, target is 64px -> scale = 64/24. Centre of the viewBox (12,12) lands
    // exactly on pixel (32,32).
    const centre = await readRgbaPixel(png, 32, 32);
    // A point at radius 7 from the centre (strictly between rInner=5 and rOuter=9) along the
    // vertical axis: svg (12, 4.875) -> pixel (32, 13).
    const band = await readRgbaPixel(png, 32, 13);
    // Far outside the outer radius (svg distance from centre ~15.9 units): pixel (2,2).
    const corner = await readRgbaPixel(png, 2, 2);

    expect(centre.alpha).toBe(0);
    expect(band.alpha).toBeGreaterThan(200);
    expect(corner.alpha).toBe(0);
  });

  it('secondary probe (non-gating): an evenodd two-arc ring also renders with an open counter', async () => {
    // Documents RESEARCH.md open question 1's original evenodd framing. This is NOT the construct
    // 07-01's geometry module ships (it never sets fill-rule), so a mismatch here would NOT change
    // RASTER_BACKEND -- only the fidelity probe above gates that decision.
    const png = await svgToPng(evenoddRingSvg(), { width: 64, height: 64 });
    const centre = await readRgbaPixel(png, 32, 32);
    const band = await readRgbaPixel(png, 32, 18);

    expect(centre.alpha).toBe(0);
    expect(band.alpha).toBeGreaterThan(200);
  });

  it('RASTER_BACKEND is one of the two documented backends', () => {
    expect(['sharp', 'playwright']).toContain(RASTER_BACKEND);
  });

  it('pngsToIco packs multiple PNGs into a real multi-resolution ICO container', async () => {
    const png16 = await svgToPng(nonzeroRingSvg(), { width: 16, height: 16 });
    const png32 = await svgToPng(nonzeroRingSvg(), { width: 32, height: 32 });
    const png48 = await svgToPng(nonzeroRingSvg(), { width: 48, height: 48 });

    const ico = await pngsToIco([png16, png32, png48]);

    expect(ico.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
    const entryCount = ico.readUInt16LE(4);
    expect(entryCount).toBe(3);
  });

  it('writeIfChanged only writes when content actually differs, and records the ledger once', () => {
    resetChangedFiles();
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-raster-test-'));
    const filePath = path.join(dir, 'output.txt');

    const firstWrite = writeIfChanged(filePath, 'hello');
    const secondWrite = writeIfChanged(filePath, 'hello');
    const thirdWrite = writeIfChanged(filePath, 'goodbye');

    expect(firstWrite).toBe(true);
    expect(secondWrite).toBe(false);
    expect(thirdWrite).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('goodbye');
    // changedFiles records repo-relative paths (matching scripts/capture-discovery-fixtures.mjs's
    // own ledger convention) -- a tmpdir path outside the repo still resolves to a valid (if
    // parent-relative) relative path via `path.relative`, which is exactly what this asserts.
    const expectedRelative = path.relative(REPO_ROOT, filePath);
    expect(changedFiles.filter((f) => f === expectedRelative)).toHaveLength(1);
  });

  it('writeIfChanged handles a Buffer the same way, via Buffer.equals', () => {
    resetChangedFiles();
    const dir = mkdtempSync(path.join(tmpdir(), 'noodara-raster-test-'));
    const filePath = path.join(dir, 'output.bin');

    const firstWrite = writeIfChanged(filePath, Buffer.from([1, 2, 3]));
    const secondWrite = writeIfChanged(filePath, Buffer.from([1, 2, 3]));

    expect(firstWrite).toBe(true);
    expect(secondWrite).toBe(false);
    expect(readFileSync(filePath)).toEqual(Buffer.from([1, 2, 3]));
  });
});
