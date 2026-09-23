import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Logo } from './Logo.js';
import { CONCEPT_IDS, DEFAULT_CONCEPT, GRID, monogramParts } from './geometry.js';
import { renderUi, screen } from '../testing/render.js';

// Component tests for the monogram (07-03-PLAN.md Task 1). The geometry itself is already pinned
// by geometry.test.ts -- nothing here re-asserts a coordinate. What these tests own is the
// CONTRACT between the geometry and the DOM: currentColor by default, the caller-supplied test
// id, the a11y shape, and the stable `data-part` hooks Phase 8 will animate against.
//
// The one property this file asserts by ABSENCE is the fill rule. 07-01 built every path for the
// SVG default (nonzero) rule: parts overlap on purpose (the diagonal runs into the stems,
// concept B's focal disc caps its stem) and a ring's counter is cut by winding the inner circle
// against the outer one. Setting `fill-rule="evenodd"` would punch a hole at every one of those
// overlaps, so the component must never emit the attribute at all.

// Assembled at runtime so this file never contains the literal prop name as code: the repo-wide
// `check:ui-safety` gate counts occurrences across every source file (tests included) and
// requires exactly one -- apps/web's reviewed theme bootstrap. A test asserting the prop's
// absence must not itself become the second occurrence.
const REACT_RAW_HTML_PROP = ['dangerously', 'SetInnerHTML'].join('');

const LOGO_SOURCE = readFileSync(new URL('./Logo.tsx', import.meta.url), 'utf8');

// Everything that must never appear in rendered brand markup (T-07-06): script/foreign content,
// any URL reference, any event handler, any inline style, and any `#` (a colour literal or a
// fragment reference -- the mark is pure `currentColor` geometry and references nothing).
const FORBIDDEN_MARKUP: readonly RegExp[] = [
  /<script/i,
  /href=/i,
  /<foreignObject/i,
  /\son[a-z]+=/i,
  /style=/i,
  /#/,
];

// Takes `Element | null` so a missing group needs no type assertion at the call site: a null root
// yields an empty list, and the companion `not.toBeNull()` assertion is what actually reports a
// missing group.
function partNames(root: Element | null): readonly (string | null)[] {
  return root === null ? [] : Array.from(root.querySelectorAll('path')).map((path) => path.getAttribute('data-part'));
}

describe('Logo', () => {
  it('renders a standalone currentColor SVG on the 24-unit grid, decorative by default', () => {
    renderUi(<Logo data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');

    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${String(GRID)} ${String(GRID)}`);
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
  });

  it('never sets a fill rule or a stroke -- the paths depend on the SVG default (nonzero) rule', () => {
    renderUi(<Logo data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');

    expect(svg.getAttribute('fill-rule')).toBeNull();
    expect(svg.getAttribute('fillRule')).toBeNull();
    expect(svg.getAttribute('stroke')).toBeNull();
    for (const path of svg.querySelectorAll('path')) {
      expect(path.getAttribute('fill-rule')).toBeNull();
      expect(path.getAttribute('stroke')).toBeNull();
    }
  });

  it('becomes an image with an accessible name when a title is given', () => {
    renderUi(<Logo title="Noodara" data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.querySelector('title')?.textContent).toBe('Noodara');
  });

  it('sizes both axes from the size prop', () => {
    renderUi(<Logo size={64} data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');

    expect(svg.getAttribute('width')).toBe('64');
    expect(svg.getAttribute('height')).toBe('64');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('renders the parts of the requested concept, not the default one', () => {
    renderUi(<Logo concept="c" data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');

    expect(svg.querySelector('path[data-part="frame"]')).not.toBeNull();
    expect(svg.querySelector('path[data-part="stem-left"]')).toBeNull();
  });

  it('exposes the aperture and the stems of concept a as their own parts', () => {
    renderUi(<Logo concept="a" data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');

    expect(svg.querySelector('path[data-part="aperture"]')).not.toBeNull();
    expect(svg.querySelector('path[data-part="stem-left"]')).not.toBeNull();
  });

  it.each(CONCEPT_IDS)('renders concept %s in the exact part order of monogramParts', (concept) => {
    renderUi(<Logo concept={concept} data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');

    expect(partNames(svg)).toEqual(monogramParts(concept).map((part) => part.part));
  });

  it('wraps every path in a single g[data-part="monogram"] group', () => {
    renderUi(<Logo data-testid="brand-monogram" />);

    const svg = screen.getByTestId('brand-monogram');
    const group = svg.querySelector('g[data-part="monogram"]');

    expect(svg.querySelectorAll('g[data-part="monogram"]')).toHaveLength(1);
    expect(group).not.toBeNull();
    expect(partNames(svg).length).toBeGreaterThan(0);
    expect(partNames(group)).toEqual(partNames(svg));
  });

  it('accepts an explicit colour for the static-export path only', () => {
    // A colour NAME, never a hex: this file is excluded from the hex gate's scan, but the rule is
    // worth keeping anyway -- the real callers (07-06's generator) inject a token value read from
    // tokens.css, and no colour literal belongs in packages/ui/src at all.
    renderUi(<Logo color="red" data-testid="brand-monogram" />);

    expect(screen.getByTestId('brand-monogram').getAttribute('fill')).toBe('red');
  });

  it('renders no test id at all when the caller supplies none', () => {
    const markup = renderToStaticMarkup(<Logo />);

    expect(markup).not.toContain('data-testid');
  });

  it('produces markup with no script, link, event handler, inline style or hash character', () => {
    for (const concept of CONCEPT_IDS) {
      const markup = renderToStaticMarkup(<Logo concept={concept} />);
      for (const forbidden of FORBIDDEN_MARKUP) {
        expect(markup).not.toMatch(forbidden);
      }
    }
  });

  it('renders the same string on every call (byte-stable static export)', () => {
    expect(renderToStaticMarkup(<Logo concept={DEFAULT_CONCEPT} />)).toBe(
      renderToStaticMarkup(<Logo concept={DEFAULT_CONCEPT} />),
    );
  });

  it('is written as real JSX -- no raw HTML injection prop, no element id', () => {
    expect(LOGO_SOURCE).not.toContain(REACT_RAW_HTML_PROP);
    expect(LOGO_SOURCE).not.toMatch(/\bid=/);
  });
});
