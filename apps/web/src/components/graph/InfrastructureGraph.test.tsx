import { describe, expect, it } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import type { GraphModel } from './graph-model';
import { InfrastructureGraph } from './InfrastructureGraph';

const model: GraphModel = {
  project: { nodeId: 'project:p', label: 'shop', href: '/projects/p' },
  servers: [{ nodeId: 'server:s', label: 'Server-01', href: '/servers/s' }],
  serviceCount: 1,
  truncated: false,
  environments: [
    {
      nodeId: 'environment:e',
      label: 'production',
      href: '/projects/p#environment-e',
      services: [
        {
          nodeId: 'service:a',
          label: 'API',
          href: '/projects/p/services/a',
          servers: [{ nodeId: 'server:s', label: 'Server-01', href: '/servers/s' }],
          domains: [{ nodeId: 'domain:d', hostname: 'javascript:alert(1)', settingsHref: '/projects/p/services/a' }],
          dependsOn: [],
        },
      ],
    },
    { nodeId: 'environment:f', label: 'staging', href: '/projects/p#environment-f', services: [] },
  ],
};

describe.each(['graph', 'tree'] as const)('InfrastructureGraph (%s)', (layout) => {
  it('renders every node as a link and domains as text', () => {
    renderUi(<InfrastructureGraph model={model} layout={layout} />);
    expect(screen.getByTestId('infrastructure-graph')).toHaveAttribute('data-layout', layout);
    expect(screen.getByRole('link', { name: 'production' })).toHaveAttribute('href', '/projects/p#environment-e');
    expect(screen.getByRole('link', { name: 'API' })).toHaveAttribute('href', '/projects/p/services/a');
    expect(screen.getByRole('link', { name: 'Server-01' })).toHaveAttribute('href', '/servers/s');
    const hostname = screen.getByTestId('graph-domain-hostname');
    expect(hostname.tagName).toBe('SPAN');
    expect(hostname.closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Domain settings for javascript:alert(1)' })).toHaveAttribute(
      'href',
      '/projects/p/services/a',
    );
    for (const anchor of screen.getAllByRole('link')) expect(anchor.getAttribute('href')?.startsWith('/')).toBe(true);
    expect(screen.getByText('RUNS_ON →')).toBeInTheDocument();
    expect(screen.getByText('EXPOSED_BY →')).toBeInTheDocument();
  });
});
