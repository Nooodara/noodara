import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './CopyButton.js';
import { renderUi, screen, userEvent, waitFor } from './testing/render.js';

// navigator.clipboard is not implemented in jsdom (ADR-0005 / this plan's own read_first note) --
// every test stubs `writeText` directly on `navigator.clipboard` rather than asserting against a
// real clipboard.
function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  // @ts-expect-error -- reset the test-only stub between tests, jsdom's real navigator has no clipboard
  delete navigator.clipboard;
});

describe('CopyButton', () => {
  it('invokes navigator.clipboard.writeText exactly once with exactly the value prop', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderUi(<CopyButton value="a1:b2:c3:d4" />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('a1:b2:c3:d4');
  });

  it('has a real accessible name, not an unlabelled icon-only control', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderUi(<CopyButton value="a1:b2:c3:d4" label="Copy fingerprint" />);

    expect(screen.getByRole('button', { name: 'Copy fingerprint' })).toBeInTheDocument();
  });

  it('renders no confirmation before the click, and a transient "Copied" confirmation after a successful copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderUi(<CopyButton value="a1:b2:c3:d4" />);

    expect(screen.queryByText('Copied')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });
  });

  it('neither throws nor renders a confirmation nor logs anything when writeText rejects', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    stubClipboard(writeText);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      renderUi(<CopyButton value="a1:b2:c3:d4" />);

      await expect(user.click(screen.getByRole('button', { name: 'Copy' }))).resolves.not.toThrow();

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText('Copied')).not.toBeInTheDocument();
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  // T-5G-28-02 (05-28-PLAN.md): Noodara's own explicitly supported v0.1 deployment mode is plain
  // HTTP, an insecure context where `navigator.clipboard` is `undefined` -- jsdom's default state
  // (no stub applied) reproduces exactly that. The pre-fix `handleClick` dereferenced
  // `navigator.clipboard.writeText` directly, throwing a synchronous TypeError before `.catch`
  // could ever attach; that throw is this test's RED evidence.
  it('neither throws nor renders a confirmation nor logs anything when navigator.clipboard is undefined (insecure context / missing API)', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      // Force the missing-API condition regardless of whatever jsdom's shared environment may
      // have already cached on `navigator` from an earlier test in this file/worker.
      // @ts-expect-error -- test-only removal, see this file's top-of-file comment
      delete navigator.clipboard;
      expect(navigator.clipboard).toBeUndefined();
      renderUi(<CopyButton value="a1:b2:c3:d4" />);

      await expect(user.click(screen.getByRole('button', { name: 'Copy' }))).resolves.not.toThrow();

      expect(screen.queryByText('Copied')).not.toBeInTheDocument();
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('never renders the value prop in any DOM attribute -- it only ever reaches the clipboard call', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const distinctiveValue = 'zK9qL-distinctive-fingerprint-value';
    const { container } = renderUi(<CopyButton value={distinctiveValue} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(distinctiveValue);
    });

    const attributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes).map((attr) => attr.value),
    );
    expect(attributeValues.some((value) => value.includes(distinctiveValue))).toBe(false);
  });

  it('clears its confirmation timer on unmount instead of leaking a pending state update', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { unmount } = renderUi(<CopyButton value="a1:b2:c3:d4" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
