import { describe, expect, it, vi } from 'vitest';
import { Disclosure } from './Disclosure.js';
import { renderUi, screen, userEvent } from './testing/render.js';

describe('Disclosure', () => {
  it('does not render the content text before the trigger is activated (absent, not merely hidden)', () => {
    renderUi(
      <Disclosure title="Advanced">
        <p>Master key fingerprint</p>
      </Disclosure>,
    );

    expect(screen.queryByText('Master key fingerprint')).toBeNull();
  });

  it('carries aria-expanded="false" when collapsed, supplied by the primitive', () => {
    renderUi(
      <Disclosure title="Advanced">
        <p>Master key fingerprint</p>
      </Disclosure>,
    );

    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('carries aria-expanded="true" once expanded', async () => {
    const user = userEvent.setup();
    renderUi(
      <Disclosure title="Advanced">
        <p>Master key fingerprint</p>
      </Disclosure>,
    );

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('reveals content on click and hides it again on a second click -- a full open/close cycle', async () => {
    const user = userEvent.setup();
    renderUi(
      <Disclosure title="Advanced">
        <p>Master key fingerprint</p>
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'Advanced' });

    await user.click(trigger);
    expect(screen.getByText('Master key fingerprint')).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByText('Master key fingerprint')).toBeNull();
  });

  it('toggles on a keyboard Enter activation, proving the trigger is a real button', async () => {
    const user = userEvent.setup();
    renderUi(
      <Disclosure title="Advanced">
        <p>Master key fingerprint</p>
      </Disclosure>,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('Master key fingerprint')).toBeInTheDocument();
  });

  it('renders expanded on first paint when defaultOpen is set', () => {
    renderUi(
      <Disclosure title="Discovery" defaultOpen>
        <p>Discovered facts</p>
      </Disclosure>,
    );

    expect(screen.getByText('Discovered facts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discovery' })).toHaveAttribute('aria-expanded', 'true');
  });

  // 08-14-PLAN.md Task 2 (UI-07, 08-UI-SPEC.md §7.2/§7.4, §9 #11): interpolates a grid track,
  // never an animated `height`/`max-height` -- content of unknown height expands with no
  // JS measurement.
  it('interpolates grid-template-rows between 0fr and 1fr, gated motion-safe, never an animated height', async () => {
    const user = userEvent.setup();
    renderUi(
      <Disclosure title="Advanced">
        <p>Master key fingerprint</p>
      </Disclosure>,
    );

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    const content = screen.getByText('Master key fingerprint').closest('[data-state]');
    expect(content).not.toBeNull();
    const className = content?.className ?? '';
    expect(className).toContain('grid-rows-[0fr]');
    expect(className).toContain('grid-rows-[1fr]');
    expect(className).toContain('motion-safe:duration-[var(--duration-panel)]');
    expect(className).toContain('motion-safe:ease-[var(--ease-out)]');
    expect(className).not.toMatch(/transition-\[height\]|max-h-\[/);
  });

  it('clips its inner content with min-h-0 overflow-hidden so the fractional track actually hides overflow', async () => {
    const user = userEvent.setup();
    renderUi(
      <Disclosure title="Advanced">
        <p>Master key fingerprint</p>
      </Disclosure>,
    );

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    const paragraph = screen.getByText('Master key fingerprint');
    const inner = paragraph.parentElement;
    expect(inner?.className).toContain('min-h-0');
    expect(inner?.className).toContain('overflow-hidden');
  });

  it('never mounts collapsed children -- a child component only renders once first opened', async () => {
    const user = userEvent.setup();
    const onRender = vi.fn();
    function Probe() {
      onRender();
      return <p>probed</p>;
    }
    renderUi(
      <Disclosure title="Advanced">
        <Probe />
      </Disclosure>,
    );

    expect(onRender).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(onRender).toHaveBeenCalledTimes(1);
  });
});
