import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileButton } from './FileButton.js';
import { renderUi, screen, userEvent, waitFor } from './testing/render.js';

function findFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('expected a file input to be rendered');
  }
  return input;
}

describe('FileButton', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('renders a button whose accessible name defaults to "Choose file"', () => {
    renderUi(<FileButton onText={vi.fn()} onError={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Choose file' })).toBeInTheDocument();
  });

  it('renders a button whose accessible name is the label prop', () => {
    renderUi(<FileButton label="Load private key" onText={vi.fn()} onError={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Load private key' })).toBeInTheDocument();
  });

  it('renders a file input visually hidden from sighted users via the clip technique', () => {
    const { container } = renderUi(<FileButton onText={vi.fn()} onError={vi.fn()} />);
    const input = findFileInput(container);

    expect(input.parentElement).toHaveStyle({ position: 'absolute', clip: 'rect(0, 0, 0, 0)' });
  });

  it('forwards the accept prop to the file input', () => {
    const { container } = renderUi(<FileButton accept=".pem,.key" onText={vi.fn()} onError={vi.fn()} />);

    expect(findFileInput(container)).toHaveAttribute('accept', '.pem,.key');
  });

  it('invokes onText exactly once with the exact file contents on selection', async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    const fakeKeyText =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key-zK9qL\n-----END OPENSSH PRIVATE KEY-----';
    const file = new File([fakeKeyText], 'id_ed25519', { type: 'text/plain' });
    const { container } = renderUi(<FileButton onText={onText} onError={vi.fn()} />);

    await user.upload(findFileInput(container), file);

    await waitFor(() => {
      expect(onText).toHaveBeenCalledTimes(1);
    });
    expect(onText).toHaveBeenCalledWith(fakeKeyText);
  });

  it('never writes the file contents to storage or any other rendered attribute', async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    const fakeKeyText = 'zK9qLdistinctive-fake-key-body';
    const file = new File([fakeKeyText], 'id_ed25519', { type: 'text/plain' });
    const { container } = renderUi(<FileButton onText={onText} onError={vi.fn()} />);

    await user.upload(findFileInput(container), file);
    await waitFor(() => {
      expect(onText).toHaveBeenCalledTimes(1);
    });

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const value = key === null ? '' : (localStorage.getItem(key) ?? '');
      expect(value).not.toContain(fakeKeyText);
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      const value = key === null ? '' : (sessionStorage.getItem(key) ?? '');
      expect(value).not.toContain(fakeKeyText);
    }

    const attributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes).map((attr) => attr.value),
    );
    expect(attributeValues.some((value) => value.includes(fakeKeyText))).toBe(false);
  });

  it('fires onText twice when the same file is selected twice, proving the input value resets', async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    const file = new File(['same-fake-key-body'], 'id_ed25519', { type: 'text/plain' });
    const { container } = renderUi(<FileButton onText={onText} onError={vi.fn()} />);
    const input = findFileInput(container);

    await user.upload(input, file);
    await waitFor(() => {
      expect(onText).toHaveBeenCalledTimes(1);
    });

    await user.upload(input, file);
    await waitFor(() => {
      expect(onText).toHaveBeenCalledTimes(2);
    });
  });

  it('rejects a file over the size cap with a fixed message, never reading its contents (05-17-PLAN.md security item 4)', async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    const onError = vi.fn();
    // A private key is a few KB at most (even RSA-4096) -- this exceeds the component's own cap
    // by one byte, proving the boundary is enforced rather than a loose approximation.
    const oversized = new File([new Uint8Array(64 * 1024 + 1)], 'too-big.pem', { type: 'text/plain' });
    const { container } = renderUi(<FileButton onText={onText} onError={onError} />);

    await user.upload(findFileInput(container), oversized);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(onText).not.toHaveBeenCalled();
    const [message] = onError.mock.calls[0] as [string];
    expect(message.toLowerCase()).toContain('too large');
  });

  it('accepts a file at exactly the size cap', async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    const onError = vi.fn();
    const atCap = new File([new Uint8Array(64 * 1024)], 'exactly-at-cap.pem', { type: 'text/plain' });
    const { container } = renderUi(<FileButton onText={onText} onError={onError} />);

    await user.upload(findFileInput(container), atCap);

    await waitFor(() => {
      expect(onText).toHaveBeenCalledTimes(1);
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('invokes onError with a fixed generic message on a failing read, never the raw error or file contents', async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    const onError = vi.fn();
    const fakeKeyText = 'zK9qL-should-never-reach-onError';
    const readAsTextSpy = vi
      .spyOn(FileReader.prototype, 'readAsText')
      .mockImplementation(function readAsTextMock(this: FileReader) {
        this.onerror?.(new ProgressEvent('error') as unknown as ProgressEvent<FileReader>);
      });

    try {
      const file = new File([fakeKeyText], 'id_ed25519', { type: 'text/plain' });
      const { container } = renderUi(<FileButton onText={onText} onError={onError} />);

      await user.upload(findFileInput(container), file);

      await waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });
      expect(onText).not.toHaveBeenCalled();

      const [message] = onError.mock.calls[0] as [string];
      expect(typeof message).toBe('string');
      expect(message).not.toContain(fakeKeyText);
      expect(message.toLowerCase()).not.toContain('progressevent');
    } finally {
      readAsTextSpy.mockRestore();
    }
  });
});
