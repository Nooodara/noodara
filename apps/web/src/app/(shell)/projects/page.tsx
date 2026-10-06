'use client';

// 13-09: the projects list. Active projects first; archived ones sit in their own group that says
// they reject deploys. Creating happens in ProjectSheet over this view. The list refetches on
// stream (re)open and whenever a project changes in this tab (the projects-changed bus).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, EmptyState, InsetGroup, ListRow, SkeletonRow } from '@noodara/ui';
import { Toolbar } from '../../../components/Toolbar';
import { ProjectSheet } from '../../../components/ProjectSheet';
import { isRoutableId, projectHref, subscribeProjectsChanged } from '../../../components/ProjectNav';
import { listProjects, type ProjectView } from '../../../lib/deploy-api';
import { requireSession } from '../../../lib/require-session';
import { useShellContext } from '../../../lib/shell-context';

type PageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'ready'; readonly projects: readonly ProjectView[] };

const SKELETON_ROW_COUNT = 3;

const PROJECTS_EMPTY_BODY = 'A project holds environments, and each environment runs your services.';
const PROJECTS_ARCHIVED_NOTE = 'Archived projects reject new deploys.';

function byName(a: ProjectView, b: ProjectView): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function ProjectRow({ project }: { readonly project: ProjectView }) {
  return (
    <ListRow
      href={projectHref(project.id)}
      data-testid={`project-row-${project.id}`}
      primaryText={<span title={project.name}>{project.name}</span>}
      secondary={
        project.description === null || project.description === '' ? (
          <span className="font-mono">{project.slug}</span>
        ) : (
          <span title={project.description}>{project.description}</span>
        )
      }
    />
  );
}

export default function ProjectsPage() {
  const { registerResync } = useShellContext();
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const latestRequest = useRef(0);

  const fetchProjects = useCallback((): void => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    void listProjects().then((result) => {
      if (request !== latestRequest.current) return;
      if (result.ok) {
        setState({ kind: 'ready', projects: result.data.items.filter((project) => isRoutableId(project.id)) });
        return;
      }
      if (result.unauthorized) {
        void requireSession();
        return;
      }
      // A refetch that fails keeps the list already shown.
      setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', code: result.code }));
    });
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);
  useEffect(() => registerResync(fetchProjects), [registerResync, fetchProjects]);
  useEffect(() => subscribeProjectsChanged(fetchProjects), [fetchProjects]);

  const openSheet = (): void => {
    setSheetOpen(true);
  };
  const isEmpty = state.kind === 'ready' && state.projects.length === 0;
  const active = state.kind === 'ready' ? state.projects.filter((p) => p.archivedAt === null).sort(byName) : [];
  const archived = state.kind === 'ready' ? state.projects.filter((p) => p.archivedAt !== null).sort(byName) : [];

  return (
    <>
      <Toolbar
        title="Projects"
        primaryAction={
          state.kind !== 'ready' || isEmpty ? undefined : (
            <Button variant="primary" data-testid="projects-new-button" onClick={openSheet}>
              New project
            </Button>
          )
        }
      />
      <div className="mx-auto flex max-w-[1120px] flex-col gap-8 p-8">
        {state.kind === 'loading' ? (
          <div data-testid="projects-loading">
            {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
              <SkeletonRow key={index} />
            ))}
          </div>
        ) : null}
        {state.kind === 'error' ? (
          <Banner
            data-testid="projects-error-banner"
            message="Couldn't load projects. Check your connection and try again."
            errorCode={state.code}
            action={{
              label: 'Retry',
              onClick: () => {
                setState({ kind: 'loading' });
                fetchProjects();
              },
            }}
          />
        ) : null}
        {isEmpty ? (
          <InsetGroup data-testid="projects-list">
            <EmptyState
              data-testid="projects-empty"
              title="No projects yet"
              body={PROJECTS_EMPTY_BODY}
              action={{ label: 'New project', onClick: openSheet }}
            />
          </InsetGroup>
        ) : null}
        {active.length > 0 ? (
          <InsetGroup data-testid="projects-list">
            {active.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </InsetGroup>
        ) : null}
        {archived.length > 0 ? (
          <section className="flex flex-col gap-2" data-testid="projects-archived">
            <InsetGroup title="Archived">
              {archived.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </InsetGroup>
            <p className="px-4 text-caption text-ink-secondary">{PROJECTS_ARCHIVED_NOTE}</p>
          </section>
        ) : null}
      </div>
      <ProjectSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  );
}
