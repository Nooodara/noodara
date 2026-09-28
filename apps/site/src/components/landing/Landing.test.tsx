// 10-11-PLAN.md Task 1 (D-01..D-06, D-18, SITE-01, T-10-04/T-10-07/T-10-05). RED: written before
// Landing.tsx exists. Proves the honesty and structure contract for the composed landing in one
// render -- claims come from DELIVERED_CAPABILITIES/scope.ts only, external links are safe, every
// image is an approved screenshot, and the hero's aperture wrapper matches AuthCard.tsx's own
// declarative attributes exactly (D-18). Stubs the four NOODARA_SITE_* build-time env vars,
// matching landing-parts.test.tsx's own pattern (10-09).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_TITLES, DELIVERED_CAPABILITIES, findExcludedTerms, SCOPE_EXCLUSIONS } from '../../content/scope';
import { APPROVED_SCREENS, GITHUB_URL, INSTALL_COMMAND } from '../../lib/site-facts';
import { Landing } from './Landing';

function claimFor(id: string): string {
  const entry = DELIVERED_CAPABILITIES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`unknown capability id "${id}"`);
  return entry.claim;
}

const LANDING_DIR = path.join(import.meta.dirname);

function nonTestLandingSourceFiles(): string[] {
  return readdirSync(LANDING_DIR)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .map((f) => path.join(LANDING_DIR, f));
}

