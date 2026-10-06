'use client';

// 13-10: the project view. The project's environments, each with its services; creating an
// environment happens in EnvironmentSheet, project actions live in ProjectToolbar. Deleting an
// environment goes through ConfirmByNameDialog: a non-empty environment gets the
// ENVIRONMENT_NOT_EMPTY recovery copy, a 404 counts as already deleted. Each environment section
// carries the `environment-<id>` anchor the sidebar links to. Data refetches on stream (re)open
// and on the projects-changed bus. 13-12: each environment has a New service action that opens
// ServiceSheet in create mode; a save refetches the project and tells the sidebar.
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, EmptyState, InsetGroup, ListRow, RowMenu, SkeletonRow } from '@noodara/ui';
import { ConfirmByNameDialog, deleteOutcome } from '../../../../components/ConfirmByNameDialog';
import { ENVIRONMENT_NOT_EMPTY_COPY, EnvironmentSheet } from '../../../../components/EnvironmentSheet';
import {
  isRoutableId,
  notifyProjectsChanged,
  PROJECTS_HREF,
  serviceHref,
  subscribeProjectsChanged,
} from '../../../../components/ProjectNav';
import { ProjectToolbar } from '../../../../components/ProjectToolbar';
import { ServiceSheet } from '../../../../components/ServiceSheet';
import { Toolbar } from '../../../../components/Toolbar';
import { apiGet, type ServerView } from '../../../../lib/api-client';
import {
  deleteEnvironment,
  getProject,
  listEnvironments,
  listServices,
  type EnvironmentView,
  type ProjectView,
  type ServiceView,
} from '../../../../lib/deploy-api';
import { requireSession } from '../../../../lib/require-session';
import { useShellContext } from '../../../../lib/shell-context';

type PageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'error'; readonly code: string }
  | {
      readonly kind: 'ready';
      readonly project: ProjectView;
      readonly environments: readonly EnvironmentView[];
      readonly services: readonly ServiceView[];
    };

interface ListServersResponse {
  readonly items: ServerView[];
}

const ENVIRONMENTS_EMPTY_BODY = 'An environment groups the services you deploy together, for example production or staging.';
const SKELETON_ROW_COUNT = 3;

function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function serviceSource(service: ServiceView): string {
  if (service.sourceType === 'image') return service.imageRef ?? 'image';
  const repository = service.repositoryUrl ?? 'git';
  return service.branch === null ? repository : `${repository} · ${service.branch}`;
}

