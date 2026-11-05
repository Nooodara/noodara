'use client';

// 30-03: the project's Infrastructure Graph page. Reads GET /api/projects/:id/graph once on mount
// and on stream (re)open; every node links to its detail page (InfrastructureGraph).
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, EmptyState, InsetGroup, Notice, SkeletonRow } from '@noodara/ui';
import { buildGraphModel, type GraphModel } from '../../../../../components/graph/graph-model';
import { InfrastructureGraph, useGraphLayout } from '../../../../../components/graph/InfrastructureGraph';
import { isRoutableId, PROJECTS_HREF, projectHref } from '../../../../../components/ProjectNav';
import { Toolbar } from '../../../../../components/Toolbar';
import { getProjectGraph } from '../../../../../lib/api/graph-api';
import { requireSession } from '../../../../../lib/require-session';
import { useShellContext } from '../../../../../lib/shell-context';

type PageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'ready'; readonly model: GraphModel };

const SKELETON_ROW_COUNT = 4;

export default function ProjectGraphPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();
  const { registerResync } = useShellContext();
  const layout = useGraphLayout();
  const [state, setState] = useState<PageState>(() => (isRoutableId(projectId) ? { kind: 'loading' } : { kind: 'not-found' }));
  const latestRequest = useRef(0);

  const fetchGraph = useCallback((): void => {
    if (!isRoutableId(projectId)) return;
    latestRequest.current += 1;
    const request = latestRequest.current;
    void getProjectGraph(projectId).then((result) => {
      if (request !== latestRequest.current) return;
      if (result.ok) {
        setState({ kind: 'ready', model: buildGraphModel(result.data) });
        return;
      }
      if (result.unauthorized) {
        void requireSession();
        return;
      }
      if (result.code === 'NOT_FOUND') {
        setState({ kind: 'not-found' });
        return;
      }
      setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', code: result.code }));
    });
  }, [projectId]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);
  useEffect(() => registerResync(fetchGraph), [registerResync, fetchGraph]);

  const backLink = isRoutableId(projectId)
    ? { href: projectHref(projectId), label: '← Project' }
    : { href: PROJECTS_HREF, label: '← Projects' };
  const title = state.kind === 'ready' && state.model.project !== null ? `${state.model.project.label} graph` : 'Graph';

  return (
    <>
      <Toolbar title={title} backLink={backLink} />
      <div className="mx-auto flex max-w-[1120px] flex-col gap-6 p-4 sm:p-8" data-testid="graph-page">
        {state.kind === 'loading' ? (
          <div data-testid="graph-loading">
            {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
              <SkeletonRow key={index} />
            ))}
          </div>
        ) : null}
        {state.kind === 'not-found' ? (
          <InsetGroup>
            <EmptyState
              data-testid="graph-not-found"
              title="Project not found"
              body="It may have been deleted. Go back to see your projects."
              action={{
                label: 'Back to projects',
                onClick: () => {
                  router.push(PROJECTS_HREF);
                },
              }}
            />
          </InsetGroup>
        ) : null}
        {state.kind === 'error' ? (
          <Banner
            data-testid="graph-error"
            message="Couldn't load the graph. Check your connection and try again."
            errorCode={state.code}
            action={{
              label: 'Retry',
              onClick: () => {
                setState({ kind: 'loading' });
                fetchGraph();
              },
            }}
          />
        ) : null}
        {state.kind === 'ready' ? (
          <>
            {state.model.truncated ? (
              <Notice data-testid="graph-truncated" message="This graph is too large to show in full. Some nodes are hidden." />
            ) : null}
            {state.model.environments.length === 0 ? (
              <InsetGroup>
                <EmptyState
                  data-testid="graph-empty"
                  title="Nothing to show yet"
                  body="Environments and services appear here once you create them."
                />
              </InsetGroup>
            ) : (
              <InfrastructureGraph model={state.model} layout={layout} />
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
