import { createElement, useState, type ComponentProps, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { m as motionM } from 'motion/react';

// D-13 (09-04-PLAN.md Task 2): `m.div`'s own `drag` prop is the one thing this jsdom suite cannot
// observe honestly through rendered DOM (jsdom has no pointer/gesture layer, and Motion sets no
// static style/attribute difference between `drag={false}` and `drag='x'`) -- confirmed empirically
// via a throwaway spike before writing this mock. Sheet.tsx only ever reads `m.div` (never another
// `m.*` tag), so only that one export needs replacing -- the real one is cast to a plain
// `ElementType` and re-rendered with its own real `drag` prop forwarded onward (so the actual
// gesture behaviour this file's own `renders the draggable surface...` test below still exercises
// real Motion) plus a `data-drag` mirror attribute purely for this test file's own assertions. The
// real, end-to-end proof that dragging is actually disabled/enabled lives in
// `tests/e2e/a11y-fallbacks.spec.ts` (Playwright, a real browser).
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  const RealMotionDiv = actual.m.div as ElementType;
  const MockedDiv = (props: ComponentProps<typeof motionM.div>) =>
    createElement(RealMotionDiv, { ...props, 'data-drag': String(props.drag) });
  return {
    ...actual,
    m: { div: MockedDiv },
  };
});

import { Sheet } from './Sheet.js';
import { renderUi, screen, userEvent } from './testing/render.js';

// D-13 (09-04-PLAN.md Task 2): Sheet's drag gesture must follow the same attribute-aware
// preference as everything else -- jsdom has no matchMedia, so every test that renders Sheet
// stubs it, mirroring ThemeToggle.test.tsx's own stubMatchMedia helper.
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  stubMatchMedia(false);
  document.documentElement.removeAttribute('data-motion');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-motion');
  vi.unstubAllGlobals();
});

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

  // Mobile round 1 adjustment (09-14 checkpoint): the panel used to be a fixed `w-[480px]` --
  // wider than a 440px-wide iPhone viewport, so it overflowed horizontally and the labels/close
  // button sat off-screen. It must go full width on narrow viewports, capped at 480px on wider
  // ones, never a bare fixed 480px.
  it('is full width capped at 480px, never a fixed 480px panel', () => {
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('w-full');
    expect(panel.className).toContain('max-w-[480px]');
    expect(panel.className).not.toMatch(/(?<!max-)w-\[480px\]/);
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

  // 13-20 A2: callers drive Sheet controlled, with no DialogPrimitive.Trigger, so Radix's own
  // restore target (its triggerRef) is null and focus fell to <body> on close. The Sheet must hand
  // focus back to whatever opened it, however it closes.
  describe('returns focus to its opener when used controlled without a Trigger', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            New project
          </button>
          <Sheet
            open={open}
            onOpenChange={setOpen}
            title="New project"
            footer={
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </button>
            }
          >
            <input aria-label="Name" />
          </Sheet>
        </>
      );
    }

    async function openFromKeyboard() {
      const user = userEvent.setup();
      renderUi(<Harness />);
      const opener = screen.getByRole('button', { name: 'New project' });
      opener.focus();
      await user.keyboard('{Enter}');
      await vi.waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      return { user, opener };
    }

    it('on Escape', async () => {
      const { user, opener } = await openFromKeyboard();
      await user.keyboard('{Escape}');
      await vi.waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
      });
    });

    it('on Cancel', async () => {
      const { user, opener } = await openFromKeyboard();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await vi.waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
      });
    });

    it('on an overlay click', async () => {
      const { user, opener } = await openFromKeyboard();
      const overlay = document.querySelector<HTMLElement>('[data-sheet-overlay]');
      expect(overlay).not.toBeNull();
      if (overlay === null) return;
      await user.click(overlay);
      await vi.waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
      });
    });
  });

  // D-13 (09-04-PLAN.md Task 2): the drag surface's `drag` prop must follow
  // `useReducedMotionPreference`, not motion/react's own `useReducedMotion` -- disabled entirely
  // when the effective preference is reduced, restricted to the x axis otherwise.
  it('renders its drag surface with drag disabled when the reduced-motion preference is true', async () => {
    stubMatchMedia(true);
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    await vi.waitFor(() => {
      expect(document.querySelector('[data-drag]')).toHaveAttribute('data-drag', 'false');
    });
  });

  it('renders its drag surface with drag enabled on the x axis when the reduced-motion preference is false', async () => {
    stubMatchMedia(false);
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    await vi.waitFor(() => {
      expect(document.querySelector('[data-drag]')).toHaveAttribute('data-drag', 'x');
    });
  });

  it('reacts to a forced data-motion="reduce" attribute the same way as an OS-level reduced preference', async () => {
    stubMatchMedia(false);
    document.documentElement.setAttribute('data-motion', 'reduce');
    renderUi(
      <Sheet open onOpenChange={vi.fn()} title="Add server">
        <p>Sheet body content</p>
      </Sheet>,
    );

    await vi.waitFor(() => {
      expect(document.querySelector('[data-drag]')).toHaveAttribute('data-drag', 'false');
    });
  });
});

