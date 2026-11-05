'use client';

// 30-03: the project's Infrastructure Graph. Two layouts over one model (graph-model.ts):
// - graph (wide): one band per environment, the environment node on the left and one row per
//   service, its RUNS_ON, EXPOSED_BY and DEPENDS_ON edges laid out as columns;
// - tree (narrow, under 768 px): the same nodes as an indented tree, like the roadmap's §10.3.
// Every node is a plain link (Tab reaches each one in reading order). Hrefs come only from the
// model, which builds them from validated ids; hostnames are rendered as text, never as hrefs.
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type { GraphDomain, GraphEnvironment, GraphLink, GraphModel, GraphService } from './graph-model';

export type GraphLayout = 'graph' | 'tree';

export const GRAPH_WIDE_QUERY = '(min-width: 768px)';

/** 'graph' when the viewport is at least 768 px wide, 'tree' below that. */
export function useGraphLayout(): GraphLayout {
  const [layout, setLayout] = useState<GraphLayout>('graph');
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(GRAPH_WIDE_QUERY);
    const apply = (): void => {
      setLayout(query.matches ? 'graph' : 'tree');
    };
    apply();
    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
    };
  }, []);
  return layout;
}

const LINK_CLASSES =
  'min-w-0 truncate rounded-sm text-accent-text underline-offset-2 outline-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
const EDGE_CLASSES = 'shrink-0 font-mono text-caption text-ink-tertiary';

function NodeLink({ node, kind, className }: { node: GraphLink; kind: string; className?: string }): ReactNode {
  return (
    <Link
      href={node.href}
      data-testid={`graph-node-${node.nodeId}`}
      data-node-kind={kind}
      title={node.label}
      className={`${LINK_CLASSES} ${className ?? ''}`}
    >
      {node.label}
    </Link>
  );
}

function DomainNode({ domain }: { domain: GraphDomain }): ReactNode {
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-testid={`graph-node-${domain.nodeId}`} data-node-kind="Domain">
      <span className="min-w-0 truncate font-mono text-callout text-ink" title={domain.hostname} data-testid="graph-domain-hostname">
        {domain.hostname}
      </span>
      <Link
        href={domain.settingsHref}
        aria-label={`Domain settings for ${domain.hostname}`}
        data-testid={`graph-domain-settings-${domain.nodeId}`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-secondary outline-none hover:text-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ArrowUpRight aria-hidden="true" className="size-3.5" />
      </Link>
    </span>
  );
}

function Edge({ type, children }: { type: string; children: ReactNode }): ReactNode {
  return (
    <li className="flex min-w-0 items-baseline gap-2" data-edge={type}>
      <span className={EDGE_CLASSES}>{type} →</span>
      {children}
    </li>
  );
}

function ServiceEdges({ service }: { service: GraphService }): ReactNode {
  const empty = service.servers.length === 0 && service.domains.length === 0 && service.dependsOn.length === 0;
  if (empty) return <p className="text-caption text-ink-secondary">No relations</p>;
  return (
    <ul className="flex min-w-0 flex-col gap-1" aria-label={`Relations of ${service.label}`}>
      {service.servers.map((server) => (
        <Edge key={server.nodeId} type="RUNS_ON">
          <NodeLink node={server} kind="Server" className="text-callout" />
        </Edge>
      ))}
      {service.domains.map((domain) => (
        <Edge key={domain.nodeId} type="EXPOSED_BY">
          <DomainNode domain={domain} />
        </Edge>
      ))}
      {service.dependsOn.map((target) => (
        <Edge key={target.nodeId} type="DEPENDS_ON">
          <NodeLink node={target} kind="Service" className="text-callout" />
        </Edge>
      ))}
    </ul>
  );
}

function GraphBand({ environment }: { environment: GraphEnvironment }): ReactNode {
  return (
    <section
      aria-label={`Environment ${environment.label}`}
      data-testid={`graph-environment-${environment.nodeId}`}
      className="grid grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)] overflow-hidden rounded-lg border border-hairline bg-surface-1"
    >
      <div className="flex min-w-0 flex-col gap-1 border-r border-hairline p-4">
        <span className="text-label uppercase text-ink-secondary">Environment</span>
        <NodeLink node={environment} kind="Environment" className="font-mono text-headline font-semibold" />
      </div>
      {environment.services.length === 0 ? (
        <p className="p-4 text-callout text-ink-secondary">No services in this environment yet.</p>
      ) : (
        <ul className="flex min-w-0 flex-col" aria-label={`Services in ${environment.label}`}>
          {environment.services.map((service) => (
            <li
              key={service.nodeId}
              className="grid min-w-0 grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] gap-4 border-b border-hairline px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span aria-hidden="true" className={EDGE_CLASSES}>
                  ├
                </span>
                <NodeLink node={service} kind="Service" className="text-body font-medium" />
              </div>
              <ServiceEdges service={service} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TreeBranch({ environment }: { environment: GraphEnvironment }): ReactNode {
  return (
    <li className="flex min-w-0 flex-col gap-2" data-testid={`graph-environment-${environment.nodeId}`}>
      <NodeLink node={environment} kind="Environment" className="font-mono text-headline font-semibold" />
      {environment.services.length === 0 ? (
        <p className="pl-4 text-callout text-ink-secondary">No services yet.</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3 border-l border-hairline pl-4" aria-label={`Services in ${environment.label}`}>
          {environment.services.map((service) => (
            <li key={service.nodeId} className="flex min-w-0 flex-col gap-1">
              <NodeLink node={service} kind="Service" className="text-body font-medium" />
              <div className="border-l border-hairline pl-3">
                <ServiceEdges service={service} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export interface InfrastructureGraphProps {
  readonly model: GraphModel;
  readonly layout: GraphLayout;
}

export function InfrastructureGraph({ model, layout }: InfrastructureGraphProps): ReactNode {
  if (layout === 'tree') {
    return (
      <ul className="flex min-w-0 flex-col gap-6" data-testid="infrastructure-graph" data-layout="tree" aria-label="Infrastructure graph">
        {model.environments.map((environment) => (
          <TreeBranch key={environment.nodeId} environment={environment} />
        ))}
      </ul>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="infrastructure-graph" data-layout="graph">
      {model.environments.map((environment) => (
        <GraphBand key={environment.nodeId} environment={environment} />
      ))}
    </div>
  );
}
