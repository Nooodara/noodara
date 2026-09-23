// Renders one brand board per concept and theme (07-04-PLAN.md Task 2, D-14).
//
// `pnpm brand:boards` -> docs/brand/review/<concept>/board-<light|dark>.png, six files for the
// three concepts. The board itself is built by `board-html.ts`, which is pure and unit-tested;
// this script only supplies the two things that module refuses to reach for on its own -- the
// tokens CSS read from disk, and the four literal colours (the favicon tile's and the OG image's)
// read out of those same tokens with `parseTokensCss`. Nothing here states a colour or a
// coordinate.
//
// Chromium renders the board with no navigation and no network: `page.setContent` on inert markup
// that carries no script, no stylesheet link and no remote image (see `board-html.ts`'s header).
//
// Writes go through `writeIfChanged` (07-02), so a re-run that produces identical pixels reports
// "no files changed" instead of touching six mtimes -- the same discipline the asset pipeline uses,
// and what makes an adjustment round's real diff readable.
//
// WHY THE npm SCRIPT PASSES `--tsconfig packages/ui/tsconfig.json`. The board renders the real
// `.tsx` brand components, and tsx picks a JSX transform from the tsconfig that actually COVERS
// the file being transformed -- `scripts/brand/tsconfig.json` (the one `pnpm typecheck` uses)
// includes only this directory, so under it `packages/ui/src/brand/*.tsx` would fall back to the
// classic `React.createElement` transform and throw "React is not defined" at render time.
// `packages/ui/tsconfig.json` is the config those components are genuinely compiled with
// (`jsx: react-jsx`), so pointing tsx at it runs them exactly as `pnpm build` does. Typechecking is
// unaffected: that still happens under `scripts/brand/tsconfig.json`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { CONCEPT_IDS, type ConceptId } from '../../packages/ui/src/brand/geometry.js';
import { parseTokensCss } from '../../packages/ui/src/contrast.js';
import { buildBoardHtml } from './board-html.js';
import { THEMES, reviewPngPath } from './review-paths.js';
import { changedFiles, writeIfChanged } from './write-if-changed.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const TOKENS_CSS_PATH = path.join(REPO_ROOT, 'packages', 'ui', 'tokens.css');

/** The board is 1200px wide (see `board-html.ts`); the viewport leaves a little air either side and
 *  the height only seeds the first paint -- `fullPage` decides the real one. `deviceScaleFactor: 2`
 *  makes the PNG legible when the user zooms into the 16px row. */
const VIEWPORT = { width: 1280, height: 900 } as const;
const DEVICE_SCALE_FACTOR = 2;

/** `--concept a|b|c` restricts the run to one concept, which is what a D-16 adjustment round wants
 *  (re-render only the concept that changed). No flag means all three. */
function parseConcepts(argv: readonly string[]): readonly ConceptId[] {
  const index = argv.indexOf('--concept');
  if (index === -1) return CONCEPT_IDS;
  const value = argv[index + 1];
  if (value === undefined || !CONCEPT_IDS.includes(value as ConceptId)) {
    throw new Error(`render-boards: --concept expects one of ${CONCEPT_IDS.join(', ')}`);
  }
  return [value as ConceptId];
}

function tokenValue(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (value === undefined) {
    // Fail loud: a missing token would otherwise render as an empty CSS value and quietly produce
    // a board with an invisible tile or an unreadable OG preview.
    throw new Error(`render-boards: packages/ui/tokens.css declares no --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const concepts = parseConcepts(process.argv.slice(2));
  const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const tokens = parseTokensCss(tokensCss);

  // D-11: the favicon tile is the one surface that carries the accent blue. D-12: the OG image is
  // light ink on the dark canvas, in both boards -- a social card has no theme of its own.
  const tile = {
    background: tokenValue(tokens.light, 'accent-fill'),
    ink: tokenValue(tokens.light, 'on-accent'),
  };
  const og = { canvas: tokenValue(tokens.dark, 'canvas'), ink: tokenValue(tokens.dark, 'ink') };

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: DEVICE_SCALE_FACTOR });
    for (const concept of concepts) {
      for (const theme of THEMES) {
        const html = buildBoardHtml({ concept, theme, tokensCss, tile, og });
        await page.setContent(html, { waitUntil: 'load' });
        const png = await page.screenshot({ fullPage: true, type: 'png' });
        writeIfChanged(reviewPngPath(concept, 'board', theme), png);
      }
    }
  } finally {
    await browser.close();
  }

  if (changedFiles.length === 0) {
    console.log('render-boards: no files changed (fully idempotent run).');
    return;
  }
  console.log(`render-boards: ${String(changedFiles.length)} file(s) changed:`);
  for (const file of changedFiles) {
    console.log(`  ${file}`);
  }
}

main().catch((err: unknown) => {
  console.error('render-boards: FATAL', err);
  process.exit(1);
});
