import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen } from '@noodara/ui/testing';
import ServiceInspectorPage from './page';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000001';
const PATH = `/projects/${PROJECT_ID}/services/${SERVICE_ID}`;

const nav = vi.hoisted(() => ({
  params: {},
  search: '',
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => PATH,
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
}));
const stream = vi.hoisted(() => ({
  subscribeDeploy: () => () => undefined,
  subscribeDeploymentLog: () => () => undefined,
  registerResync: () => () => undefined,
  connected: true,
}));
vi.mock('../../../../../../../lib/shell-context', () => ({
  useDeployStream: () => stream,
}));
vi.mock('../../../../../../../components/BuildLogPanel', () => ({
  BuildLogPanel: (props: { serviceId: string; deploymentId: string }) => (
    <p data-testid="stub-build-log">{`${props.serviceId}/${props.deploymentId}`}</p>
  ),
  BUILD_LOG_NOT_FOUND_COPY: 'This deployment no longer exists or does not belong to this service.',
}));
vi.mock('../../../../../../../components/RuntimeLogPanel', () => ({
  RuntimeLogPanel: (props: { projectId: string; serviceId: string }) => (
    <p data-testid="stub-runtime-log">{`${props.projectId}/${props.serviceId}`}</p>
  ),
}));

beforeEach(() => {
  nav.params = { projectId: PROJECT_ID, serviceId: SERVICE_ID };
  nav.search = '';
  nav.replace.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('service inspector slot', () => {
  it('renders nothing with no selection, so the slot stays zero width', () => {
    const { container } = renderUi(<ServiceInspectorPage />);
    expect(container.innerHTML).toBe('');
  });

  it('opens the selected deployment build log from the URL', () => {
    nav.search = `deployment=${DEPLOYMENT_ID}`;
    renderUi(<ServiceInspectorPage />);
    expect(screen.getByRole('region', { name: 'Build log' })).toBeTruthy();
    expect(screen.getByTestId('stub-build-log').textContent).toBe(`${SERVICE_ID}/${DEPLOYMENT_ID}`);
  });

  it('opens runtime logs from the URL', () => {
    nav.search = 'logs=runtime';
    renderUi(<ServiceInspectorPage />);
    expect(screen.getByRole('region', { name: 'Runtime logs' })).toBeTruthy();
    expect(screen.getByTestId('stub-runtime-log').textContent).toBe(`${PROJECT_ID}/${SERVICE_ID}`);
  });

  it('renders not-found for a malformed deployment id instead of loading or throwing', () => {
    nav.search = 'deployment=..%2F..%2Fetc';
    renderUi(<ServiceInspectorPage />);
    expect(screen.getByTestId('inspector-not-found')).toBeTruthy();
    expect(screen.queryByTestId('stub-build-log')).toBeNull();
  });

  it('renders not-found for a malformed service id', () => {
    nav.params = { projectId: PROJECT_ID, serviceId: '..' };
    nav.search = 'logs=runtime';
    renderUi(<ServiceInspectorPage />);
    expect(screen.getByTestId('inspector-not-found')).toBeTruthy();
    expect(screen.queryByTestId('stub-runtime-log')).toBeNull();
  });

  it('moves focus in on open, closes with Escape and returns focus to what opened it', () => {
    const trigger = document.createElement('a');
    trigger.href = '#';
    trigger.textContent = 'deployment row';
    document.body.append(trigger);
    trigger.focus();

    nav.search = `deployment=${DEPLOYMENT_ID}`;
    renderUi(<ServiceInspectorPage />);
    const panel = screen.getByRole('region', { name: 'Build log' });
    expect(panel.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(nav.replace).toHaveBeenCalledWith(PATH, { scroll: false });
    expect(document.activeElement).toBe(trigger);
  });

  it('closes from the Close button too', () => {
    nav.search = 'logs=runtime';
    renderUi(<ServiceInspectorPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(nav.replace).toHaveBeenCalledWith(PATH, { scroll: false });
  });
});
