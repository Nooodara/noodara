// RED for Task 1 (08-05-PLAN.md) -- `InsetGroup.tsx` doesn't exist yet. Covers the macOS System
// Settings grouped-inset contract (D-01/D-02, 08-UI-SPEC.md §1): title outside the block, block
// surface/hairline/radius with no shadow, per-row hairline separators except the last, testid on
// the block element, no heading when title is omitted, and the documented (not runtime-guarded)
// no-nesting invariant.
import { describe, expect, it } from 'vitest';
import { InsetGroup } from './InsetGroup.js';
import { renderUi, screen } from './testing/render.js';

describe('InsetGroup', () => {
  it('renders the title as an h3 with the label classes, outside the block element', () => {
    renderUi(
      <InsetGroup title="System" data-testid="group">
        <div>Row 1</div>
      </InsetGroup>,
    );

    const heading = screen.getByRole('heading', { level: 3, name: 'System' });
    expect(heading.className).toMatch(/text-label/);
    expect(heading.className).toMatch(/uppercase/);
    expect(heading.className).toMatch(/text-ink-secondary/);

    const block = screen.getByTestId('group');
    expect(block.contains(heading)).toBe(false);
  });

  it('renders no heading element at all when title is omitted', () => {
    renderUi(
      <InsetGroup data-testid="group">
        <div>Row 1</div>
      </InsetGroup>,
    );

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('carries bg-surface-1, border, border-hairline and rounded-lg on the block element, and no shadow class', () => {
    renderUi(
      <InsetGroup data-testid="group">
        <div>Row 1</div>
      </InsetGroup>,
    );

    const block = screen.getByTestId('group');
    expect(block.className).toMatch(/bg-surface-1/);
    expect(block.className).toMatch(/\bborder\b/);
    expect(block.className).toMatch(/border-hairline/);
    expect(block.className).toMatch(/rounded-lg/);
    expect(block.className).not.toMatch(/shadow/);
  });

  it('separates every child except the last with a bottom hairline, the last carrying none', () => {
    renderUi(
      <InsetGroup data-testid="group">
        <div>Row 1</div>
        <div>Row 2</div>
        <div>Row 3</div>
      </InsetGroup>,
    );

    const block = screen.getByTestId('group');
    const rowWrappers = Array.from(block.children);
    expect(rowWrappers).toHaveLength(3);
    expect(rowWrappers[0]?.className).toMatch(/border-b/);
    expect(rowWrappers[1]?.className).toMatch(/border-b/);
    expect(rowWrappers[2]?.className).toMatch(/last:border-b-0/);
  });

  it('puts data-testid on the block element, so existing testids keep resolving to the same node role', () => {
    renderUi(
      <InsetGroup data-testid="server-facts-system">
        <div>Row 1</div>
      </InsetGroup>,
    );

    const block = screen.getByTestId('server-facts-system');
    expect(block).toHaveAttribute('data-inset-group', 'true');
  });

  // Documents (does not runtime-guard) the no-nesting invariant (§9 #5, this module's own header
  // comment): a nested InsetGroup is technically renderable -- there is no throw -- but is
  // prohibited by convention. No plan in this phase composes InsetGroup this way; this test only
  // proves the shape is renderable so the prohibition stays a documented, reviewable discipline
  // rather than a silent assumption.
  it('documents the no-nesting invariant: a nested InsetGroup renders (no runtime guard), which is why composing it this way is prohibited by convention instead', () => {
    renderUi(
      <InsetGroup title="Outer" data-testid="outer">
        <InsetGroup title="Inner" data-testid="inner">
          <div>Row</div>
        </InsetGroup>
      </InsetGroup>,
    );

    const outerBlock = screen.getByTestId('outer');
    const nestedOccurrences = outerBlock.querySelectorAll('[data-inset-group="true"]');
    expect(nestedOccurrences).toHaveLength(1);
  });
});
