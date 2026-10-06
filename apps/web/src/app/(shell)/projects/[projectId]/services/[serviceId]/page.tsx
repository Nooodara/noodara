'use client';

// 13-12: the service view. Toolbar (derived status, Deploy, Cancel, Edit, overflow actions), the
// service's facts and its deployment history. The service stays live from `service.updated` /
// `service.deleted`, the history from `deployment.updated` (useDeploymentHistory); both refetch on
// stream (re)open. Edit opens ServiceSheet (13-11) in edit mode; a save updates the view in place
// and tells the sidebar through notifyProjectsChanged().
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, EmptyState, InsetGroup, Notice, SkeletonRow } from '@noodara/ui';
import { DeploymentHistory, useDeploymentHistory } from '../../../../../../components/DeploymentHistory';
import {
  isRoutableId,
  notifyProjectsChanged,
  projectHref,
  PROJECTS_HREF,
  subscribeProjectsChanged,
} from '../../../../../../components/ProjectNav';
import { ServiceFacts } from '../../../../../../components/ServiceFacts';
import { REDEPLOY_NEEDED_COPY, ServiceSheet } from '../../../../../../components/ServiceSheet';
import { ServiceToolbar } from '../../../../../../components/ServiceToolbar';
import { Toolbar } from '../../../../../../components/Toolbar';
import { apiGet, type ServerView } from '../../../../../../lib/api-client';
import { getProject, getService, type ProjectView, type ServiceView } from '../../../../../../lib/deploy-api';
import { requireSession } from '../../../../../../lib/require-session';
import { isCancellable } from '../../../../../../lib/service-status-copy';
import { useDeployStream } from '../../../../../../lib/shell-context';

type PageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'error'; readonly code: string }
  | {
      readonly kind: 'ready';
      readonly project: ProjectView;
      readonly service: ServiceView;
    };

interface ListServersResponse {
  readonly items: ServerView[];
}

const SERVICE_DELETED_COPY = 'This service was deleted.';
const SERVICE_LOAD_FAILED_COPY = "Couldn't load the service. Check your connection and try again.";
const NOW_TICK_MS = 30_000;
const SKELETON_ROW_COUNT = 3;

function isNewer(next: ServiceView, held: ServiceView): boolean {
  return Date.parse(next.updatedAt) >= Date.parse(held.updatedAt);
}

