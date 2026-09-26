import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, DestructiveConfirmDialog } from './Dialog.js';
import { renderUi, screen, userEvent } from './testing/render.js';
import { useCloseSource } from './use-close-source.js';

// Mocks only the returned `closeSource` reading -- `noteProgrammaticClose` and every real
// capture-phase listener still come from the actual primitive underneath (never reimplemented
// here). This is the one thing jsdom can genuinely, synchronously observe about the
// keyboard-no-animation branch: while the panel is still open (no Radix Presence unmount race to
// lose the assertion to -- Presence unmounts synchronously in this environment the instant `open`
// goes false, since there is no compiled stylesheet loaded for it to detect a real transition on,
// the same limitation Sheet.test.tsx's own "adds a zero-duration override..." test already
// documents), the panel carries the override class the instant the recorded close source reads
// 'keyboard'. The real, only-honest proof that this actually suppresses a *rendered* transition on
// a genuine Escape-close is tests/e2e/keyboard-motion.spec.ts's real-browser measurement (Task 3).
vi.mock('./use-close-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-close-source.js')>();
  return { ...actual, useCloseSource: vi.fn(actual.useCloseSource) };
});

describe('DialogShell keyboard-no-animation branch (UI-05, §9 #10, P14)', () => {
  it('applies the zero-duration override to the panel while the recorded close source reads keyboard', () => {
    const mockedHook = vi.mocked(useCloseSource);
    const defaultImpl = mockedHook.getMockImplementation();
    mockedHook.mockImplementation((open, contentRef) => {
      const real = defaultImpl!(open, contentRef);
      return { ...real, closeSource: () => 'keyboard' as const };
    });

    try {
      renderUi(
        <ConfirmDialog
          open
          onOpenChange={vi.fn()}
          title="Re-run discovery?"
          body="Body text."
          confirmLabel="Re-run discovery"
          onConfirm={vi.fn()}
        />,
      );

      expect(screen.getByRole('dialog').className).toContain('!duration-0');
    } finally {
      mockedHook.mockImplementation(defaultImpl!);
    }
  });

  it('does not apply the override to the panel while the recorded close source is the default, programmatic reading', () => {
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog').className).not.toContain('!duration-0');
  });
  it('still dismisses ConfirmDialog via Escape once useCloseSource is wired into DialogShell', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={vi.fn()}
      />,
    );

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('still dismisses DestructiveConfirmDialog via Escape once useCloseSource is wired into DialogShell', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderUi(
      <DestructiveConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete srv-1?"
        body="This permanently deletes the server."
        confirmLabel="Delete server"
        requiredName="srv-1"
        onConfirm={vi.fn()}
      />,
    );

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('ConfirmDialog', () => {
  it('renders its title as the accessible name and its body as the description, with the confirm label and a ghost Cancel', () => {
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Re-run discovery?"
        body="This re-checks the server and may take a minute."
        confirmLabel="Re-run discovery"
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Re-run discovery?' });
    expect(screen.getByText('This re-checks the server and may take a minute.')).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription('This re-checks the server and may take a minute.');
    expect(screen.getByRole('button', { name: 'Re-run discovery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-variant', 'ghost');
  });

  // 08-06-PLAN.md Task 1 (UI-03, 08-UI-SPEC.md SS5.1/5.2): the shared DialogShell panel carries
  // the one allowlisted shadow and the solid (no /72) surface-elevated alias -- both
  // ConfirmDialog and DestructiveConfirmDialog inherit this from the same shell, so proving it
  // once here covers both variants.
  it('carries the floating shadow and solid bg-surface-elevated on the panel element', () => {
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={vi.fn()}
      />,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('shadow-[var(--shadow-floating)]');
    expect(panel.className).toContain('bg-surface-elevated');
    expect(panel.className).not.toContain('bg-surface-elevated/');
    expect(panel.className).not.toContain('bg-surface-1');
  });

  // 08-06-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): Dialog swaps to border-hairline-strong under
  // prefers-contrast: more, and declares no reduced-transparency override since it is already
  // solid (no translucency to drop).
  it('swaps to border-hairline-strong under prefers-contrast: more and declares no reduced-transparency override', () => {
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={vi.fn()}
      />,
    );

    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('contrast-more:border-hairline-strong');
    expect(panel.className).not.toContain('prefers-reduced-transparency');
  });

  it('invokes onConfirm exactly once when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Re-run discovery' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('invokes onOpenChange(false) and never onConfirm when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    renderUi(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Re-run discovery?"
        body="Body text."
        confirmLabel="Re-run discovery"
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('DestructiveConfirmDialog', () => {
  function renderDialog(props: Partial<Parameters<typeof DestructiveConfirmDialog>[0]> = {}) {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const result = renderUi(
      <DestructiveConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete srv-1?"
        body="This permanently deletes the server."
        confirmLabel="Delete server"
        requiredName="srv-1"
        onConfirm={onConfirm}
        {...props}
      />,
    );
    return { onConfirm, onOpenChange, container: result.container };
  }

  it('renders the confirm button disabled on open, before anything is typed', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Delete server' })).toBeDisabled();
  });

  it('enables confirm on the exact required name, then disables it again after deleting one character', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('textbox');
    const confirmButton = screen.getByRole('button', { name: 'Delete server' });

    expect(confirmButton).toBeDisabled();

    await user.type(input, 'srv-1');
    expect(confirmButton).toBeEnabled();

    await user.type(input, '{backspace}');
    expect(confirmButton).toBeDisabled();
  });

  it('leaves confirm disabled for a case-variant or whitespace-padded name', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByRole('textbox');
    const confirmButton = screen.getByRole('button', { name: 'Delete server' });

    await user.type(input, 'SRV-1');
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'srv-1 ');
    expect(confirmButton).toBeDisabled();
  });

  it('marks the confirm button destructive+filled and Cancel ghost, never destructive', () => {
    renderDialog();

    const confirmButton = screen.getByRole('button', { name: 'Delete server' });
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });

    expect(confirmButton).toHaveAttribute('data-variant', 'destructive');
    expect(confirmButton).toHaveAttribute('data-filled', 'true');
    expect(cancelButton).toHaveAttribute('data-variant', 'ghost');
  });

  it('calls onConfirm with the typed value exactly once when confirm is clicked after a match', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const input = screen.getByRole('textbox');

    await user.type(input, 'srv-1');
    await user.click(screen.getByRole('button', { name: 'Delete server' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('srv-1');
  });

  it('renders a supplied error string inside a role="alert" element in the input error position', () => {
    renderDialog({ error: 'That doesn\'t match. Type "srv-1" exactly to continue.' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('That doesn\'t match. Type "srv-1" exactly to continue.');
  });

  it('renders supplied children between the description and the type-the-name input (05-19-PLAN.md: repeated fingerprints above the confirm input)', () => {
    renderDialog({ children: <p data-testid="dialog-extra-content">Extra content</p> });

    expect(screen.getByTestId('dialog-extra-content')).toBeInTheDocument();
  });

  it('never echoes the typed confirmation value into any attribute other than the input value', async () => {
    const user = userEvent.setup();
    const { container } = renderDialog({ requiredName: 'zK9qLdistinctive' });
    const input = screen.getByRole('textbox');

    await user.type(input, 'zK9qLdistinctive');
    expect(input).toHaveValue('zK9qLdistinctive');

    const otherAttributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((attr) => !(el === input && attr.name === 'value'))
        .map((attr) => attr.value),
    );
    expect(otherAttributeValues.some((value) => value.includes('zK9qLdistinctive'))).toBe(false);
  });
});
