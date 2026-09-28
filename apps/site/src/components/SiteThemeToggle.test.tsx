// 10-02-PLAN.md Task 1 (D-15): the site's own theme toggle -- a single icon button, no icon
// library (UI-SPEC "Icon library: None"), inline SVG only. RED: written before
// SiteThemeToggle.tsx exists.

import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SiteThemeToggle } from './SiteThemeToggle';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
  localStorage.clear();
});

describe('SiteThemeToggle', () => {
  it('renders an accessible name of "Switch to dark theme" when the current theme is light', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    render(<SiteThemeToggle />);

    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });

  it('clicking it applies and persists "dark" and flips the accessible name', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const user = userEvent.setup();
    render(<SiteThemeToggle />);

    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('noodara-site-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('renders "Switch to light theme" when the current theme is dark', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    render(<SiteThemeToggle />);

    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });
});
