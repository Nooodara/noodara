import { useEffect, useRef, type RefObject } from 'react';

export type CloseSource = 'keyboard' | 'pointer' | 'programmatic';

export interface UseCloseSourceResult {
  readonly closeSource: () => CloseSource;
  readonly noteProgrammaticClose: () => void;
}

// useCloseSource (08-04-PLAN.md Task 1, 08-UI-SPEC.md SS6.2, research Pitfall 14) -- the only
// keyboard-vs-pointer close-source tracker in this codebase. A component reaching for its own
// capture-phase keydown/pointerdown pair to make this same distinction is a bug: this hook is the
// single place that decision is made, and every overlay (RowMenu today, AccountMenu/Sheet/Dialog
// later) reads it through the same two-function return shape.
//
// It takes `open` as a plain argument instead of owning it internally -- `Sheet` (08-12) and
// `Dialog` (08-20) are externally controlled through an `open`/`onOpenChange` prop pair and
// cannot consume a hook that owns its own open state; a stateful menu (`useFloatingMenu`) and a
// controlled overlay both call this exact same primitive, unchanged.
//
// This is deliberately NOT built on Radix's own escape/outside-dismiss override props -- the
// repo's pre-existing static UI-safety gate expects zero occurrences of those two props anywhere,
// and reaching for them here would also risk weakening Radix's own dismiss behaviour (Esc-close,
// outside-click-close, close-to-trigger focus return), which this phase deliberately keeps
// working for free. Instead, two native capture-phase listeners on `document` -- which run ahead
// of Radix's own bubble-phase handling -- only ever record which kind of interaction happened.
// Neither one suppresses the browser's default action or halts the event's own journey to every
// other listener still waiting for it, so Radix's real dismissal always still fires afterward,
// completely untouched.
export function useCloseSource(open: boolean, contentRef: RefObject<HTMLElement | null>): UseCloseSourceResult {
  const sourceRef = useRef<CloseSource>('programmatic');

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    // Every transition into `open` starts from a clean slate -- a source recorded during a
    // previous open/close cycle must never leak into this one.
    sourceRef.current = 'programmatic';

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        sourceRef.current = 'keyboard';
      }
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      const content = contentRef.current;
      if (content !== null && target instanceof Node && !content.contains(target)) {
        sourceRef.current = 'pointer';
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, contentRef]);

  return {
    closeSource: () => sourceRef.current,
    noteProgrammaticClose: () => {
      sourceRef.current = 'programmatic';
    },
  };
}
