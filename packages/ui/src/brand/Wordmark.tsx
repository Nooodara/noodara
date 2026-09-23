import { DEFAULT_CONCEPT, GRID, fmt, wordmarkParts, wordmarkWidth, type ConceptId } from './geometry.js';

// Wordmark -- "noodara" in lowercase, drawn (not typeset) from the monogram's own constants
// (07-03-PLAN.md, D-05/D-06/D-07/D-08). No font dependency, no licence, no hinting to lose at
// 14px; the two "o" ARE the monogram's aperture ring, which is the wordmark's signature detail.
//
// Same envelope rules as Logo.tsx, and for the same reasons (read that header first): geometry.ts
// owns every coordinate (D-10), `currentColor` by default with `color` reserved for the static
// export (D-09), no `fill-rule` and no `stroke` (07-01's nonzero winding), `data-part` instead of
// `id`, never `dangerouslySetInnerHTML`, no `className`, and the test id comes from the caller.
//
// The box is NOT square: the viewBox is the measured word width by the shared 24-unit grid
// height, so the caller sizes the word by its HEIGHT (the dimension that must match surrounding
// type) and the width follows from the ratio. `fmt` formats the width because it is not an
// integer -- three decimals, no negative zero, byte-stable across machines.
//
// One glyph, one path, one `data-part`. Part names repeat across the word ("noodara" has two "o"
// and two "a"), which is exactly why these are `data-part` attributes and not ids -- a selector
// like `[data-part="glyph-o"]` legitimately matches both, and Phase 8 can animate them together.

export interface WordmarkProps {
  readonly concept?: ConceptId;
  /** CSS px for the grid height (the cap box the word is laid out in); the width follows from the
   *  word's own measured ratio. */
  readonly height?: number;
  readonly title?: string;
  /** STATIC EXPORT ONLY -- never pass this in app code. */
  readonly color?: string;
  readonly 'data-testid'?: string | undefined;
}

export function Wordmark({
  concept = DEFAULT_CONCEPT,
  height = GRID,
  title,
  color,
  'data-testid': testId,
}: WordmarkProps) {
  const unitWidth = wordmarkWidth(concept);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${fmt(unitWidth)} ${fmt(GRID)}`}
      width={Math.round((height * unitWidth) / GRID)}
      height={height}
      fill={color ?? 'currentColor'}
      role={title === undefined ? undefined : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      data-testid={testId}
    >
      {title === undefined ? null : <title>{title}</title>}
      <g data-part="wordmark">
        {wordmarkParts(concept).map((part, index) => (
          // The index is part of the key because the word repeats letters; `part.part` alone is
          // not unique across "noodara". Layout order is fixed by geometry.ts, so an index key is
          // stable here -- this list is never reordered, filtered or inserted into.
          <path key={`${part.part}-${String(index)}`} data-part={part.part} d={part.d} />
        ))}
      </g>
    </svg>
  );
}
