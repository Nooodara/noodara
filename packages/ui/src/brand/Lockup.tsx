import { DEFAULT_CONCEPT, GRID, fmt, lockupLayout, lockupParts, type ConceptId } from './geometry.js';

// Lockup -- the horizontal monogram + wordmark (07-03-PLAN.md, D-04). This is what the expanded
// sidebar (>=1280px), the README and the public site show.
//
// A COMPOSITION, NEVER A THIRD DRAWING (D-05): the N here IS the monogram and the word here IS
// the wordmark, both read from geometry.ts, with the wordmark group translated by the layout's
// own offset. Nothing is re-drawn at a lockup-specific size, so the three lockups can never drift
// apart. The monogram group carries no transform -- the layout puts it at the origin, and the
// wordmark's glyph builders already draw on the shared baseline, so the translation is horizontal
// only.
//
// Same envelope rules as Logo.tsx, for the same reasons (read that header first): `currentColor`
// by default with `color` reserved for the static export (D-09/D-10), no `fill-rule` and no
// `stroke` (07-01's nonzero winding), `data-part` instead of `id` -- the Sidebar mounts Logo and
// Lockup simultaneously, one CSS-hidden per breakpoint, so duplicate ids would be invalid HTML --
// never `dangerouslySetInnerHTML`, no `className`, and the test id comes from the caller
// (`brand-lockup`).
//
// `fmt` formats the viewBox and the translate: the lockup box is not an integer width, and
// byte-stable output is what lets 07-06 diff a committed static SVG against a fresh render.

export interface LockupProps {
  readonly concept?: ConceptId;
  /** CSS px for the lockup's height; the width follows from the layout's own ratio. */
  readonly height?: number;
  readonly title?: string;
  /** STATIC EXPORT ONLY -- never pass this in app code. */
  readonly color?: string;
  readonly 'data-testid'?: string | undefined;
}

export function Lockup({
  concept = DEFAULT_CONCEPT,
  height = GRID,
  title,
  color,
  'data-testid': testId,
}: LockupProps) {
  const layout = lockupLayout(concept);
  const { monogram, wordmark } = lockupParts(concept);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${fmt(layout.width)} ${fmt(layout.height)}`}
      width={Math.round((height * layout.width) / layout.height)}
      height={height}
      fill={color ?? 'currentColor'}
      role={title === undefined ? undefined : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      data-testid={testId}
    >
      {title === undefined ? null : <title>{title}</title>}
      <g data-part="monogram">
        {monogram.map((part) => (
          <path key={part.part} data-part={part.part} d={part.d} />
        ))}
      </g>
      <g data-part="wordmark" transform={`translate(${fmt(layout.wordmarkX)} ${fmt(layout.wordmarkY)})`}>
        {wordmark.map((part, index) => (
          // Index-keyed for the same reason as Wordmark.tsx: "noodara" repeats letters, and the
          // layout order is fixed by geometry.ts.
          <path key={`${part.part}-${String(index)}`} data-part={part.part} d={part.d} />
        ))}
      </g>
    </svg>
  );
}
