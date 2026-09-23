// The construction sheet (07-08-PLAN.md Task 1, D-15) -- one pure builder plus the CLI that
// writes `docs/brand/construction.svg`.
//
// D-15 promises that a person can reproduce the logo from this sheet with a ruler and a compass.
// That promise survives an adjustment round (D-16) only if the sheet is COMPUTED from
// `packages/ui/src/brand/geometry.ts` rather than drawn once and forgotten: every grid line, every
// dimension label and the mark itself come from that module's exports here, so retuning a constant
// and re-running `pnpm brand:construction` is the entire update.
//
// PURE BUILDER, SEPARATE CLI. `constructionSvg` takes colours and a concept and returns a string;
// it reads no file, no environment variable and no clock. `constructionSheetOptions` takes the
// CONTENTS of `packages/ui/tokens.css` (never a path) and turns them into those colours. Only the
// `isMainModule`-guarded entry at the bottom touches the filesystem, following
// `scripts/check-package-provenance.mjs`'s own export-the-logic/guard-the-side-effects shape --
// which is what lets the exactness test call the exact same functions the CLI calls and diff the
// committed bytes with no generator process in the loop.
//
// THIS MODULE DRAWS NO GEOMETRY. The mark on the sheet is the `data-part="monogram"` group lifted
// out of a real `renderStaticSvg({kind: 'monogram', ...})` render -- the same components apps/web
// mounts (D-10) -- exactly as `static-svg.ts`'s own tile and `asset-manifest.ts`'s OG image do it.
// The only shapes assembled here are the grid lines, the margin box and the baseline, which are
// annotations ABOUT the mark rather than part of it. They are the one place in the brand pipeline
// where a `stroke` attribute is legitimate: a ruler is a stroke, the mark never is.
//
// NO COLOUR LITERAL. All four colours are the caller's. The CLI reads them out of
// `packages/ui/tokens.css` via `parseTokensCss` (keys carry no `--` prefix), and the brand board
// passes `var(--token)` references instead, so the same builder serves a themed HTML page and a
// standalone file with literal ink.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APERTURE_RADIUS,
  BASELINE,
  CONCEPT_META,
  DEFAULT_CONCEPT,
  GRID,
  MARGIN,
  STROKE,
  TERMINAL_RADIUS,
  fmt,
  monogramParts,
  type ConceptId,
} from '../../packages/ui/src/brand/geometry.js';
import { renderStaticSvg } from '../../packages/ui/src/brand/static-svg.js';
import { parseTokensCss } from '../../packages/ui/src/contrast.js';
import { changedFiles, writeIfChanged } from './write-if-changed.js';

/** `scripts/brand/` -> repo root, matching `write-if-changed.ts`'s own resolution -- paths come
 *  from this module's location, never from the process's working directory. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The one file this script ever writes. */
export const CONSTRUCTION_SVG_PATH = path.join(REPO_ROOT, 'docs', 'brand', 'construction.svg');

const TOKENS_CSS_PATH = path.join(REPO_ROOT, 'packages', 'ui', 'tokens.css');

/** The sheet's canvas, in px. Square, and the same 480 the brand board already reserved for its
 *  construction section. */
export const CONSTRUCTION_SHEET_SIZE = 480;

// --- Layout ------------------------------------------------------------------------------------
//
// Everything below is sheet layout (where the grid sits on the canvas, where the labels sit under
// it), never mark geometry. The mark's own coordinates all live in geometry.ts.

/** px per grid unit: 24 x 14 = 336, centred on the 480 canvas. */
const GRID_SCALE = 14;
const GRID_ORIGIN_X = (CONSTRUCTION_SHEET_SIZE - GRID * GRID_SCALE) / 2;
const GRID_ORIGIN_Y = 64;

/** Annotation weights, in GRID units (they sit inside the scaled group): a hairline for the
 *  ruler, twice that for the two guides that carry meaning. */
const GRID_LINE_WIDTH = 0.05;
const GUIDE_WIDTH = 0.1;

