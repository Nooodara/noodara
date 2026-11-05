// 10-06-PLAN.md Task 3: ScopeTable and ScopeNote render directly from apps/site/src/content/
// scope.ts (Task 2), so a docs page never hand-types a claim or a limit. RED: written before
// either component exists.

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DELIVERED_CAPABILITIES, SCOPE_EXCLUSIONS } from '../../content/scope';
import { ScopeNote } from './ScopeNote';
import { ScopeTable } from './ScopeTable';

afterEach(() => {
  cleanup();
});

describe('ScopeTable', () => {
  it('renders "Included" and "Not included" column headers', () => {
    render(<ScopeTable />);

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Included', 'Not included']);
  });

  it('renders every delivered capability claim and every exclusion statement', () => {
    render(<ScopeTable />);

    const table = screen.getByRole('table');
    for (const capability of DELIVERED_CAPABILITIES) {
      expect(within(table).getByText(capability.claim)).toBeInTheDocument();
    }
    for (const exclusion of SCOPE_EXCLUSIONS) {
      expect(within(table).getByText(exclusion.statement)).toBeInTheDocument();
    }
  });

  it('renders one row per max(capabilities, exclusions), with empty cells where a column runs out', () => {
    render(<ScopeTable />);

    const rows = screen.getAllByRole('row');
    // +1 for the header row.
    expect(rows.length).toBe(Math.max(DELIVERED_CAPABILITIES.length, SCOPE_EXCLUSIONS.length) + 1);
  });
});

describe('ScopeTable v0.4 scope', () => {
  it('lists domains, HTTPS, variables and secrets as included, never as excluded', () => {
    render(<ScopeTable />);
    const ids = DELIVERED_CAPABILITIES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['domains-https', 'variables', 'secrets']));
    const exclusionIds: readonly string[] = SCOPE_EXCLUSIONS.map((e) => e.id);
    expect(exclusionIds).not.toContain('app-config');
    expect(exclusionIds).not.toContain('domains-tls');
    const table = screen.getByRole('table');
    expect(table.textContent).not.toMatch(/does not manage (domains|application environment variables)/);
  });
});

describe('ScopeTable v0.5 scope', () => {
  it('lists metrics, logs, the graph and the AI assistant as included, and AI writes as excluded', () => {
    render(<ScopeTable />);
    const ids = DELIVERED_CAPABILITIES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['metrics', 'logs', 'infrastructure-graph', 'ai-assistant']));
    const exclusionIds: readonly string[] = SCOPE_EXCLUSIONS.map((e) => e.id);
    expect(exclusionIds).not.toContain('observability-ai');
    expect(exclusionIds).toContain('ai-write');
    const table = screen.getByRole('table');
    expect(table.textContent).not.toMatch(/does not collect metrics/);
  });
});

describe('ScopeNote', () => {
  it('renders the statement of the given exclusion id verbatim, and a link to the full scope page', () => {
    render(<ScopeNote id="advanced-deploy" />);

    const exclusion = SCOPE_EXCLUSIONS.find((e) => e.id === 'advanced-deploy');
    expect(exclusion).toBeTruthy();
    expect(screen.getByText(exclusion?.statement ?? '')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'See the full scope' });
    expect(link).toHaveAttribute('href', '/docs/reference/scope');
  });

  it('renders no text of its own besides the statement and the link', () => {
    render(<ScopeNote id="multi-user" />);

    const exclusion = SCOPE_EXCLUSIONS.find((e) => e.id === 'multi-user');
    const text = document.body.textContent;
    const withoutStatement = text.replace(exclusion?.statement ?? '', '');
    const withoutLink = withoutStatement.replace('See the full scope', '');
    expect(withoutLink.trim()).toBe('');
  });
});
