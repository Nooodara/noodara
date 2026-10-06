'use client';

// 13-14: the inspector's chrome. A non-blocking panel (no overlay, no focus trap): focus moves into
// it on open, Escape or Close clears the selection from the URL and returns focus to whatever
// opened it (or to the main content when that is gone).
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@noodara/ui';

export interface InspectorFrameProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function InspectorFrame({ title, onClose, children }: InspectorFrameProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  function close(): void {
    const target = returnTo.current;
    onClose();
    if (target?.isConnected) target.focus();
    else document.getElementById('shell-main')?.focus();
  }

  return (
    <section
      ref={panelRef}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="inspector-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
      className="flex h-dvh flex-col bg-surface-1 outline-none min-[1280px]:sticky min-[1280px]:top-0 min-[1280px]:border-l min-[1280px]:border-hairline"
    >
      <header className="flex min-h-[52px] items-center gap-2 border-b border-hairline px-4">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-title font-semibold text-ink">
          {title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          aria-label="Close inspector"
          onClick={close}
          data-testid="inspector-close"
        >
          <X aria-hidden="true" size={16} strokeWidth={1.5} />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