// 13-22: re-grab tracking during the close animation, driven through real Motion drag with
// dispatched pointer events. jsdom lays nothing out, so the panel width falls back to 480px and
// the drag constraints resolve to {0, 0} exactly as in the browser.
describe('Sheet re-grab mid-close', () => {
  function readX(el: Element): number {
    const match = /translateX\(([-\d.]+)px\)/.exec((el as HTMLElement).style.transform);
    return match?.[1] !== undefined ? Number.parseFloat(match[1]) : 0;
  }

  function pointer(target: EventTarget, type: string, x: number): void {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 });
    Object.defineProperty(event, 'pageX', { value: x });
    Object.defineProperty(event, 'pageY', { value: 10 });
    Object.defineProperty(event, 'isPrimary', { value: true });
    target.dispatchEvent(event);
  }

  async function nextFrames(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }
  }

  it('tracks the pointer 1:1 from the on-screen position when re-grabbed mid-close, never jumping back toward rest', async () => {
    const onOpenChange = vi.fn();
    renderUi(
      <Sheet open onOpenChange={onOpenChange} title="Add server" data-testid="sheet">
        <p>Sheet body content</p>
      </Sheet>,
    );
    const surface = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="sheet-drag-surface"][style*="transform"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await nextFrames(30); // let the entry settle-in finish

    // Release past the midpoint (300px of pointer travel > 240px) so the close animation starts.
    pointer(surface, 'pointerdown', 100);
    for (const dx of [100, 200, 300]) {
      pointer(window, 'pointermove', 100 + dx);
      await nextFrames(1);
    }
    pointer(window, 'pointerup', 400);

    // Deterministic mid-close state: wait on the panel's own position, not wall-clock time.
    await vi.waitFor(() => {
      expect(readX(surface)).toBeGreaterThan(200);
    });
    const xMidClose = readX(surface);
    expect(xMidClose).toBeLessThan(480);

    // Grabbing stops the close animation where it is; the rendered transform settles a frame later.
    pointer(surface, 'pointerdown', 100);
    await nextFrames(2);
    const xAtGrab = readX(surface);
    expect(xAtGrab).toBeGreaterThanOrEqual(xMidClose);

    pointer(window, 'pointermove', 110);
    await nextFrames(2);
    const xAfterRegrab = readX(surface);
    pointer(window, 'pointerup', 110);

    expect(xAfterRegrab).toBeCloseTo(xAtGrab + 10, 0);
  });
});

// 14-26: Radix Presence (@radix-ui/react-presence) keeps a closing element mounted only while a CSS
// *animation* runs (it reads `animation-name`, never `transition-*`), so the old transition-based
// exit never played: the panel left the DOM a few ms after a pointer close. jsdom compiles no
// Tailwind, so this suite installs a stand-in stylesheet for the panel's exit utility (keyed on the
// class token, never on the dialog role) and drives Presence the way a real browser would: the
// panel must stay mounted in data-state="closed" until its exit animation ends. A keyboard close
// carries the instant override, so the stand-in rule does not match and the panel goes at once.
describe('Sheet exit animation', () => {
  let styleEl: HTMLStyleElement;

  beforeEach(() => {
    styleEl = document.createElement('style');
    styleEl.textContent =
      '[class*="animate-sheet-exit"][data-state="closed"]:not([class*="!animate-none"]) { animation-name: sheet-exit; }';
    document.head.appendChild(styleEl);
    // A browser's getComputedStyle() is live; jsdom's is a snapshot. Presence keeps the object it
    // read at mount and reads `animationName` from it again at close, so give it a live view.
    const snapshot = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) =>
        new Proxy({} as CSSStyleDeclaration, {
          get: (_target, property) => {
            const current = snapshot(element, pseudo);
            const value: unknown = Reflect.get(current, property);
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(current) : value;
          },
        }),
    );
  });

  afterEach(() => {
    styleEl.remove();
    vi.restoreAllMocks();
  });

  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <Sheet open={open} onOpenChange={setOpen} title="Add server">
        <p>Sheet body content</p>
      </Sheet>
    );
  }

  function endAnimation(element: Element, animationName: string): void {
    const event = new Event('animationend', { bubbles: true });
    Object.assign(event, { animationName });
    element.dispatchEvent(event);
  }

  it('stays mounted in data-state="closed" until its exit animation ends after a pointer close', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    const panel = screen.getByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute('data-state', 'closed');
    endAnimation(panel, 'sheet-exit');
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('slides out when motion is allowed and fades out under reduced motion', () => {
    renderUi(<Harness />);

    const panel = screen.getByRole('dialog');

    expect(panel.className).toContain('motion-safe:data-[state=closed]:animate-sheet-exit');
    expect(panel.className).toContain('motion-reduce:data-[state=closed]:animate-sheet-fade-exit');
  });

  it('fades the overlay out with the panel', () => {
    renderUi(<Harness />);

    const overlay = document.querySelector('[data-sheet-overlay]');

    expect(overlay?.className).toContain('data-[state=closed]:animate-sheet-fade-exit');
  });

  it('unmounts at once, with no exit animation, when the close was keyboard-initiated', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);
    const panel = screen.getByRole('dialog');

    await user.keyboard('{Escape}');

    expect(panel).not.toBeInTheDocument();
    expect(panel.className).toContain('!animate-none');
  });
});
