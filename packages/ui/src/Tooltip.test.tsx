import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
import { Tooltip, TooltipProvider } from './Tooltip.js';
import { renderUi, screen, userEvent, waitFor } from './testing/render.js';

// 08-14-PLAN.md Task 2 (UI-07, 08-UI-SPEC.md §7.2 Tooltip row): spies only on the real
// `@radix-ui/react-tooltip` Provider's own received props -- every other export (Root, Trigger,
// Portal, Content) stays the genuine primitive, never reimplemented here. This is the one thing
// jsdom can genuinely, synchronously observe about the "second hover in a session opens instantly"
// mechanism: `skipDelayDuration` is Radix's own internal timer field, with no DOM effect this
// environment can otherwise assert on directly (mirrors RowMenu/AccountMenu/Dialog.test.tsx's own
// closeSource-mock precedent, 08-20, for the identical "assert what the real primitive receives"
// reason).
vi.mock('@radix-ui/react-tooltip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@radix-ui/react-tooltip')>();
  return { ...actual, Provider: vi.fn(actual.Provider) };
});

describe('Tooltip', () => {
  it('renders its trigger child', () => {
    renderUi(
      <Tooltip content="Full detail">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Trigger' })).toBeInTheDocument();
  });

  it('associates its content with the trigger through the primitive\'s own ARIA wiring once opened via hover', async () => {
    const user = userEvent.setup();
    renderUi(
      <Tooltip content="Full detail">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Trigger' });
    expect(trigger).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.hover(trigger);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Full detail');
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
  });

  it('closes on Escape, proving the primitive\'s own dismiss behaviour is untouched', async () => {
    const user = userEvent.setup();
    renderUi(
      <Tooltip content="Full detail">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    await user.hover(screen.getByRole('button', { name: 'Trigger' }));
    await screen.findByRole('tooltip');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  it('supports a controlled open prop, so a caller can force its content visible', () => {
    renderUi(
      <Tooltip content="Copied" open>
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    expect(screen.getByRole('tooltip')).toHaveTextContent('Copied');
  });

  // 08-14-PLAN.md Task 1 (UI-07, 08-UI-SPEC.md §7.2/§7.4): the content grows from the trigger,
  // reading Radix's own Popper-provided transform-origin variable rather than a hardcoded corner
  // -- RowMenu/AccountMenu do not have this variable available (no Popper underneath), Tooltip
  // does.
  it('anchors its transform-origin to the trigger via the Popper-provided variable, at 125ms --ease-out', () => {
    renderUi(
      <Tooltip content="Full detail" open>
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    const content = screen.getByRole('tooltip').className;
    expect(content).toContain('origin-[var(--radix-tooltip-content-transform-origin)]');
    expect(content).toContain('motion-safe:duration-[125ms]');
    expect(content).toContain('motion-safe:ease-[var(--ease-out)]');
    expect(content).not.toContain('scale-[0]');
  });

  // 08-14-PLAN.md Task 2 (UI-07, 08-UI-SPEC.md §7.2): a second hover within the skip-delay window
  // must not re-wait the full delayDuration -- Radix's own Provider carries this as
  // `skipDelayDuration`, which this component now sets a documented, explicit default for
  // (rather than leaving the caller to rely on an unstated library default).
  it('defaults skipDelayDuration on the provider so a repeat hover within one session opens instantly', () => {
    renderUi(
      <Tooltip content="Full detail">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    const providerMock = vi.mocked(TooltipPrimitive.Provider);
    const lastCallProps = providerMock.mock.calls.at(-1)?.[0];
    expect(lastCallProps?.skipDelayDuration).toEqual(expect.any(Number));
  });

  it('lets a caller override the default skipDelayDuration explicitly', () => {
    renderUi(
      <TooltipProvider skipDelayDuration={0}>
        <Tooltip content="Full detail">
          <button type="button">Trigger</button>
        </Tooltip>
      </TooltipProvider>,
    );

    const providerMock = vi.mocked(TooltipPrimitive.Provider);
    const lastCallProps = providerMock.mock.calls.at(-1)?.[0];
    expect(lastCallProps?.skipDelayDuration).toBe(0);
  });
});