const TITLE_Y = 32;
const SUBTITLE_Y = 50;
const TITLE_SIZE = 14;
const CAPTION_SIZE = 11;

// Two columns, not three: `APERTURE_RADIUS = 6` and `TERMINAL_RADIUS = 1.5` are long enough at the
// caption size that a third column would run one label into the next (measured on the rendered
// sheet, not assumed). Three rows of two fit under the grid with the parts line below them.
const LABEL_COLUMNS = 2;
const LABEL_COLUMN_WIDTH = 192;
const LABEL_Y = 416;
const LABEL_ROW_STEP = 20;
const PARTS_Y = 472;

/** Every constant the mark is derived from, read from `geometry.ts` -- an adjustment round retunes
 *  the module and this sheet follows on the next `pnpm brand:construction`. */
const CONSTANTS: readonly (readonly [string, number])[] = [
  ['GRID', GRID],
  ['MARGIN', MARGIN],
  ['STROKE', STROKE],
  ['APERTURE_RADIUS', APERTURE_RADIUS],
  ['TERMINAL_RADIUS', TERMINAL_RADIUS],
  ['BASELINE', BASELINE],
];

const SUBTITLE = '24-unit grid, filled outlines, nonzero fill rule';
const PARTS_PREFIX = 'Parts, in order: ';

export interface ConstructionSvgOptions {
  readonly concept: ConceptId;
  /** The mark's fill. A token value for the committed file, `currentColor` for the board. */
  readonly ink: string;
  /** The ruler's colour (`--hairline-strong`). */
  readonly hairline: string;
  /** The guides' and the labels' colour (`--ink-secondary`). */
  readonly annotation: string;
  /** The label font stack (`--font-mono`): constants are numbers, and numbers are set in mono. */
  readonly font: string;
}

// --- Builder -----------------------------------------------------------------------------------

function labelX(index: number): number {
  return GRID_ORIGIN_X + (index % LABEL_COLUMNS) * LABEL_COLUMN_WIDTH;
}

function labelY(index: number): number {
  return LABEL_Y + Math.floor(index / LABEL_COLUMNS) * LABEL_ROW_STEP;
}

function text(x: number, y: number, size: number, colour: string, font: string, content: string): string {
  return `<text x="${fmt(x)}" y="${fmt(y)}" fill="${colour}" font-family="${font}" font-size="${fmt(size)}">${content}</text>`;
}

/** The ruler: one line per grid unit on each axis, in grid coordinates. */
function gridLines(hairline: string): string {
  const lines: string[] = [];
  const span = fmt(GRID);
  const width = fmt(GRID_LINE_WIDTH);
  for (let i = 0; i <= GRID; i += 1) {
    const at = fmt(i);
    lines.push(`<line x1="${at}" y1="0" x2="${at}" y2="${span}" stroke="${hairline}" stroke-width="${width}"/>`);
    lines.push(`<line x1="0" y1="${at}" x2="${span}" y2="${at}" stroke="${hairline}" stroke-width="${width}"/>`);
  }
  return lines.join('');
}

/** The two guides that carry meaning: the margin box no ink may touch, and the baseline the lockup
 *  aligns on. */
function guides(annotation: string): string {
  const inner = fmt(GRID - 2 * MARGIN);
  const width = fmt(GUIDE_WIDTH);
  return [
    `<rect data-guide="margin" x="${fmt(MARGIN)}" y="${fmt(MARGIN)}" width="${inner}" height="${inner}" fill="none" stroke="${annotation}" stroke-width="${width}"/>`,
    `<line data-guide="baseline" x1="0" y1="${fmt(BASELINE)}" x2="${fmt(GRID)}" y2="${fmt(BASELINE)}" stroke="${annotation}" stroke-width="${width}"/>`,
  ].join('');
}

/** Lifts the monogram group out of a real render, matching `static-svg.ts`'s own non-greedy
 *  approach -- exact because `Logo` nests no group inside that one. */
const MONOGRAM_GROUP_RE = /<g data-part="monogram">[\s\S]*?<\/g>/;

