import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Lockup } from './Lockup.js';
import { CONCEPT_IDS, DEFAULT_CONCEPT, fmt, lockupLayout, monogramParts, wordmarkParts } from './geometry.js';
import { renderUi, screen } from '../testing/render.js';

// Component tests for the horizontal lockup (07-03-PLAN.md Task 1, D-04). The lockup is a
// COMPOSITION, never a third drawing: the N in it is the monogram and the word in it is the
// wordmark, both taken from geometry.ts, with the wordmark group translated by the layout's own
// offset. These tests assert exactly that -- same parts, same order, one transform.
//
// The determinism assertion here is the one 07-06's generated-asset accuracy test rests on: if
// two renders of the same element ever differ, a committed static SVG can drift from the
// component without any geometry change.

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

const LOCKUP_SOURCE = codeOf('packages/ui/src/brand/Lockup.tsx');

const FORBIDDEN_MARKUP: readonly RegExp[] = [
  /<script/i,
  /href=/i,
  /<foreignObject/i,
  /\son[a-z]+=/i,
  /style=/i,
  /#/,
];

function partNames(root: Element | null): readonly (string | null)[] {
  return root === null ? [] : Array.from(root.querySelectorAll('path')).map((path) => path.getAttribute('data-part'));
}

describe('Lockup', () => {
  it('renders a currentColor SVG whose viewBox is the lockup layout box', () => {
    renderUi(<Lockup data-testid="brand-lockup" />);

    const svg = screen.getByTestId('brand-lockup');
    const layout = lockupLayout(DEFAULT_CONCEPT);

    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${fmt(layout.width)} ${fmt(layout.height)}`);
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
  });

  it('derives its width from the height prop and the layout ratio', () => {
    renderUi(<Lockup height={48} data-testid="brand-lockup" />);

    const svg = screen.getByTestId('brand-lockup');
    const layout = lockupLayout(DEFAULT_CONCEPT);

    expect(svg.getAttribute('height')).toBe('48');
    expect(svg.getAttribute('width')).toBe(String(Math.round((48 * layout.width) / layout.height)));
  });

  it('contains both the monogram group and the wordmark group', () => {
    renderUi(<Lockup data-testid="brand-lockup" />);

    const svg = screen.getByTestId('brand-lockup');

    expect(svg.querySelectorAll('g[data-part="monogram"]')).toHaveLength(1);
    expect(svg.querySelectorAll('g[data-part="wordmark"]')).toHaveLength(1);
  });

  it('translates the wordmark group by the layout offset and leaves the monogram untransformed', () => {
    renderUi(<Lockup data-testid="brand-lockup" />);

    const svg = screen.getByTestId('brand-lockup');
    const layout = lockupLayout(DEFAULT_CONCEPT);

    expect(svg.querySelector('g[data-part="wordmark"]')?.getAttribute('transform')).toBe(
      `translate(${fmt(layout.wordmarkX)} ${fmt(layout.wordmarkY)})`,
    );
    expect(svg.querySelector('g[data-part="monogram"]')?.getAttribute('transform')).toBeNull();
  });

  it.each(CONCEPT_IDS)('reuses concept %s parts verbatim, in order, inside each group', (concept) => {
    renderUi(<Lockup concept={concept} data-testid="brand-lockup" />);

    const svg = screen.getByTestId('brand-lockup');

    expect(partNames(svg.querySelector('g[data-part="monogram"]'))).toEqual(
      monogramParts(concept).map((part) => part.part),
    );
    expect(partNames(svg.querySelector('g[data-part="wordmark"]'))).toEqual(
      wordmarkParts(concept).map((part) => part.part),
    );
  });

  it('never sets a fill rule or a stroke', () => {
    renderUi(<Lockup data-testid="brand-lockup" />);

    const svg = screen.getByTestId('brand-lockup');

    expect(svg.getAttribute('fill-rule')).toBeNull();
    expect(svg.getAttribute('stroke')).toBeNull();
    for (const path of svg.querySelectorAll('path')) {
      expect(path.getAttribute('fill-rule')).toBeNull();
      expect(path.getAttribute('stroke')).toBeNull();
    }
  });

  it('becomes an image with an accessible name when a title is given', () => {
    renderUi(<Lockup title="Noodara" data-testid="brand-lockup" />);

    const svg = screen.getByTestId('brand-lockup');

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.querySelector('title')?.textContent).toBe('Noodara');
  });

  it('accepts an explicit colour for the static-export path only', () => {
    renderUi(<Lockup color="red" data-testid="brand-lockup" />);

    expect(screen.getByTestId('brand-lockup').getAttribute('fill')).toBe('red');
  });

  it('renders the same string on every call (the exactness test 07-06 rests on)', () => {
    expect(renderToStaticMarkup(<Lockup />)).toBe(renderToStaticMarkup(<Lockup />));
  });

  it('produces markup with no script, link, event handler, inline style or hash character', () => {
    for (const concept of CONCEPT_IDS) {
      const markup = renderToStaticMarkup(<Lockup concept={concept} />);
      for (const forbidden of FORBIDDEN_MARKUP) {
        expect(markup).not.toMatch(forbidden);
      }
    }
  });

  it('is written as real JSX -- no raw HTML injection prop, no element id', () => {
    expect(LOCKUP_SOURCE).not.toContain(REACT_RAW_HTML_PROP);
    expect(LOCKUP_SOURCE).not.toMatch(/\bid=/);
  });
});
