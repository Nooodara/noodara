'use client';

// 13-12: what a service is and where it runs, as label/value pairs. The status row repeats the
// derived status with one sentence on what it means (UNKNOWN in particular: the container could
// not be checked, which is not the same as stopped). Technical values are mono.
import { formatIso, formatRelativeTime, InsetGroup, LabelValue } from '@noodara/ui';
import type { ServiceView } from '../lib/deploy-api';
import { serviceStatusPresentation } from '../lib/service-status-copy';

export interface ServiceFactsProps {
  readonly service: ServiceView;
  /** The server's name, or null while servers are loading or when it is not listed. */
  readonly serverName: string | null;
  readonly now: Date;
}

export const NOT_PUBLISHED_COPY = 'Not published';

export function ServiceFacts({ service, serverName, now }: ServiceFactsProps) {
  const status = serviceStatusPresentation(service.status);
  const isImage = service.sourceType === 'image';

  return (
    <div className="flex flex-col gap-6" data-testid="service-facts">
      <InsetGroup title="Status" data-testid="service-facts-status">
        <div className="px-4">
          <LabelValue label="Status" value={status.word} caption={status.meaning} data-testid="service-fact-status" />
        </div>
      </InsetGroup>
      <InsetGroup title="Source" data-testid="service-facts-source">
        {isImage ? (
          <div className="px-4">
            <LabelValue label="Image" value={service.imageRef} mono copyable data-testid="service-fact-image" />
          </div>
        ) : (
          <div className="px-4">
            <LabelValue label="Repository" value={service.repositoryUrl} mono copyable data-testid="service-fact-repository" />
          </div>
        )}
        {isImage ? null : (
          <div className="px-4">
            <LabelValue label="Branch" value={service.branch} mono data-testid="service-fact-branch" />
          </div>
        )}
        {isImage ? null : (
          <div className="px-4">
            <LabelValue label="Dockerfile" value={service.dockerfilePath} mono data-testid="service-fact-dockerfile" />
          </div>
        )}
      </InsetGroup>
      <InsetGroup title="Runtime" data-testid="service-facts-runtime">
        <div className="px-4">
          <LabelValue label="Server" value={serverName} data-testid="service-fact-server" />
        </div>
        <div className="px-4">
          <LabelValue label="Internal port" value={String(service.internalPort)} mono data-testid="service-fact-internal-port" />
        </div>
        <div className="px-4">
          <LabelValue
            label="Published port"
            value={service.publishedPort === null ? NOT_PUBLISHED_COPY : String(service.publishedPort)}
            mono={service.publishedPort !== null}
            data-testid="service-fact-published-port"
          />
        </div>
        <div className="px-4">
          <LabelValue
            label="Last changed"
            value={formatRelativeTime(service.updatedAt, now)}
            caption={formatIso(service.updatedAt)}
            data-testid="service-fact-updated"
          />
        </div>
      </InsetGroup>
    </div>
  );
}
