import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Wordmark } from './Wordmark.js';
import { DEFAULT_CONCEPT, GRID, fmt, wordmarkParts, wordmarkWidth } from './geometry.js';
import { renderUi, screen } from '../testing/render.js';

// Component tests for the lowercase "noodara" wordmark (07-03-PLAN.md Task 1). Same contract as
// Logo.test.tsx: currentColor by default, caller-supplied test id, decorative unless titled, and
// one `data-part` per glyph. The wordmark's own box is NOT square -- its viewBox is the measured
// word width by the 24-unit grid height -- so the width attribute is derived from the height
// prop, never assumed equal to it.
//
// No `fill-rule` here either: the two "o" are the monogram's aperture ring, whose counter is cut
// by opposite winding under the SVG default (nonzero) rule (07-01). See Logo.test.tsx's header.

const REACT_RAW_HTML_PROP = ['dangerously', 'SetInnerHTML'].join('');

// Repo-root-relative and comment-stripped -- see Logo.test.tsx's notes on both.
// Reads a source file with its comment LINES stripped, exactly as scripts/check-ui-safety.mjs's
// own gate does before counting a match. The component headers deliberately NAME the banned raw
// HTML prop (PATTERNS.md requires the invariant to be stated where a reviewer reads it), and a
// comment describing a rule must never count as a violation of it.
function codeOf(relPath: string): string {
  return readFileSync(relPath, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
    })
    .join('\n');
}

const WORDMARK_SOURCE = codeOf('packages/ui/src/brand/Wordmark.tsx');

const FORBIDDEN_MARKUP: readonly RegExp[] = [
  /<script/i,
  /href=/i,
  /<foreignObject/i,
  /\son[a-z]+=/i,
  /style=/i,
  /#/,
];

describe('Wordmark', () => {
  it('renders a currentColor SVG whose viewBox is the measured word width by the grid height', () => {
    renderUi(<Wordmark data-testid="brand-wordmark" />);

    const svg = screen.getByTestId('brand-wordmark');

    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe(
      `0 0 ${fmt(wordmarkWidth(DEFAULT_CONCEPT))} ${String(GRID)}`,
    );
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
  });

  it('derives its width from the height prop and the word ratio, defaulting to the grid height', () => {
    renderUi(<Wordmark data-testid="brand-wordmark" />);

    const svg = screen.getByTestId('brand-wordmark');

    expect(svg.getAttribute('height')).toBe('24');
    expect(svg.getAttribute('width')).toBe(
      String(Math.round((GRID * wordmarkWidth(DEFAULT_CONCEPT)) / GRID)),
    );
  });

  it('scales the width with a non-default height', () => {
    renderUi(<Wordmark height={48} data-testid="brand-wordmark" />);

    const svg = screen.getByTestId('brand-wordmark');

    expect(svg.getAttribute('height')).toBe('48');
    expect(svg.getAttribute('width')).toBe(
      String(Math.round((48 * wordmarkWidth(DEFAULT_CONCEPT)) / GRID)),
    );
  });

  it('renders one path per letter of "noodara", in the layout order', () => {
    renderUi(<Wordmark data-testid="brand-wordmark" />);

    const svg = screen.getByTestId('brand-wordmark');
    const glyphs = svg.querySelectorAll('path[data-part^="glyph-"]');

    expect(glyphs).toHaveLength(7);
    expect(Array.from(glyphs).map((glyph) => glyph.getAttribute('data-part'))).toEqual(
      wordmarkParts(DEFAULT_CONCEPT).map((part) => part.part),
    );
  });

  it('wraps the glyphs in a single g[data-part="wordmark"] group', () => {
    renderUi(<Wordmark data-testid="brand-wordmark" />);

    const svg = screen.getByTestId('brand-wordmark');

    expect(svg.querySelectorAll('g[data-part="wordmark"]')).toHaveLength(1);
    expect(svg.querySelectorAll('g[data-part="wordmark"] path')).toHaveLength(7);
  });

  it('never sets a fill rule or a stroke', () => {
    renderUi(<Wordmark data-testid="brand-wordmark" />);

    const svg = screen.getByTestId('brand-wordmark');

    expect(svg.getAttribute('fill-rule')).toBeNull();
    expect(svg.getAttribute('stroke')).toBeNull();
    for (const path of svg.querySelectorAll('path')) {
      expect(path.getAttribute('fill-rule')).toBeNull();
      expect(path.getAttribute('stroke')).toBeNull();
    }
  });

  it('becomes an image with an accessible name when a title is given', () => {
    renderUi(<Wordmark title="Noodara" data-testid="brand-wordmark" />);

    const svg = screen.getByTestId('brand-wordmark');

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.querySelector('title')?.textContent).toBe('Noodara');
  });

  it('accepts an explicit colour for the static-export path only', () => {
    renderUi(<Wordmark color="red" data-testid="brand-wordmark" />);

    expect(screen.getByTestId('brand-wordmark').getAttribute('fill')).toBe('red');
  });

  it('produces deterministic markup with no script, link, event handler, inline style or hash character', () => {
    const markup = renderToStaticMarkup(<Wordmark />);

    expect(markup).toBe(renderToStaticMarkup(<Wordmark />));
    for (const forbidden of FORBIDDEN_MARKUP) {
      expect(markup).not.toMatch(forbidden);
    }
  });

  it('is written as real JSX -- no raw HTML injection prop, no element id', () => {
    expect(WORDMARK_SOURCE).not.toContain(REACT_RAW_HTML_PROP);
    expect(WORDMARK_SOURCE).not.toMatch(/\bid=/);
  });
});