function menuTestId(environmentId: string): string {
  return `environment-menu-${environmentId}`;
}

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();
  const { registerResync } = useShellContext();
  const [state, setState] = useState<PageState>(() => (isRoutableId(projectId) ? { kind: 'loading' } : { kind: 'not-found' }));
  const [sheetOpen, setSheetOpen] = useState(false);
  // `deleting` keeps the target after close so focus can return to its menu trigger.
  const [deleting, setDeleting] = useState<EnvironmentView | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The environment a new service is being created in; kept after close like `deleting`.
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [serviceSheetOpen, setServiceSheetOpen] = useState(false);
  const [servers, setServers] = useState<readonly ServerView[]>([]);
  const latestRequest = useRef(0);

  const fetchProject = useCallback((): void => {
    if (!isRoutableId(projectId)) return;
    latestRequest.current += 1;
    const request = latestRequest.current;
    void Promise.all([getProject(projectId), listEnvironments(projectId), listServices(projectId)]).then(
      ([project, environments, services]) => {
        if (request !== latestRequest.current) return;
        if (project.ok && environments.ok && services.ok) {
          setState({
            kind: 'ready',
            project: project.data,
            environments: environments.data.items.filter((environment) => isRoutableId(environment.id)),
            services: services.data.items.filter((service) => isRoutableId(service.id)),
          });
          return;
        }
        const failed = [project, environments, services].find((result) => !result.ok);
        if (failed === undefined) return;
        if (failed.unauthorized) {
          void requireSession();
          return;
        }
        if (failed.code === 'NOT_FOUND') {
          setState({ kind: 'not-found' });
          return;
        }
        // A refetch that fails keeps what is already shown.
        setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', code: failed.code }));
      },
    );
  }, [projectId]);

  const fetchServers = useCallback((): void => {
    void apiGet<ListServersResponse>('/api/servers').then((result) => {
      if (result.ok) setServers(result.data.items);
    });
  }, []);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);
  useEffect(() => {
    fetchServers();
  }, [fetchServers]);
  useEffect(() => registerResync(fetchProject), [registerResync, fetchProject]);
  useEffect(() => subscribeProjectsChanged(fetchProject), [fetchProject]);

  const leave = useCallback((): void => {
    router.push(PROJECTS_HREF);
  }, [router]);

  const openSheet = (): void => {
    setSheetOpen(true);
  };

  if (state.kind !== 'ready') {
    return (
      <>
        <Toolbar title="Project" backLink={{ href: PROJECTS_HREF, label: '← Projects' }} />
        <div className="mx-auto flex max-w-[1120px] flex-col gap-8 p-8">
          {state.kind === 'loading' ? (
            <div data-testid="project-loading">
              {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
                <SkeletonRow key={index} />
              ))}
            </div>
          ) : null}
          {state.kind === 'not-found' ? (
            <InsetGroup>
              <EmptyState
                data-testid="project-not-found"
                title="Project not found"
                body="It may have been deleted. Go back to see your projects."
                action={{ label: 'Back to projects', onClick: leave }}
              />
            </InsetGroup>
          ) : null}
          {state.kind === 'error' ? (
            <Banner
              data-testid="project-error-banner"
              message="Couldn't load this project. Check your connection and try again."
              errorCode={state.code}
              action={{
                label: 'Retry',
                onClick: () => {
                  setState({ kind: 'loading' });
                  fetchProject();
                },
              }}
            />
          ) : null}
        </div>
      </>
    );
  }

  const { project } = state;
  const environments = [...state.environments].sort(byName);
  const servicesByEnvironment = new Map<string, ServiceView[]>();
  for (const service of state.services) {
    const list = servicesByEnvironment.get(service.environmentId) ?? [];
    list.push(service);
    servicesByEnvironment.set(service.environmentId, list);
  }
  const deletingId = deleting?.id;

  return (
    <>
      <ProjectToolbar
        project={project}
        onProjectChange={(next) => {
          setState((prev) => (prev.kind === 'ready' ? { ...prev, project: next } : prev));
        }}
        onDeleted={leave}
        onNewEnvironment={openSheet}
      />
      <div className="mx-auto flex max-w-[1120px] flex-col gap-8 p-8">
        {environments.length === 0 ? (
          <InsetGroup data-testid="environments-list">
            <EmptyState
              data-testid="environments-empty"
              title="No environments yet"
              body={ENVIRONMENTS_EMPTY_BODY}
              action={{ label: 'New environment', onClick: openSheet }}
            />
          </InsetGroup>
        ) : (
          environments.map((environment) => {
            const services = (servicesByEnvironment.get(environment.id) ?? []).sort(byName);
            return (
              <section
                key={environment.id}
                id={`environment-${environment.id}`}
                className="flex scroll-mt-16 flex-col gap-2"
                data-testid={`environment-section-${environment.id}`}
                aria-labelledby={`environment-title-${environment.id}`}
              >
                <div className="group flex min-h-8 items-center justify-between gap-2 px-4">
                  <h2 id={`environment-title-${environment.id}`} className="min-w-0 truncate font-mono text-headline font-semibold text-ink">
                    {environment.name}
                  </h2>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      data-testid={`new-service-${environment.id}`}
                      onClick={() => {
                        setCreatingIn(environment.id);
                        setServiceSheetOpen(true);
                        fetchServers();
                      }}
                    >
                      New service
                    </Button>
                    <RowMenu
                      triggerLabel={`Actions for ${environment.name}`}
                      data-testid={menuTestId(environment.id)}
                      items={[
                        {
                          id: 'delete',
                          label: 'Delete environment',
                          destructive: true,
                          onSelect: () => {
                            setDeleting(environment);
                            setDeleteOpen(true);
                          },
                        },
                      ]}
                    />
                  </div>
                </div>
                <InsetGroup data-testid={`environment-services-${environment.id}`}>
                  {services.length === 0 ? (
                    <p className="px-4 py-3 text-callout text-ink-secondary">No services in this environment yet.</p>
                  ) : (
                    services.map((service) => (
                      <ListRow
                        key={service.id}
                        href={serviceHref(project.id, service.id)}
                        data-testid={`service-row-${service.id}`}
                        primaryText={<span title={service.name}>{service.name}</span>}
                        secondary={
                          <span className="font-mono" title={serviceSource(service)}>
                            {serviceSource(service)}
                          </span>
                        }
                      />
                    ))
                  )}
                </InsetGroup>
              </section>
            );
          })
        )}
      </div>
      <EnvironmentSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projectId={project.id}
        existingNames={environments.map((environment) => environment.name)}
        onCreated={fetchProject}
      />
      {creatingIn !== null ? (
        <ServiceSheet
          open={serviceSheetOpen}
          onOpenChange={setServiceSheetOpen}
          projectId={project.id}
          environmentId={creatingIn}
          servers={servers}
          onSaved={() => {
            fetchProject();
            notifyProjectsChanged();
          }}
        />
      ) : null}
      <ConfirmByNameDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${deleting?.name ?? 'environment'}?`}
        body="This permanently deletes the environment. Type the environment name to confirm."
        confirmLabel="Delete environment"
        requiredName={deleting?.name ?? ''}
        data-testid="environment-delete-dialog"
        returnFocusTo={() =>
          deletingId === undefined ? null : document.querySelector<HTMLElement>(`[data-testid="${menuTestId(deletingId)}"]`)
        }
        onConfirm={async (typed) => {
          if (deleting === null) return { ok: true };
          const target = deleting;
          const outcome = deleteOutcome(await deleteEnvironment(project.id, target.id, typed), {
            ENVIRONMENT_NOT_EMPTY: ENVIRONMENT_NOT_EMPTY_COPY,
          });
          if (outcome.ok) {
            setState((prev) =>
              prev.kind === 'ready'
                ? { ...prev, environments: prev.environments.filter((environment) => environment.id !== target.id) }
                : prev,
            );
            notifyProjectsChanged();
          }
          return outcome;
        }}
      />
    </>
  );
}