function monogramGroup(concept: ConceptId, ink: string): string {
  const markup = renderStaticSvg({ kind: 'monogram', concept, color: ink });
  const match = MONOGRAM_GROUP_RE.exec(markup);
  if (match === null) {
    // Fail loud: a silent fallback here would publish a construction sheet with no mark on it.
    throw new Error('construction-sheet.ts: the monogram render carried no monogram group to place on the grid');
  }
  return match[0];
}

/** One complete construction sheet. Pure: same options in, same bytes out. */
export function constructionSvg({ concept, ink, hairline, annotation, font }: ConstructionSvgOptions): string {
  const meta = CONCEPT_META[concept];
  const size = fmt(CONSTRUCTION_SHEET_SIZE);
  const parts = monogramParts(concept)
    .map((part) => part.part)
    .join(', ');
  const constants = CONSTANTS.map(([name, value], index) =>
    text(labelX(index), labelY(index), CAPTION_SIZE, annotation, font, `${name} = ${fmt(value)}`),
  ).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">`,
    `<title>Noodara monogram construction: concept ${meta.id.toUpperCase()}, ${meta.name}</title>`,
    text(GRID_ORIGIN_X, TITLE_Y, TITLE_SIZE, annotation, font, `Noodara monogram: ${meta.name}`),
    text(GRID_ORIGIN_X, SUBTITLE_Y, CAPTION_SIZE, annotation, font, SUBTITLE),
    `<g data-grid="${fmt(GRID)}" transform="translate(${fmt(GRID_ORIGIN_X)} ${fmt(GRID_ORIGIN_Y)}) scale(${fmt(GRID_SCALE)})">`,
    gridLines(hairline),
    guides(annotation),
    `<g fill="${ink}">`,
    monogramGroup(concept, ink),
    '</g>',
    '</g>',
    constants,
    text(GRID_ORIGIN_X, PARTS_Y, CAPTION_SIZE, annotation, font, `${PARTS_PREFIX}${parts}`),
    '</svg>',
    '',
  ].join('\n');
}

// --- Token reading -------------------------------------------------------------------------------

function requiredToken(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (value === undefined) {
    throw new Error(`construction-sheet.ts: tokens.css declares no --${name}`);
  }
  return value;
}

/** The committed sheet's four colours, read from a tokens.css-shaped string. The light theme is
 *  the right one for a document embedded in Markdown: a README or a docs page has no theme CSS of
 *  its own, and the light ink is the value every other committed light-theme asset already
 *  carries. Takes the CSS contents, never a path -- so the exactness test and the CLI below can
 *  call it with the same bytes. */
export function constructionSheetOptions(tokensCss: string, concept: ConceptId): ConstructionSvgOptions {
  const { light } = parseTokensCss(tokensCss);
  return {
    concept,
    ink: requiredToken(light, 'ink'),
    hairline: requiredToken(light, 'hairline-strong'),
    annotation: requiredToken(light, 'ink-secondary'),
    font: requiredToken(light, 'font-mono'),
  };
}

// --- CLI -----------------------------------------------------------------------------------------

function main(): void {
  const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
  writeIfChanged(CONSTRUCTION_SVG_PATH, constructionSvg(constructionSheetOptions(tokensCss, DEFAULT_CONCEPT)));

  if (changedFiles.length === 0) {
    console.log('construction-sheet: no files changed (fully idempotent run).');
    return;
  }
  console.log(`construction-sheet: ${String(changedFiles.length)} file(s) changed:`);
  for (const file of changedFiles) {
    console.log(`  ${file}`);
  }
}

// Importing this module (the exactness test, board-html.ts) must never write a file; only running
// it as `pnpm brand:construction` does. Same guard shape as scripts/check-package-provenance.mjs.
const entryPoint = process.argv[1];
const isMainModule = entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;
if (isMainModule) {
  try {
    main();
  } catch (err: unknown) {
    console.error('construction-sheet: FATAL', err);
    process.exit(1);
  }
}
