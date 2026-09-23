import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Lockup } from './Lockup.js';
import { Logo } from './Logo.js';
import { Wordmark } from './Wordmark.js';
import { GRID, fmt, type ConceptId } from './geometry.js';

// The static-export path for the brand (07-03-PLAN.md Task 2, D-10/D-11).
//
// D-10: "un solo SVG con currentColor en la app; dos SVG estaticos generados desde la misma
// fuente, nunca dibujados aparte". That sentence is only true if the exported file and the live
// component share ONE render path -- this module is that path. Every string produced here comes
// from `renderToStaticMarkup` of the very components apps/web mounts, with an ink colour passed
// in through their `color` prop. Nothing here draws: there is no path data, no radius, no angle.
// A README or site SVG can therefore never drift from the app's mark without a component change.
//
// D-11: the favicon/app-icon tile is the ONLY surface where the brand carries the accent blue --
// a rounded rect in `--accent-fill` with the monogram in `--on-accent` on top. That rect is the
// one shape this module assembles itself (a background is not a mark), and even then the monogram
// inside it is lifted out of a real `<Logo>` render rather than re-emitted.
//
// COLOURS ARE ALWAYS THE CALLER'S. This file contains no colour literal of any kind -- no hex, no
// `rgb(`, not even `currentColor`. `check:ui-safety` scans `packages/ui/src/**` for hex/rgb
// literals and this module must stay trivially green; more importantly, the real callers (07-06's
// asset generator) read `--ink`, `--canvas`, `--accent-fill` and `--on-accent` out of
// `packages/ui/tokens.css` with `parseTokensCss` (contrast.ts), so the exported assets carry the
// design system's own values by construction instead of a copy that can go stale.
//
// NO TITLE ON A STATIC EXPORT. These files are decorative images consumed through an `<img alt>`
// (the README's `<picture>`) or as an icon the browser labels itself; the accessible name lives on
// the embedding element. Rendering without a `title` therefore leaves `aria-hidden="true"` in the
// markup, which is correct for an image that is described from the outside.

export const STATIC_KINDS = ['monogram', 'wordmark', 'lockup'] as const;
export type StaticKind = (typeof STATIC_KINDS)[number];

export interface StaticSvgOptions {
  readonly kind: StaticKind;
  readonly concept: ConceptId;
  /** The ink. Always a value the caller read from tokens.css -- never a literal in this file. */
  readonly color: string;
}

/** Renders one lockup as a standalone SVG document string, ending in a trailing newline so the
 *  file written to disk is POSIX-clean and diffs a line at a time. */
export function renderStaticSvg({ kind, concept, color }: StaticSvgOptions): string {
  const element =
    kind === 'monogram'
      ? createElement(Logo, { concept, color })
      : kind === 'wordmark'
        ? createElement(Wordmark, { concept, color })
        : createElement(Lockup, { concept, color });
  return `${renderToStaticMarkup(element)}\n`;
}

export interface TileSvgOptions {
  readonly concept: ConceptId;
  /** The tile fill (D-11: `--accent-fill`). Caller-supplied, as always. */
  readonly background: string;
  /** The monogram fill (D-11: `--on-accent`). */
  readonly ink: string;
  /** Edge length in px; the tile is square. */
  readonly size: number;
  /** Corner radius as a fraction of `size`, so the corner belongs to the system's radius family
   *  at every icon size (10/44 is `--r-md` on a 44px control). */
  readonly radiusRatio: number;
}

/** How much of the tile the monogram occupies. Constant across every icon size, so the mark's
 *  optical weight in a browser tab, on a home screen and in a PWA splash is the same. */
const MONOGRAM_TILE_RATIO = 0.62;

/** Lifts the monogram group out of a rendered `<Logo>`. Non-greedy to the first closing tag,
 *  which is exact because `Logo` nests no group inside that one. */
const MONOGRAM_GROUP_RE = /<g data-part="monogram">[\s\S]*?<\/g>/;

/** The favicon / app-icon tile: a rounded background with the monogram centred on top, both
 *  painted in caller-supplied colours. The monogram is the real component's own output, scaled
 *  by a transform -- the mark itself is never re-emitted at icon size. */
export function tileSvg({ concept, background, ink, size, radiusRatio }: TileSvgOptions): string {
  const markup = renderToStaticMarkup(createElement(Logo, { concept }));
  const monogram = MONOGRAM_GROUP_RE.exec(markup);
  if (monogram === null) {
    // Fail loud: a silent fallback here would ship a blank icon. The only way this can happen is
    // Logo.tsx dropping or renaming its monogram group, which is a breaking change for Phase 8's
    // animation hooks too.
    throw new Error('static-svg.ts: the Logo render carried no monogram group to place on the tile');
  }

  const scale = (size * MONOGRAM_TILE_RATIO) / GRID;
  const offset = (size - size * MONOGRAM_TILE_RATIO) / 2;
  const radius = Math.round(size * radiusRatio);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(size)} ${fmt(size)}" width="${fmt(size)}" height="${fmt(size)}">`,
    `<rect width="${fmt(size)}" height="${fmt(size)}" rx="${fmt(radius)}" ry="${fmt(radius)}" fill="${background}"/>`,
    `<g transform="translate(${fmt(offset)} ${fmt(offset)}) scale(${fmt(scale)})" fill="${ink}">`,
    monogram[0],
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}
