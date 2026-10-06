'use client';

// 13-14: the inspector for a service page. The selection is the URL's query (inspector-route.ts);
// nothing selected renders nothing, so the shell slot stays zero width. The panel is keyed by the
// selection, so switching deployments never shows the previous one's text.
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import {
  BUILD_LOG_NOT_FOUND_COPY,
  BuildLogPanel,
} from '../../../../../../../components/BuildLogPanel';
import { isRoutableId } from '../../../../../../../components/ProjectNav';
import { RuntimeLogPanel } from '../../../../../../../components/RuntimeLogPanel';
import { useDeployStream } from '../../../../../../../lib/shell-context';
import { InspectorFrame } from '../../../../inspector-frame';
import { inspectorSelection } from '../../../../inspector-route';

function ServiceInspector() {
  const params = useParams<{ projectId: string; serviceId: string }>();
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const stream = useDeployStream();
  const selection = inspectorSelection(search);
  if (selection === null) return null;

  const { projectId, serviceId } = params;
  const routable = isRoutableId(projectId) && isRoutableId(serviceId);
  const title = selection.kind === 'runtime' ? 'Runtime logs' : 'Build log';
  const key =
    selection.kind === 'deployment' ? `deployment:${selection.deploymentId}` : selection.kind;

  let body;
  if (!routable || selection.kind === 'not-found') {
    body = (
      <p data-testid="inspector-not-found" className="px-4 py-3 text-callout text-ink-secondary">
        {selection.kind === 'runtime' ? 'This service no longer exists.' : BUILD_LOG_NOT_FOUND_COPY}
      </p>
    );
  } else if (selection.kind === 'deployment') {
    body = (
      <BuildLogPanel serviceId={serviceId} deploymentId={selection.deploymentId} stream={stream} />
    );
  } else {
    body = <RuntimeLogPanel projectId={projectId} serviceId={serviceId} />;
  }

  return (
    <InspectorFrame
      key={key}
      title={title}
      onClose={() => {
        router.replace(pathname, { scroll: false });
      }}
    >
      {body}
    </InspectorFrame>
  );
}

export default function ServiceInspectorPage() {
  return (
    <Suspense fallback={null}>
      <ServiceInspector />
    </Suspense>
  );
}
