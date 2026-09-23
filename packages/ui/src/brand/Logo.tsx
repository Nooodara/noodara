import { DEFAULT_CONCEPT, GRID, fmt, monogramParts, type ConceptId } from './geometry.js';

// Logo -- the Noodara monogram on its own (07-03-PLAN.md, D-03/D-04). The rail at 900-1279px,
// the AuthCard on /login and /setup, the favicon tile and the brand board all render THIS
// component; none of them owns a coordinate.
//
// geometry.ts IS the drawing (D-10). This file contributes no path data, no radius and no angle
// -- only the SVG envelope (viewBox, size, colour, a11y) and the `data-part` hooks. A D-16
// adjustment round therefore never touches this file.
//
// COLOUR: `currentColor` (D-09). Inside the app the mark is monochrome ink and inherits the
// theme through the CSS cascade, so one SVG serves light and dark -- there is no second asset and
// no theme branch. The `color` prop is the STATIC-EXPORT escape hatch only (static-svg.ts passes
// a token value read from tokens.css so the README/site copies, which have no theme CSS, carry a
// literal ink). App code must never pass it: 07-07's Sidebar/AuthCard tests assert
// `fill="currentColor"` on both surfaces.
//
// NO FILL RULE, NO STROKE. 07-01 wound every part for the SVG default (nonzero) rule: parts
// overlap by design (the diagonal runs into the stems, concept B's focal disc caps its stem) and
// a ring's counter is cut by winding the inner circle against the outer one. Setting
// `fill-rule="evenodd"` would turn every overlap into a hole; setting a `stroke` would scale
// inconsistently between a 16px favicon and a 256px board render. Both absences are asserted in
// Logo.test.tsx.
//
// `data-part`, NEVER `id`. The Sidebar mounts the monogram and the lockup simultaneously (one
// CSS-hidden per breakpoint), so duplicate element ids would be invalid HTML the moment both are
// in the document; Phase 8 (UI-08) animates the mark by selecting `[data-part="aperture"]`, which
// works for any number of instances. Part names come from geometry.ts verbatim -- renaming one is
// a breaking change for that animation, not a refactor.
//
// Never `dangerouslySetInnerHTML`: the repo holds exactly one reviewed occurrence (apps/web's
// theme bootstrap) and `check:ui-safety` fails on a second. The static-export path builds its
// strings by RENDERING this component, never by injecting raw SVG into it.
//
// The test id is the caller's, not this component's: the Sidebar passes `brand-monogram`, exactly
// as it passes `shell-theme-toggle` to ThemeToggle. No `className` prop either (matching Button):
// sizing is the `size` prop, and layout belongs to the wrapper at the mount site.

export interface LogoProps {
  /** Which of the three constructions to draw. Defaults to `DEFAULT_CONCEPT` until 07-05 records
   *  the user's choice -- nothing downstream should hardcode a concept id. */
  readonly concept?: ConceptId;
  /** CSS px for both axes; the mark is square. */
  readonly size?: number;
  /** Set only when the mark stands alone with no adjacent visible text. When set the SVG becomes
   *  `role="img"` with this string as its accessible name; when unset it is `aria-hidden`. */
  readonly title?: string;
  /** STATIC EXPORT ONLY -- see the colour note above. Never pass this in app code. */
  readonly color?: string;
  readonly 'data-testid'?: string | undefined;
}

export function Logo({
  concept = DEFAULT_CONCEPT,
  size = GRID,
  title,
  color,
  'data-testid': testId,
}: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${fmt(GRID)} ${fmt(GRID)}`}
      width={size}
      height={size}
      fill={color ?? 'currentColor'}
      role={title === undefined ? undefined : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      data-testid={testId}
    >
      {title === undefined ? null : <title>{title}</title>}
      <g data-part="monogram">
        {monogramParts(concept).map((part) => (
          <path key={part.part} data-part={part.part} d={part.d} />
        ))}
      </g>
    </svg>
  );
}