beforeEach(() => {
  vi.stubEnv('NOODARA_SITE_ORIGIN', 'https://noodara.com');
  vi.stubEnv('NOODARA_SITE_BASE_PATH', '');
  vi.stubEnv('NOODARA_SITE_VERSION', 'v9.9.9');
  vi.stubEnv('NOODARA_SITE_LICENSE', 'Apache License 2.0');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('Landing', () => {
  it('renders an h1 that reads exactly "Your infrastructure, understood."', () => {
    render(<Landing />);
    expect(screen.getByRole('heading', { level: 1, name: 'Your infrastructure, understood.' })).toBeInTheDocument();
  });

  it('renders a hero eyebrow line built from the build-time license and the connect-ssh "no agent" fact', () => {
    render(<Landing />);
    const eyebrow = screen.getByTestId('hero-eyebrow');
    expect(eyebrow.textContent).toContain('Apache License 2.0');
    expect(eyebrow.textContent).toMatch(/self-hosted/i);
    expect(eyebrow.textContent).toMatch(/no agent/i);
    expect(findExcludedTerms(eyebrow.textContent ?? '')).toEqual([]);
  });

  it('renders INSTALL_COMMAND twice (hero + closing CTA band) in a <code>, each with a "Copy install command" button', () => {
    render(<Landing />);
    const codeEls = screen.getAllByText(INSTALL_COMMAND);
    expect(codeEls).toHaveLength(2);
    for (const el of codeEls) expect(el.tagName).toBe('CODE');
    expect(screen.getAllByRole('button', { name: 'Copy install command' })).toHaveLength(2);
  });

  it('renders "Read the docs" linking into /docs and "View on GitHub" linking to GITHUB_URL', () => {
    render(<Landing />);
    const docsLink = screen.getByRole('link', { name: 'Read the docs' });
    expect(docsLink.getAttribute('href')).toMatch(/\/docs$/);
    const githubLink = screen.getByRole('link', { name: 'View on GitHub' });
    expect(githubLink).toHaveAttribute('href', GITHUB_URL);
  });

  it('renders a feature grid with every DELIVERED_CAPABILITIES title and claim (D-02a)', () => {
    render(<Landing />);
    const grid = within(screen.getByTestId('feature-grid'));
    for (const capability of DELIVERED_CAPABILITIES) {
      expect(grid.getByText(CAPABILITY_TITLES[capability.id])).toBeInTheDocument();
      expect(grid.getByText(claimFor(capability.id))).toBeInTheDocument();
    }
  });

  it('renders a tabbed product tour over the 6 APPROVED_SCREENS (D-02a)', () => {
    render(<Landing />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(APPROVED_SCREENS.length);
  });

  it('renders a "How it is built" principles band with encrypted-credentials/explicit-timeouts claims (D-02a)', () => {
    render(<Landing />);
    const band = within(screen.getByTestId('principles-band'));
    expect(band.getByText(claimFor('encrypted-credentials'))).toBeInTheDocument();
    expect(band.getByText(claimFor('explicit-timeouts'))).toBeInTheDocument();
  });

  it('renders an FAQ of native <details> disclosures, answers backed by DELIVERED_CAPABILITIES claims (D-02a)', () => {
    render(<Landing />);
    const faqRoot = screen.getByTestId('faq-section');
    const faq = within(faqRoot);
    expect(faqRoot.querySelectorAll('details').length).toBeGreaterThanOrEqual(5);
    expect(faq.getByText(claimFor('install'))).toBeInTheDocument();
  });

  it('renders "What it does not do yet" inside the scope block, listing every showOnLanding exclusion and a link to /docs/reference/scope', () => {
    render(<Landing />);
    const scopeBlock = screen.getByTestId('scope-block');
    expect(scopeBlock.querySelector('h2')?.textContent).toBe('What it does not do yet');

    const landingExclusions = SCOPE_EXCLUSIONS.filter((exclusion) => exclusion.showOnLanding);
    expect(landingExclusions.length).toBeGreaterThan(0);
    for (const exclusion of landingExclusions) {
      expect(scopeBlock.textContent).toContain(exclusion.statement);
    }

    const scopeLink = screen.getByRole('link', { name: 'See full scope' });
    expect(scopeLink).toHaveAttribute('href', '/docs/reference/scope');
  });

  it('renders a "How it works" heading together with the diagram\'s accessible title', () => {
    render(<Landing />);
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: 'How Noodara works: install on an Ubuntu VPS, add servers over SSH, Noodara discovers and watches them',
      }),
    ).toBeInTheDocument();
  });

  it('has no excluded term in the page text outside the scope block', () => {
    const { container } = render(<Landing />);
    const scopeBlock = container.querySelector('[data-testid="scope-block"]');
    const clone = container.cloneNode(true) as HTMLElement;
    const clonedScopeBlock = clone.querySelector('[data-testid="scope-block"]');
    if (clonedScopeBlock !== null) clonedScopeBlock.remove();
    expect(scopeBlock).not.toBeNull();

    const findings = findExcludedTerms(clone.textContent);
    expect(findings).toEqual([]);
  });

  it('never names a competitor (D-04)', () => {
    const { container } = render(<Landing />);
    expect(container.textContent).not.toMatch(/coolify|dokploy|heroku|vercel|netlify|render\.com/i);
  });

  it('every <img> src is an approved screenshot under /screenshots/', () => {
    render(<Landing />);
    const images = document.querySelectorAll('img');
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      const src = img.getAttribute('src') ?? '';
      expect(src.startsWith('/screenshots/')).toBe(true);
      const matchesApproved = APPROVED_SCREENS.some((screen) => src.includes(`/screenshots/${screen}-`));
      expect(matchesApproved).toBe(true);
    }
  });

  it('every absolute http(s) <a> either has no target="_blank", or rel contains noopener and noreferrer', () => {
    render(<Landing />);
    const anchors = document.querySelectorAll('a');
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? '';
      if (!/^https?:\/\//.test(href)) continue;
      const target = anchor.getAttribute('target');
      if (target !== '_blank') continue;
      const rel = anchor.getAttribute('rel') ?? '';
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    }
  });

  it('the hero lockup wrapper has the exact AuthCard-style aperture-focus attributes', () => {
    const { container } = render(<Landing />);
    const wrapper = container.querySelector('[data-aperture-focus="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('data-entering', 'true');
    expect(wrapper).toHaveAttribute('data-aperture-focused', 'true');
  });

  it('the footer shows Docs and GitHub links, plus the stubbed license and version text', () => {
    render(<Landing />);
    const footer = document.querySelector('footer');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toContain('Apache License 2.0');
    expect(footer?.textContent).toContain('v9.9.9');
    const footerDocsLink = [...(footer?.querySelectorAll('a') ?? [])].find((a) => a.textContent === 'Docs');
    expect(footerDocsLink).toBeDefined();
    const footerGithubLink = [...(footer?.querySelectorAll('a') ?? [])].find((a) => a.textContent === 'GitHub');
    expect(footerGithubLink).toHaveAttribute('href', GITHUB_URL);
  });

  it('the footer has one representative link per D-08 docs group (Getting started/Concepts/Operate/Reference)', () => {
    render(<Landing />);
    const footer = document.querySelector('footer');
    const hrefs = [...(footer?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/docs/getting-started/install');
    expect(hrefs).toContain('/docs/concepts/server');
    expect(hrefs).toContain('/docs/operate/upgrade');
    expect(hrefs).toContain('/docs/reference/scope');
  });

  it('source scan: non-test landing files contain no fetch(, no IntersectionObserver, no onScroll, no version literal and no stargazers', () => {
    const files = nonTestLandingSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/fetch\(/);
      expect(content).not.toMatch(/IntersectionObserver/);
      expect(content).not.toMatch(/onScroll/);
      expect(content).not.toMatch(/\/v\d+\.\d+\.\d+\//);
      expect(content).not.toMatch(/stargazers/);
    }
  });
});
