// 10-09-PLAN.md Task 2 (D-01/D-02/D-05/D-17, T-10-04/T-10-05/T-10-12). RED: written before
// InstallCommand/ScreenshotFrame/PillarCard/HowItWorksDiagram exist. Stubs the four
// NOODARA_SITE_* build-time env vars (build-info.test.ts's own pattern) so readBuildInfo/assetPath
// work under jsdom without a real Next.js build.

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_COMMAND } from '../../lib/site-facts';
import { InstallCommand } from './InstallCommand';
import { ScreenshotFrame } from './ScreenshotFrame';
import { PillarCard } from './PillarCard';
import { HowItWorksDiagram } from './HowItWorksDiagram';

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

describe('PillarCard', () => {
  it('renders an h3 with the title, the discovery claim text, and a ScreenshotFrame', () => {
    render(<PillarCard title="Discover" capability="discovery" screen="server-detail" />);

    expect(screen.getByRole('heading', { level: 3, name: 'Discover' })).toBeInTheDocument();
    expect(
      screen.getByText('Discover a server step by step, with a pass or fail check at each stage.'),
    ).toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(2);
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
