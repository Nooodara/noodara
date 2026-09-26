import { useEffect, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from './testing/render.js';
import { useCloseSource, type CloseSource } from './use-close-source.js';

// Shared inner harness: identical markup and behaviour regardless of whether `open` lives in this
// component's own state or is handed down as a prop -- this is what proves the controlled/
// uncontrolled parity 08-04-PLAN.md Task 1 asks for, rather than assuming it. `useCloseSource`
// itself never decides how or when `open` actually flips -- that stays this harness's own job
// (mirroring how Radix's real dismiss handling, not this primitive, performs the actual close),
// exactly like the primitive's own header comment describes.
function OverlayBody({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { closeSource, noteProgrammaticClose } = useCloseSource(open, contentRef);
  const [reading, setReading] = useState<CloseSource | 'none'>('none');

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    }

    function handlePointerDown(event: PointerEvent): void {
      const content = contentRef.current;
      if (content !== null && event.target instanceof Node && !content.contains(event.target)) {
        onOpenChange(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open, onOpenChange]);

  return (
    <div>
      <button type="button" onClick={() => onOpenChange(true)}>
        Open
      </button>
      {open && (
        <div ref={contentRef} data-testid="content">
          <button
            type="button"
            onClick={() => {
              noteProgrammaticClose();
              onOpenChange(false);
            }}
          >
            Select
          </button>
        </div>
      )}
      <button type="button" onClick={() => setReading(closeSource())}>
        Read
      </button>
      <div data-testid="reading">{reading}</div>
      <button type="button">Outside</button>
    </div>
  );
}

function UncontrolledOverlay() {
  const [open, setOpen] = useState(false);
  return <OverlayBody open={open} onOpenChange={setOpen} />;
}

function ControlledOverlay({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return <OverlayBody open={open} onOpenChange={onOpenChange} />;
}

function ControlledHost() {
  const [open, setOpen] = useState(false);
  return <ControlledOverlay open={open} onOpenChange={setOpen} />;
}

describe.each([
  ['an uncontrolled consumer (its own state)', UncontrolledOverlay],
  ['a controlled consumer (open supplied as a prop)', ControlledHost],
])('useCloseSource with %s', (_label, Harness) => {
  it('reads "keyboard" after a close initiated by Escape', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Read' }));

    expect(screen.getByTestId('reading')).toHaveTextContent('keyboard');
  });

  it('reads "pointer" after a close initiated by a pointer press outside the content element', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    await user.click(screen.getByRole('button', { name: 'Read' }));

    expect(screen.getByTestId('reading')).toHaveTextContent('pointer');
  });

  it('reads "programmatic" after noteProgrammaticClose is called', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Read' }));

    expect(screen.getByTestId('reading')).toHaveTextContent('programmatic');
  });

  it('resets the reading to "programmatic" on every re-open, so a stale source never leaks', async () => {
    const user = userEvent.setup();
    renderUi(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Read' }));
    expect(screen.getByTestId('reading')).toHaveTextContent('keyboard');

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Read' }));

    expect(screen.getByTestId('reading')).toHaveTextContent('programmatic');
  });
});

describe('useCloseSource document listener lifecycle', () => {
  it('attaches no document listener while open is false', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    renderUi(<UncontrolledOverlay />);

    expect(addSpy).not.toHaveBeenCalledWith('keydown', expect.anything(), true);
    expect(addSpy).not.toHaveBeenCalledWith('pointerdown', expect.anything(), true);

    addSpy.mockRestore();
  });

  it('removes both listeners when unmounted while open', async () => {
    const user = userEvent.setup();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderUi(<UncontrolledOverlay />);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.anything(), true);
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.anything(), true);

    removeSpy.mockRestore();
  });
});