export default function ServicePage() {
  const params = useParams<{ projectId: string; serviceId: string }>();
  const { projectId, serviceId } = params;
  const routable = isRoutableId(projectId) && isRoutableId(serviceId);
  const router = useRouter();
  const stream = useDeployStream();
  const { subscribeDeploy, registerResync } = stream;
  const history = useDeploymentHistory(serviceId, stream);
  const [state, setState] = useState<PageState>(() => (routable ? { kind: 'loading' } : { kind: 'not-found' }));
  const [servers, setServers] = useState<readonly ServerView[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [redeployNeeded, setRedeployNeeded] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const latestRequest = useRef(0);

  const fetchService = useCallback((): void => {
    if (!routable) return;
    latestRequest.current += 1;
    const request = latestRequest.current;
    void Promise.all([getProject(projectId), getService(projectId, serviceId)]).then(([project, service]) => {
      if (request !== latestRequest.current) return;
      if (project.ok && service.ok) {
        setState((prev) =>
          prev.kind === 'ready' && prev.service.id === service.data.id && !isNewer(service.data, prev.service)
            ? { ...prev, project: project.data }
            : { kind: 'ready', project: project.data, service: service.data },
        );
        return;
      }
      const failed = !project.ok ? project : !service.ok ? service : null;
      if (failed === null) return;
      if (failed.unauthorized) {
        void requireSession();
        return;
      }
      if (failed.code === 'NOT_FOUND') {
        setState((prev) => (prev.kind === 'deleted' ? prev : { kind: 'not-found' }));
        return;
      }
      // A refetch that fails keeps what is already shown.
      setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', code: failed.code }));
    });
  }, [routable, projectId, serviceId]);

  const fetchServers = useCallback((): void => {
    void apiGet<ListServersResponse>('/api/servers').then((result) => {
      if (result.ok) setServers(result.data.items);
    });
  }, []);

  useEffect(() => {
    fetchService();
    fetchServers();
  }, [fetchService, fetchServers]);
  useEffect(() => registerResync(fetchService), [registerResync, fetchService]);
  useEffect(() => subscribeProjectsChanged(fetchService), [fetchService]);
  useEffect(
    () =>
      subscribeDeploy((event) => {
        if (event.type === 'service.deleted' && event.id === serviceId) {
          setState({ kind: 'deleted' });
          return;
        }
        if (event.type !== 'service.updated' || event.service.id !== serviceId) return;
        const next = event.service;
        setState((prev) => (prev.kind === 'ready' && isNewer(next, prev.service) ? { ...prev, service: next } : prev));
      }),
    [subscribeDeploy, serviceId],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, NOW_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const refresh = useCallback((): void => {
    fetchService();
    history.refresh();
  }, [fetchService, history]);

  if (state.kind !== 'ready') {
    const backLink = routable
      ? { href: projectHref(projectId), label: '← Project' }
      : { href: PROJECTS_HREF, label: '← Projects' };
    return (
      <>
        <Toolbar title="Service" backLink={backLink} />
        <div className="mx-auto flex max-w-[1120px] flex-col gap-4 p-8">
          {state.kind === 'loading' ? (
            <InsetGroup data-testid="service-loading">
              {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
                <SkeletonRow key={index} />
              ))}
            </InsetGroup>
          ) : state.kind === 'error' ? (
            <Banner message={SERVICE_LOAD_FAILED_COPY} errorCode={state.code} data-testid="service-error" />
          ) : (
            <InsetGroup>
              <EmptyState
                data-testid={state.kind === 'deleted' ? 'service-deleted' : 'service-not-found'}
                title={state.kind === 'deleted' ? SERVICE_DELETED_COPY : 'Service not found'}
                body="It may have been deleted. Go back to the project to see its services."
                action={{
                  label: 'Back to project',
                  onClick: () => {
                    router.push(routable ? projectHref(projectId) : PROJECTS_HREF);
                  },
                }}
              />
            </InsetGroup>
          )}
        </div>
      </>
    );
  }

  const { project, service } = state;
  const activeDeployment = history.rows.find((row) => isCancellable(row.status)) ?? null;
  const serverName = servers.find((server) => server.id === service.serverId)?.name ?? null;

  return (
    <>
      <ServiceToolbar
        service={service}
        projectName={project.name}
        archived={project.archivedAt !== null}
        activeDeployment={activeDeployment}
        onDeploymentChange={(deployment) => {
          history.upsert(deployment);
          setRedeployNeeded(false);
          fetchService();
        }}
        onServiceChange={(next) => {
          setState((prev) => (prev.kind === 'ready' && isNewer(next, prev.service) ? { ...prev, service: next } : prev));
        }}
        onRefresh={refresh}
        onEdit={() => {
          setEditOpen(true);
        }}
        onDeleted={() => {
          notifyProjectsChanged();
          router.push(projectHref(project.id));
        }}
      />
      <div className="mx-auto flex max-w-[1120px] flex-col gap-8 p-8">
        {redeployNeeded ? (
          <Notice
            message={REDEPLOY_NEEDED_COPY}
            data-testid="service-redeploy-needed"
            onDismiss={() => {
              setRedeployNeeded(false);
            }}
          />
        ) : null}
        <ServiceFacts service={service} serverName={serverName} now={now} />
        <DeploymentHistory history={history} now={now} />
      </div>
      <ServiceSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={project.id}
        environmentId={service.environmentId}
        servers={servers}
        service={service}
        onSaved={(saved, info) => {
          setState((prev) => (prev.kind === 'ready' ? { ...prev, service: saved } : prev));
          setRedeployNeeded(info.requiresRedeploy);
          notifyProjectsChanged();
        }}
      />
    </>
  );
}
