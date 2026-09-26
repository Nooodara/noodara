import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet.js';
import { renderUi, screen, userEvent } from './testing/render.js';

// Real focus trapping, Esc-to-close and outside-click dismissal are Radix Dialog's own built-in
// behaviour (05-UI-SPEC.md SS8, "Radix traps focus and closes on Esc -- do not override it") and
// are verified end to end by Plan 05-17's `@sheet` Playwright spec, not here -- jsdom does not
// implement the layout/focus mechanics Radix's FocusScope depends on, so a jsdom-only test
// asserting them would be dishonest about what it actually proves.

describe('Sheet', () => {
  it('renders nothing from its content when closed -- absent, not merely hidden', () => {
    renderUi(
      <Sheet open={false} onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Sheet body content')).not.toBeInTheDocument();
  });

  it('renders its content inside a dialog whose accessible name is the title prop when open', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.getByRole('dialog', { name: 'Add server' })).toBeInTheDocument();
  });

  it('renders the body children and the footer the caller composes', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server" footer={<button type="button">Save</button>}>
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.getByText('Sheet body content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('invokes onOpenChange(false) exactly once when the close affordance is clicked, never managing open itself', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderUi(
      <Sheet open onOpenChange={onOpenChange} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('forwards data-testid to the content element', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server" data-testid="add-server-sheet">
        <p>Sheet body content</p>
      </Sheet>,
    );

    expect(screen.getByTestId('add-server-sheet')).toBe(screen.getByRole('dialog'));
  });

  // 08-06-PLAN.md Task 1 (UI-03, 08-UI-SPEC.md SS5.1/5.2): the panel carries the one allowlisted
  // shadow and the surface-elevated alias -- light is byte-identical to before (surface-elevated
  // resolves to surface-1 in light), dark resolves one step lighter (surface-2).
  it('carries the floating shadow and bg-surface-elevated/72 on the panel element', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('shadow-[var(--shadow-floating)]');
    expect(panel.className).toContain('bg-surface-elevated/72');
    expect(panel.className).not.toContain('bg-surface-1/72');
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): prefers-reduced-transparency drops the
  // Sheet's translucency and blur entirely -- fully opaque background, no backdrop-filter.
  it('drops to a solid bg-surface-elevated and disables backdrop-filter under prefers-reduced-transparency', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('[@media(prefers-reduced-transparency:reduce)]:bg-surface-elevated');
    expect(panel.className).toContain('[@media(prefers-reduced-transparency:reduce)]:[backdrop-filter:none]');
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): prefers-contrast: more swaps the hairline
  // for the strong variant and pushes the translucent background toward fully opaque.
  it('swaps to border-hairline-strong and a fully opaque background under prefers-contrast: more', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('contrast-more:border-hairline-strong');
    expect(panel.className).toContain('contrast-more:bg-surface-elevated');
  });

  // 08-12-PLAN.md Task 2 (D19, UI-06): `strict` mode is what makes any accidental `motion.*`
  // usage elsewhere in the tree throw at runtime -- this is a static, jsdom-honest check of the
  // rendered tree's presence, not of Motion's private drag physics (that belongs to task 3's
  // Playwright suite). Motion's DOM components own the `transform` half of the `style` attribute
  // on the node they control -- even at rest, `x`'s default `MotionValue` renders as
  // `transform: translateX(0px)` (or an equivalent identity form) -- which a bare `div` (Radix's
  // Content only ever sets `pointer-events`, confirmed by reading the pre-motion DOM output)
  // never gets on its own. `getAttribute('style')` (not `hasAttribute`) is required: Radix's
  // Content already sets a `pointer-events` inline style regardless, so presence-of-any-style is
  // not a genuine signal -- the transform substring specifically is.
  it('renders the draggable surface as a real Motion element, not a bare div, inside the panel', async () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    // `LazyMotion`'s `features` loader is a genuine dynamic `import()` (D19, T-08-33) -- it
    // resolves on a microtask after this component's first render, not synchronously, so the
    // Motion-controlled `transform` style is not yet present on the very first render pass.
    await vi.waitFor(() => {
      expect(panel.querySelector('[style*="transform"]')).not.toBeNull();
    });
  });

  // 08-12-PLAN.md Task 2 (D19): the feature loader is the lazy `import()` form, not a
  // synchronously-imported `domMax` bundled into the initial chunk -- T-08-33's "domMax loaded
  // lazily" mitigation. This is a source-shape assertion (the file this module actually imports
  // from), verified once via a dynamic import of the real module rather than re-parsing
  // Sheet.tsx's source text.
  it('resolves its LazyMotion features from ./motion-features.js, not a synchronous domMax import', async () => {
    const featuresModule = await import('./motion-features.js');
    expect(featuresModule.default).toBeDefined();
  });

  // 08-12-PLAN.md Task 2 (brief §9 #10, 08-UI-SPEC.md §7.3): an Esc-initiated close must play no
  // animation at all. jsdom cannot verify the *rendered* absence of a transition (no real CSS is
  // resolved here), so this asserts the one thing jsdom honestly can: once `useCloseSource`
  // reports the close as keyboard-initiated, the panel's className carries the override that
  // zeroes its transition duration, instead of the normal animated-close class list.
  it('adds a zero-duration override to the panel when the close was keyboard-initiated', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Sheet open={open} onOpenChange={setOpen} title="Add server">
          <p>Sheet body content</p>
        </Sheet>
      );
    }
    renderUi(<Harness />);

    await user.keyboard('{Escape}');

    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
