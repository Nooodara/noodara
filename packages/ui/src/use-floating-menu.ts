import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useCloseSource, type CloseSource } from './use-close-source.js';

export interface UseFloatingMenuResult {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly handleContentKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly handleOpenAutoFocus: (event: Event) => void;
  readonly selectItem: (onSelect: () => void) => () => void;
  readonly closeSource: () => CloseSource;
}

// useFloatingMenu (08-04-PLAN.md Task 1, 08-UI-SPEC.md SS4.4) -- the one floating-menu shell
// `RowMenu` and `AccountMenu` (08-08) both build on, so a second hand-rolled dismiss/focus
// implementation never exists in this codebase. Radix's non-modal Dialog foundation already gives
// every consumer three behaviours for free: Esc-close, outside-click-close and close-to-trigger
// focus return -- this hook owns exactly the behaviour Radix does not provide for a WAI-ARIA menu:
// arrow-key roving focus between items (`handleContentKeyDown`, lifted from `RowMenu`'s own prior
// implementation) and where the initial focus lands on open (`handleOpenAutoFocus`).
//
// Close-source tracking (was this dismissal keyboard-, pointer- or code-driven?) is delegated to
// the shared close-source primitive, not duplicated here -- this file attaches no document-level
// listener of its own; `closeSource` below is that primitive's own return value, re-exposed
// unchanged.
export function useFloatingMenu(): UseFloatingMenuResult {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { closeSource, noteProgrammaticClose } = useCloseSource(open, contentRef);

  function menuItemNodes(): HTMLButtonElement[] {
    return Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  }

  function handleContentKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const nodes = menuItemNodes();
    if (nodes.length === 0) {
      return;
    }
    const currentIndex = nodes.findIndex((node) => node === document.activeElement);

    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % nodes.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? nodes.length - 1 : currentIndex - 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = nodes.length - 1;
    }

    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    nodes[nextIndex]?.focus();
  }

  function handleOpenAutoFocus(event: Event): void {
    event.preventDefault();
    menuItemNodes()[0]?.focus();
  }

  function selectItem(onSelect: () => void): () => void {
    return () => {
      onSelect();
      noteProgrammaticClose();
      setOpen(false);
    };
  }

  return { open, setOpen, contentRef, handleContentKeyDown, handleOpenAutoFocus, selectItem, closeSource };
}
