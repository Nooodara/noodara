'use client';

// 13-14: the inspector for a service page. The selection is the URL's query (inspector-route.ts);
// nothing selected renders nothing, so the shell slot stays zero width. The panel is keyed by the
// selection, so switching deployments never shows the previous one's text.
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import {
  BUILD_LOG_NOT_FOUND_COPY,
  BuildLogPanel,
} from '../../../../../../../components/BuildLogPanel';
import { isRoutableId } from '../../../../../../../components/ProjectNav';
import { WebhookPanel } from '../../../../../../../components/WebhookPanel';
import { RuntimeLogPanel } from '../../../../../../../components/RuntimeLogPanel';
import { getService } from '../../../../../../../lib/deploy-api';
import { useDeployStream } from '../../../../../../../lib/shell-context';
import { InspectorFrame } from '../../../../inspector-frame';
import { inspectorSelection } from '../../../../inspector-route';

const WEBHOOK_PARAM = 'webhook';

/** 19-03: `?webhook=1` opens the push-webhook panel. The panel needs the source type (image-source
 *  services never show it), so the service is read first; until then, or if it fails, nothing shows. */
function WebhookInspector({ projectId, serviceId, onClose }: { projectId: string; serviceId: string; onClose: () => void }) {
  const [sourceType, setSourceType] = useState<'git' | 'image' | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getService(projectId, serviceId).then((result) => {
      if (!cancelled && result.ok) setSourceType(result.data.sourceType);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, serviceId]);
  if (sourceType !== 'git') return null;
  return (
    <InspectorFrame title="Push webhook" onClose={onClose}>
      <WebhookPanel projectId={projectId} serviceId={serviceId} sourceType={sourceType} />
    </InspectorFrame>
  );
}

function ServiceInspector() {
  const params = useParams<{ projectId: string; serviceId: string }>();
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const stream = useDeployStream();
  const selection = inspectorSelection(search);
  const { projectId, serviceId } = params;
  const routable = isRoutableId(projectId) && isRoutableId(serviceId);
  if (selection === null) {
    if (search.get(WEBHOOK_PARAM) !== '1' || !routable) return null;
    return (
      <WebhookInspector
        projectId={projectId}
        serviceId={serviceId}
        onClose={() => {
          router.replace(pathname, { scroll: false });
        }}
      />
    );
  }
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
