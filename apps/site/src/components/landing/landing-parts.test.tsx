// 10-09-PLAN.md Task 2 (D-01/D-02/D-05/D-17, T-10-04/T-10-05/T-10-12). RED: written before
// InstallCommand/ScreenshotFrame/PillarCard/HowItWorksDiagram exist. Stubs the four
// NOODARA_SITE_* build-time env vars (build-info.test.ts's own pattern) so readBuildInfo/assetPath
// work under jsdom without a real Next.js build.

import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVED_SCREENS, INSTALL_COMMAND } from '../../lib/site-facts';
import { DELIVERED_CAPABILITIES } from '../../content/scope';
import { FEATURE_GRID_CELLS, FEATURE_GRID_DESKTOP_COLUMNS } from '../../content/feature-grid';
import { InstallCommand } from './InstallCommand';
import { ScreenshotFrame } from './ScreenshotFrame';
import { HowItWorksDiagram } from './HowItWorksDiagram';
import { FeatureGrid } from './FeatureGrid';
import { ProductTour } from './ProductTour';
import { FAQSection } from './FAQSection';
import { ClosingCta } from './ClosingCta';
import { CapabilityGlyph } from './CapabilityGlyph';

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.stubEnv('NOODARA_SITE_ORIGIN', 'https://noodara.com');
  vi.stubEnv('NOODARA_SITE_BASE_PATH', '');
  vi.stubEnv('NOODARA_SITE_VERSION', 'v0.1.0');
  vi.stubEnv('NOODARA_SITE_LICENSE', 'Apache License 2.0');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  // @ts-expect-error -- reset the test-only stub between tests, jsdom's real navigator has no clipboard
  delete navigator.clipboard;
});

describe('InstallCommand', () => {
  it('renders INSTALL_COMMAND inside a <code> exactly once, plus a "Copy install command" button', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<InstallCommand />);

    const codeEls = screen.getAllByText(INSTALL_COMMAND);
    expect(codeEls).toHaveLength(1);
    expect(codeEls[0]?.tagName).toBe('CODE');
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeInTheDocument();
  });

  it('renders a "Download, read, run" link to the install-without-piping anchor', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<InstallCommand />);

    const link = screen.getByRole('link', { name: 'Download, read, run' });
    expect(link).toHaveAttribute('href', '/docs/getting-started/install#install-without-piping-to-a-shell');
  });

  it('clicking the copy button calls navigator.clipboard.writeText with INSTALL_COMMAND', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<InstallCommand />);

    await user.click(screen.getByRole('button', { name: 'Copy install command' }));

    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
  });
});

describe('ScreenshotFrame', () => {
  it('renders a light and a dark <img>, both 1280x900, with the given alt on the light image', () => {
    render(<ScreenshotFrame screen="servers" alt="The Servers list" />);

    const light = screen.getByAltText('The Servers list');
    expect(light).toHaveClass('site-shot-light');
    expect(light.getAttribute('src')).toContain('/screenshots/servers-light.png');
    expect(light).toHaveAttribute('width', '1280');
    expect(light).toHaveAttribute('height', '900');

    const images = document.querySelectorAll('img');
    expect(images).toHaveLength(2);
    const dark = images.item(1);
    expect(dark).toHaveClass('site-shot-dark');
    expect(dark.getAttribute('src')).toContain('/screenshots/servers-dark.png');
    expect(dark.getAttribute('alt')).toBe('');
    expect(dark).toHaveAttribute('aria-hidden', 'true');
    expect(dark).toHaveAttribute('width', '1280');
    expect(dark).toHaveAttribute('height', '900');
  });

  it('renders no element with a class or style containing "shadow"', () => {
    const { container } = render(<ScreenshotFrame screen="servers" alt="The Servers list" />);

    const offenders = [...container.querySelectorAll('*')].filter((el) => {
      const className = typeof el.className === 'string' ? el.className : '';
      const style = el.getAttribute('style') ?? '';
      return /shadow/i.test(className) || /shadow/i.test(style);
    });
    expect(offenders).toHaveLength(0);
  });
});

// 10-12-PLAN.md Round 1 (D-02a). RED: written before FeatureGrid/ProductTour/FAQSection/
// ClosingCta/CapabilityGlyph exist -- replaces the old three-pillar PillarCard coverage above
// with coverage for the feature grid + tabbed product tour that supersede it. (PrinciplesBand
// existed briefly in this round and was removed in the fix batch -- it repeated four FeatureGrid
// cells word for word; see HowItWorksDiagram.tsx and Landing.tsx for where that content lives.)

describe('CapabilityGlyph', () => {
  it('renders one aria-hidden <svg> per known capability id, every stroke/fill currentColor or none', () => {
    for (const capability of DELIVERED_CAPABILITIES) {
      const { container, unmount } = render(<CapabilityGlyph id={capability.id} />);
      const svg = container.querySelector('svg');
      expect(svg, `no <svg> for "${capability.id}"`).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      const shapes = svg?.querySelectorAll('rect, line, path, circle') ?? [];
      expect(shapes.length, `"${capability.id}" glyph has no shapes`).toBeGreaterThan(0);
      for (const shape of shapes) {
        const fill = shape.getAttribute('fill');
        const stroke = shape.getAttribute('stroke');
        if (fill !== null) expect(fill === 'currentColor' || fill === 'none').toBe(true);
        if (stroke !== null) expect(stroke === 'currentColor' || stroke === 'none').toBe(true);
      }
      unmount();
    }
  });
});

