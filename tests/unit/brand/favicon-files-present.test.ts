// 07-09-PLAN.md Task 2 (BRAND-02, D-11/D-12): proves the synced icon family stays present and
// byte-locked to `packages/ui/brand/*` (RESEARCH.md Common Pitfalls #3 — this is the CI drift
// gate that catches a forgotten sync run even if a human skips it locally), and that
// `manifest.ts`/`layout.tsx` carry the Web App Manifest and Open Graph metadata with zero colour
// literal in TypeScript (rule 4 / T-07-28).
//
// `apps/web/src/app/layout.tsx` imports `./globals.css` — probed directly against this suite's
// real node-environment Vite transform before writing this file: a plain CSS side-effect import
// resolves to a no-op module under Vitest's node environment (no jsdom/document dependency), so
// `metadata` is asserted by importing the real module, never by re-parsing its source text.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_SYNC_FILES } from '../../../apps/web/scripts/sync-brand-assets.mjs';

const APPS_WEB_APP_DIR = path.resolve('apps/web/src/app');
const BRAND_DIR = path.resolve('packages/ui/brand');
const BRAND_COLORS = JSON.parse(readFileSync(path.join(BRAND_DIR, 'brand-colors.json'), 'utf8')) as {
  themeColor: string;
  backgroundColor: string;
};

describe('apps/web/src/app/* synced brand files are present and byte-locked to packages/ui/brand', () => {
  for (const [destName, srcName] of Object.entries(BRAND_SYNC_FILES)) {
    it(`${destName} exists and equals packages/ui/brand/${srcName} byte-for-byte`, () => {
      const destPath = path.join(APPS_WEB_APP_DIR, destName);
      const srcPath = path.join(BRAND_DIR, srcName);
      const destBytes = readFileSync(destPath);
      const srcBytes = readFileSync(srcPath);

      expect(statSync(destPath).size).toBeGreaterThan(0);
      expect(destBytes.equals(srcBytes)).toBe(true);
    });
  }

  // The icon/image assets are non-trivial rasters/vectors; `brand-colors.json` is a deliberately
  // tiny two-key JSON config (62 bytes for the real committed file) — a blanket ">100 bytes"
  // assertion would be a false failure against genuinely correct data, so the size floor only
  // applies to the 6 non-JSON dest names.
  for (const destName of Object.keys(BRAND_SYNC_FILES).filter((name) => !name.endsWith('.json'))) {
    it(`${destName} is a non-trivial asset (> 100 bytes)`, () => {
      expect(statSync(path.join(APPS_WEB_APP_DIR, destName)).size).toBeGreaterThan(100);
    });
  }
});

describe('apps/web/src/app/manifest.ts', () => {
  const MANIFEST_PATH = path.join(APPS_WEB_APP_DIR, 'manifest.ts');
  const manifestSource = readFileSync(MANIFEST_PATH, 'utf8');

  it('contains no hex colour literal outside comments and no rgb(', () => {
    const codeOnly = manifestSource
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      })
      .join('\n');

    expect(codeOnly).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(codeOnly).not.toContain('rgb(');
  });

  it('imports ./brand-colors.json rather than hardcoding colours', () => {
    expect(manifestSource).toContain('brand-colors.json');
  });

  it('exports a default function returning a manifest shaped from brand-colors.json', async () => {
    const mod = (await import('../../../apps/web/src/app/manifest.ts')) as {
      default: () => {
        name: string;
        short_name: string;
        start_url: string;
        display: string;
        theme_color: string;
        background_color: string;
        icons: ReadonlyArray<{ src: string; sizes: string; type: string }>;
      };
    };

    const manifest = mod.default();

    expect(manifest.name).toBe('Noodara');
    expect(manifest.short_name).toBe('Noodara');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe(BRAND_COLORS.themeColor);
    expect(manifest.background_color).toBe(BRAND_COLORS.backgroundColor);

    const sizes = manifest.icons.map((icon) => icon.sizes).sort();
    expect(sizes).toEqual(['192x192', '512x512']);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
    }
  });
});

describe('apps/web/src/app/layout.tsx metadata', () => {
  it('has title, description and openGraph, and no icons key (file convention handles icons)', async () => {
    const mod = (await import('../../../apps/web/src/app/layout.tsx')) as {
      metadata: {
        title?: string;
        description?: string;
        icons?: unknown;
        openGraph?: {
          title?: string;
          description?: string;
          siteName?: string;
          type?: string;
        };
      };
    };

    expect(mod.metadata.title).toBe('Noodara');
    expect(mod.metadata.description).toBe('Your infrastructure, understood.');
    expect(mod.metadata.icons).toBeUndefined();
    expect(mod.metadata.openGraph).toEqual({
      title: 'Noodara',
      description: 'Your infrastructure, understood.',
      siteName: 'Noodara',
      type: 'website',
    });
  });
});
