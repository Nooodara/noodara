'use client';

// 10-12-PLAN.md Round 1 (D-02a), reordered/resized in the orchestrator's Round 1 review batch
// (item 3). "Comprehensive control" tabbed tour over the six approved captures. A native tab
// pattern: role="tablist" of role="tab" buttons, aria-selected + roving tabIndex, ArrowLeft/
// ArrowRight (wrapping) to move selection -- no external tabs library (Radix/Base UI are not
// used anywhere in this repo, UI-SPEC "Component library: None").
//
// Tab order is by visual density/strength, not APPROVED_SCREENS' own order: the tour opened on
// "setup" by default -- a near-empty form in a huge frame, the weakest image on the page landing
// right where attention lands first. `servers` (a populated list with status pills) now leads;
// `setup` (the sparsest capture) is last. The panel frame itself is also capped (`max-w-[720px]`,
// centered) so a sparse capture doesn't sit in a vast full-width empty panel -- framing only,
// never a crop of the approved capture itself (D-17 "la captura tal cual").
//
// Only the active panel is ever mounted (not six stacked/hidden panels) -- keeps the DOM light and
// makes "one visible screenshot" trivially true rather than relying on CSS visibility. Each panel
// remount picks up global.css's `.site-tour-panel` entrance transition (opacity + 8px translate,
// `@starting-style`, `prefers-reduced-motion` drops the translate) -- an approximate crossfade,
// not a true two-layer cross-dissolve, matching Emil's "cheapest tool that works" (CSS transition
// only, no JS animation driver) rather than reaching for a library.
import { useRef, useState } from 'react';
import { DELIVERED_CAPABILITIES } from '../../content/scope';
import type { ApprovedScreen } from '../../lib/site-facts';
import { ScreenshotFrame } from './ScreenshotFrame';

interface TourTab {
  readonly screen: ApprovedScreen;
  readonly label: string;
  readonly capabilityId: (typeof DELIVERED_CAPABILITIES)[number]['id'];
}

// Visual-strength order (most to least populated capture), default tab is index 0.
const TOUR_TABS: readonly TourTab[] = [
  { screen: 'servers', label: 'Connect', capabilityId: 'connect-ssh' },
  { screen: 'server-detail', label: 'Discover', capabilityId: 'server-detail' },
  { screen: 'activity', label: 'Activity', capabilityId: 'activity-log' },
  { screen: 'settings', label: 'Appearance', capabilityId: 'appearance' },
  { screen: 'login', label: 'Trust', capabilityId: 'fingerprint-trust' },
  { screen: 'setup', label: 'Install', capabilityId: 'install' },
];

function claimFor(id: TourTab['capabilityId']): string {
  const entry = DELIVERED_CAPABILITIES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`ProductTour: unknown capability id "${id}"`);
  return entry.claim;
}

const TAB_CLASSES =
  'inline-flex h-11 items-center whitespace-nowrap border-b-2 border-transparent px-4 text-body font-semibold text-ink-secondary ' +
  'outline-none transition-[color,border-color] duration-[var(--duration-micro)] ease-[var(--ease-standard)] hover:text-ink ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'aria-selected:border-accent aria-selected:text-ink';

export function ProductTour() {
  const [activeIndex, setActiveIndex] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = TOUR_TABS[activeIndex] ?? TOUR_TABS[0];
  if (active === undefined) throw new Error('ProductTour: TOUR_TABS is empty');

  function selectIndex(nextIndex: number): void {
    const wrapped = (nextIndex + TOUR_TABS.length) % TOUR_TABS.length;
    setActiveIndex(wrapped);
    tabRefs.current[wrapped]?.focus();
  }

  // Reads the "from" index off the key event's own target (its `data-index`) rather than the
  // `activeIndex` state -- keyboard focus can land on any tab (assistive tech, or a test
  // simulating arrival at a given tab) independently of which one is currently selected/active,
  // so arrow navigation must move relative to the focused tab, not the selected one.
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    const fromIndex = Number(event.currentTarget.dataset.index ?? activeIndex);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      selectIndex(fromIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      selectIndex(fromIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectIndex(TOUR_TABS.length - 1);
    }
  }

  return (
    <div data-testid="product-tour" className="flex flex-col gap-6">
      <div
        role="tablist"
        aria-label="Product tour"
        className="site-tour-tablist-fade flex gap-2 overflow-x-auto border-b border-hairline"
      >
        {TOUR_TABS.map((tab, index) => (
          <button
            key={tab.screen}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            role="tab"
            type="button"
            id={`tour-tab-${tab.screen}`}
            data-index={index}
            aria-selected={index === activeIndex}
            aria-controls={`tour-panel-${tab.screen}`}
            tabIndex={index === activeIndex ? 0 : -1}
            className={TAB_CLASSES}
            onClick={() => {
              setActiveIndex(index);
            }}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        key={active.screen}
        id={`tour-panel-${active.screen}`}
        role="tabpanel"
        aria-labelledby={`tour-tab-${active.screen}`}
        className="site-tour-panel mx-auto flex w-full max-w-[720px] flex-col gap-3"
      >
        <ScreenshotFrame screen={active.screen} alt={claimFor(active.capabilityId)} loading="lazy" />
        <p className="text-body font-normal text-ink-secondary">{claimFor(active.capabilityId)}</p>
      </div>
    </div>
  );
}
