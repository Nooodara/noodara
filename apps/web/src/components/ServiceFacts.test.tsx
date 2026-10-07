import { describe, expect, it } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import type { ServiceView } from '../lib/deploy-api';
import { NOT_PUBLISHED_COPY, ServiceFacts } from './ServiceFacts';

const STAMP = '2026-10-06T00:00:00.000Z';
const NOW = new Date('2026-10-06T00:05:00.000Z');

function service(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    projectId: '11111111-1111-4111-8111-111111111111',
    environmentId: '22222222-2222-4222-8222-222222222222',
    serverId: '55555555-5555-4555-8555-555555555555',
    name: 'api',
    sourceType: 'git',
    repositoryUrl: 'https://example.com/acme/api.git',
    branch: 'main',
    buildContext: '.',
    dockerfilePath: 'Dockerfile',
    buildTarget: null,
    imageRef: null,
    internalPort: 3000,
    publishedPort: 8080,
    status: 'RUNNING',
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

function mono(testId: string): string | null | undefined {
  return screen.getByTestId(testId).querySelector('[data-mono]')?.getAttribute('data-mono');
}

describe('ServiceFacts (13-12 A1)', () => {
  it('shows a git service: repository, branch and Dockerfile in mono, server and ports', () => {
    renderUi(<ServiceFacts service={service()} serverName="edge-1" now={NOW} />);

    expect(screen.getByTestId('service-fact-repository')).toHaveTextContent('https://example.com/acme/api.git');
    expect(mono('service-fact-repository')).toBe('true');
    expect(screen.getByTestId('service-fact-branch')).toHaveTextContent('main');
    expect(screen.getByTestId('service-fact-dockerfile')).toHaveTextContent('Dockerfile');
    expect(screen.queryByTestId('service-fact-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('service-fact-server')).toHaveTextContent('edge-1');
    expect(screen.getByTestId('service-fact-internal-port')).toHaveTextContent('3000');
    expect(mono('service-fact-internal-port')).toBe('true');
    expect(screen.getByTestId('service-fact-published-port')).toHaveTextContent('8080');
  });

  it('shows an image service without git fields and an unpublished port in words', () => {
    renderUi(
      <ServiceFacts
        service={service({ sourceType: 'image', imageRef: 'nginx:1.27', repositoryUrl: null, branch: null, dockerfilePath: null, publishedPort: null })}
        serverName={null}
        now={NOW}
      />,
    );

    expect(screen.getByTestId('service-fact-image')).toHaveTextContent('nginx:1.27');
    expect(screen.queryByTestId('service-fact-repository')).not.toBeInTheDocument();
    expect(screen.queryByTestId('service-fact-branch')).not.toBeInTheDocument();
    expect(screen.getByTestId('service-fact-published-port')).toHaveTextContent(NOT_PUBLISHED_COPY);
    expect(mono('service-fact-published-port')).toBe('false');
  });

  it('states what the derived status means, and UNKNOWN honestly', () => {
    renderUi(<ServiceFacts service={service({ status: 'UNKNOWN' as ServiceView['status'] })} serverName="edge-1" now={NOW} />);

    const status = screen.getByTestId('service-fact-status');
    expect(status).toHaveTextContent('Unknown');
    expect(status).toHaveTextContent(/couldn't check the container/);
    expect(status).not.toHaveTextContent('Running');
  });

  it('shows when the service last changed relative to now', () => {
    renderUi(<ServiceFacts service={service()} serverName="edge-1" now={NOW} />);

    expect(screen.getByTestId('service-fact-updated')).toHaveTextContent(/5 min/);
  });

  // 13-20 A4: the row showed the raw ISO string as a caption next to "5 min ago". The visible
  // text is relative only; the exact instant is carried by <time dateTime> and its tooltip.
  it('shows Last changed as relative time only, never the raw ISO string', () => {
    renderUi(<ServiceFacts service={service()} serverName="edge-1" now={NOW} />);

    const row = screen.getByTestId('service-fact-updated');
    expect(row).toHaveTextContent('Last changed');
    expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe(STAMP);
  });
});