describe('FeatureGrid', () => {
  it('renders every DELIVERED_CAPABILITIES claim exactly once, grouped into 9 cells (a multiple of the desktop column count, no ragged row)', () => {
    render(<FeatureGrid />);
    expect(FEATURE_GRID_CELLS.length).toBe(9);
    expect(FEATURE_GRID_CELLS.length % FEATURE_GRID_DESKTOP_COLUMNS).toBe(0);
    for (const capability of DELIVERED_CAPABILITIES) {
      expect(screen.getByText(capability.claim)).toBeInTheDocument();
    }
    for (const cell of FEATURE_GRID_CELLS) {
      expect(screen.getByText(cell.title)).toBeInTheDocument();
    }
  });

  it('never uses a 2-column tablet tier (grid-cols-2) -- only 1 column mobile, 3 columns desktop, so 9 cells never end a row short', () => {
    const { container } = render(<FeatureGrid />);
    const grid = container.querySelector('[data-testid="feature-grid"]');
    expect(grid?.className).not.toMatch(/grid-cols-2/);
  });

  it('renders no element with a class or style containing "shadow"', () => {
    const { container } = render(<FeatureGrid />);
    const offenders = [...container.querySelectorAll('*')].filter((el) => {
      const className = typeof el.className === 'string' ? el.className : '';
      const style = el.getAttribute('style') ?? '';
      return /shadow/i.test(className) || /shadow/i.test(style);
    });
    expect(offenders).toHaveLength(0);
  });
});

describe('ProductTour', () => {
  beforeEach(() => {
    vi.stubEnv('NOODARA_SITE_ORIGIN', 'https://noodara.com');
    vi.stubEnv('NOODARA_SITE_BASE_PATH', '');
    vi.stubEnv('NOODARA_SITE_VERSION', 'v0.1.0');
    vi.stubEnv('NOODARA_SITE_LICENSE', 'Apache License 2.0');
  });

  it('renders a role="tablist" of 6 tabs matching APPROVED_SCREENS, first tab selected, one visible screenshot', () => {
    render(<ProductTour />);
    const tablist = screen.getByRole('tablist');
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    expect(document.querySelectorAll('img[alt]:not([alt=""])').length).toBe(1);
  });

  it('ArrowRight moves selection to the next tab and swaps the visible caption', async () => {
    const user = userEvent.setup();
    render(<ProductTour />);
    const tabs = screen.getAllByRole('tab');
    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('ArrowRight on the last tab wraps to the first', async () => {
    const user = userEvent.setup();
    render(<ProductTour />);
    const tabs = screen.getAllByRole('tab');
    tabs[5]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('every panel screenshot src is an approved screenshot under /screenshots/', () => {
    render(<ProductTour />);
    const images = document.querySelectorAll('img');
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      const src = img.getAttribute('src') ?? '';
      expect(src.startsWith('/screenshots/')).toBe(true);
      expect(APPROVED_SCREENS.some((s) => src.includes(`/screenshots/${s}-`))).toBe(true);
    }
  });
});

describe('FAQSection', () => {
  it('renders every answer as an existing DELIVERED_CAPABILITIES claim (never a SCOPE_EXCLUSIONS statement)', () => {
    render(<FAQSection />);
    for (const id of ['connect-ssh', 'fingerprint-trust', 'encrypted-credentials', 'discovery', 'install'] as const) {
      const capability = DELIVERED_CAPABILITIES.find((c) => c.id === id);
      if (capability === undefined) throw new Error(`fixture bug: unknown capability id "${id}"`);
      expect(screen.getByText(capability.claim)).toBeInTheDocument();
    }
  });

  it('uses native <details>/<summary> disclosures (zero custom JS accordion)', () => {
    const { container } = render(<FAQSection />);
    const details = container.querySelectorAll('details');
    expect(details.length).toBeGreaterThanOrEqual(5);
    for (const detail of details) {
      expect(detail.querySelector('summary')).not.toBeNull();
    }
  });
});

describe('ClosingCta', () => {
  it('renders INSTALL_COMMAND inside a <code> and a "Copy install command" button', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<ClosingCta />);
    expect(screen.getByText(INSTALL_COMMAND).tagName).toBe('CODE');
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeInTheDocument();
  });
});

describe('HowItWorksDiagram', () => {
  it('renders an <svg role="img"> with the expected accessible title', () => {
    render(<HowItWorksDiagram />);

    const svg = screen.getByRole('img', {
      name: 'How Noodara works: install on an Ubuntu VPS, add servers over SSH, Noodara discovers and watches them',
    });
    expect(svg.tagName.toLowerCase()).toBe('svg');
  });

  it('has no <image> element and no external href', () => {
    const { container } = render(<HowItWorksDiagram />);

    expect(container.querySelectorAll('image')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/href=["']https?:\/\//);
  });

  it('renders the three D-05 step captions as HTML text, not SVG <text>', () => {
    const { container } = render(<HowItWorksDiagram />);

    expect(screen.getByText('Install Noodara on an Ubuntu VPS')).toBeInTheDocument();
    expect(screen.getByText('Add your servers over SSH — no agent')).toBeInTheDocument();
    expect(screen.getByText('Noodara discovers and watches them')).toBeInTheDocument();
    expect(container.querySelectorAll('svg text')).toHaveLength(0);
  });

  it('every stroke/fill on shapes is currentColor', () => {
    const { container } = render(<HowItWorksDiagram />);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    const shapes = svg?.querySelectorAll('rect, line, path, circle') ?? [];
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      const fill = shape.getAttribute('fill');
      const stroke = shape.getAttribute('stroke');
      if (fill !== null) expect(fill === 'currentColor' || fill === 'none').toBe(true);
      if (stroke !== null) expect(stroke === 'currentColor' || stroke === 'none').toBe(true);
    }
  });
});
