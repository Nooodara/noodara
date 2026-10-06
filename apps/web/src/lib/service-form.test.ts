import { describe, expect, it } from 'vitest';
import type { ApiFailure, DeployApiErrorCode, ServerView } from './api-client';
import type { ServiceView } from './deploy-api';
import {
  BUILDKIT_UNAVAILABLE_COPY,
  PORT_IN_USE_COPY,
  SERVER_REQUIRED_COPY,
  SERVICE_NAME_TAKEN_COPY,
  buildCreateBody,
  buildEditBody,
  credentialNeedFor,
  eligibleServers,
  emptyServiceForm,
  mapServiceFailure,
  previewEdit,
  serviceFormFromView,
  sourceBody,
  validateServiceFields,
  type ServiceFormValues,
} from './service-form';

const SERVER_ID = '7d5c3a8e-2b1f-4c6d-9e0a-1f2b3c4d5e6f';

function form(patch: Partial<ServiceFormValues> = {}): ServiceFormValues {
  return {
    ...emptyServiceForm(SERVER_ID),
    name: 'web',
    repositoryUrl: 'https://github.com/acme/web.git',
    ...patch,
  };
}

const SERVICE_VIEW: ServiceView = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  environmentId: '33333333-3333-4333-8333-333333333333',
  serverId: SERVER_ID,
  name: 'web',
  sourceType: 'git',
  repositoryUrl: 'https://github.com/acme/web.git',
  branch: 'main',
  buildContext: '.',
  dockerfilePath: 'Dockerfile',
  buildTarget: null,
  imageRef: null,
  internalPort: 3000,
  publishedPort: null,
  status: 'RUNNING',
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
};

function server(patch: Partial<ServerView>): ServerView {
  return { id: 's', name: 's', host: 'h', status: 'CONNECTED', dockerInstalled: true, ...patch } as ServerView;
}

function failure(code: DeployApiErrorCode, extra: Partial<ApiFailure<DeployApiErrorCode>> = {}): ApiFailure<DeployApiErrorCode> {
  return { ok: false, code, message: 'Server says no', unauthorized: false, ...extra };
}

describe('service-form: source modes (A1)', () => {
  it('Git mode pins the root Dockerfile; Dockerfile mode sends the build paths; Image sends only the ref', () => {
    expect(sourceBody(form())).toEqual({
      kind: 'git',
      repositoryUrl: 'https://github.com/acme/web.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      target: null,
    });
    expect(sourceBody(form({ mode: 'dockerfile', buildContext: 'api', dockerfilePath: 'api/Dockerfile', target: 'prod' }))).toMatchObject({
      buildContext: 'api',
      dockerfilePath: 'api/Dockerfile',
      target: 'prod',
    });
    expect(sourceBody(form({ mode: 'image', imageRef: 'nginx:1.27' }))).toEqual({ kind: 'image', imageRef: 'nginx:1.27' });
  });

  it('builds a create body the domain accepts, with no env or build-arg key (A4)', () => {
    const result = buildCreateBody(form({ publishedPort: '8080' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      name: 'web',
      serverId: SERVER_ID,
      source: sourceBody(form()),
      internalPort: 3000,
      publishedPort: 8080,
    });
    expect(JSON.stringify(result.body)).not.toMatch(/env|buildArg|args/i);
  });

  it('reports each invalid field with the domain message and only checks the visible mode', () => {
    const errors = validateServiceFields(
      form({ name: 'Web App', serverId: '', branch: '-x', internalPort: 'abc', publishedPort: '22', imageRef: 'NOPE' }),
      'create',
    );
    expect(errors.name).toMatch(/lowercase slug/);
    expect(errors.serverId).toBe(SERVER_REQUIRED_COPY);
    expect(errors.branch).toBeDefined();
    expect(errors.internalPort).toMatch(/1 to 65535/);
    expect(errors.publishedPort).toMatch(/reserved/);
    expect(errors.imageRef).toBeUndefined();

    const image = validateServiceFields(form({ mode: 'image', imageRef: 'nginx', repositoryUrl: 'file:///x' }), 'create');
    expect(image.imageRef).toMatch(/tag/);
    expect(image.repositoryUrl).toBeUndefined();
  });

  it('checks Dockerfile paths only in Dockerfile mode', () => {
    expect(validateServiceFields(form({ buildContext: '../x' }), 'create').buildContext).toBeUndefined();
    const errors = validateServiceFields(form({ mode: 'dockerfile', buildContext: '../x', dockerfilePath: '/abs', target: '9bad' }), 'create');
    expect(errors.buildContext).toBeDefined();
    expect(errors.dockerfilePath).toBeDefined();
    expect(errors.target).toBeDefined();
  });

  it('does not ask for a server when editing', () => {
    expect(validateServiceFields(form({ serverId: '' }), 'edit').serverId).toBeUndefined();
  });
});

describe('service-form: git URL allowlist mirrors the server (H2)', () => {
  it.each([
    'https://github.com/acme/web.git',
    'ssh://git@github.com/acme/web.git',
    'ssh://git@github.com:2222/acme/web.git',
    'git@github.com:acme/web.git',
  ])('accepts %s', (url) => {
    expect(validateServiceFields(form({ repositoryUrl: url }), 'create').repositoryUrl).toBeUndefined();
  });

  it.each([
    'file:///etc/passwd',
    'ext::sh -c touch% /tmp/pwned',
    'git://github.com/acme/web.git',
    'http://github.com/acme/web.git',
    'javascript:alert(1)',
    'https://user:token@github.com/acme/web.git',
    'https://token@github.com/acme/web.git',
    '-oProxyCommand=touch /tmp/x',
    '--upload-pack=touch /tmp/x',
    'https://github.com/acme/../etc.git',
    'git@github.com:../../etc.git',
  ])('rejects %s before any request', (url) => {
    const result = buildCreateBody(form({ repositoryUrl: url }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.repositoryUrl).toBeDefined();
  });
});

describe('service-form: servers (A2)', () => {
  it('keeps only CONNECTED servers where Docker is installed', () => {
    const list = [
      server({ id: 'ok', status: 'CONNECTED', dockerInstalled: true }),
      server({ id: 'no-docker', status: 'CONNECTED', dockerInstalled: false }),
      server({ id: 'unknown-docker', status: 'CONNECTED', dockerInstalled: null }),
      server({ id: 'down', status: 'UNREACHABLE', dockerInstalled: true }),
      server({ id: 'pending', status: 'PENDING', dockerInstalled: true }),
    ];
    expect(eligibleServers(list).map((s) => s.id)).toEqual(['ok']);
    expect(eligibleServers([])).toEqual([]);
  });
});

describe('service-form: edit (A5)', () => {
  it('reads the mode back from a view', () => {
    expect(serviceFormFromView(SERVICE_VIEW).mode).toBe('git');
    expect(serviceFormFromView({ ...SERVICE_VIEW, dockerfilePath: 'api/Dockerfile' }).mode).toBe('dockerfile');
    expect(serviceFormFromView({ ...SERVICE_VIEW, buildTarget: 'prod' }).mode).toBe('dockerfile');
    expect(
      serviceFormFromView({ ...SERVICE_VIEW, sourceType: 'image', repositoryUrl: null, branch: null, imageRef: 'nginx:1.27' }).mode,
    ).toBe('image');
    expect(serviceFormFromView({ ...SERVICE_VIEW, publishedPort: 8080 }).publishedPort).toBe('8080');
  });

  it('a source change is a redeploy and sends only the changed field', () => {
    const values = { ...serviceFormFromView(SERVICE_VIEW), branch: 'release' };
    const plan = buildEditBody(SERVICE_VIEW, values);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.body.classification.kind).toBe('redeploy');
    expect(Object.keys(plan.body.body)).toEqual(['source']);
    expect(previewEdit(SERVICE_VIEW, values).kind).toBe('redeploy');
  });

  it('a rename alone is metadata; no change is none', () => {
    const renamed = buildEditBody(SERVICE_VIEW, { ...serviceFormFromView(SERVICE_VIEW), name: 'api' });
    expect(renamed.ok && renamed.body.classification.kind).toBe('metadata');
    expect(renamed.ok && renamed.body.body).toEqual({ name: 'api' });
    expect(previewEdit(SERVICE_VIEW, serviceFormFromView(SERVICE_VIEW)).kind).toBe('none');
  });

  it('a port change is a redeploy; an invalid form previews none', () => {
    expect(previewEdit(SERVICE_VIEW, { ...serviceFormFromView(SERVICE_VIEW), publishedPort: '8081' }).kind).toBe('redeploy');
    expect(previewEdit(SERVICE_VIEW, { ...serviceFormFromView(SERVICE_VIEW), internalPort: 'x' }).kind).toBe('none');
  });

  it('switching Git to Image is a source change', () => {
    const plan = buildEditBody(SERVICE_VIEW, { ...serviceFormFromView(SERVICE_VIEW), mode: 'image', imageRef: 'nginx:1.27' });
    expect(plan.ok && plan.body.body).toEqual({ source: { kind: 'image', imageRef: 'nginx:1.27' } });
  });
});

describe('service-form: server failures (A1, H3)', () => {
  it('maps a validator reason to its field with the server message', () => {
    expect(mapServiceFailure(failure('SERVICE_INPUT_INVALID', { reason: 'REPOSITORY_URL_UNSUPPORTED_SCHEME', message: 'Nope' }))).toEqual({
      repositoryUrl: 'Nope.',
    });
    expect(mapServiceFailure(failure('SERVICE_INPUT_INVALID', { reason: 'IMAGE_REF_TAG_REQUIRED' }))).toEqual({ imageRef: 'Server says no.' });
    expect(mapServiceFailure(failure('SERVICE_INPUT_INVALID'))).toEqual({ source: 'Server says no.' });
  });

  it('maps PORT_IN_USE, BUILDKIT and name conflicts to fields with a hint', () => {
    expect(mapServiceFailure(failure('PORT_IN_USE'))).toEqual({ publishedPort: PORT_IN_USE_COPY });
    expect(mapServiceFailure(failure('SERVER_BUILDKIT_UNAVAILABLE'))).toEqual({ source: BUILDKIT_UNAVAILABLE_COPY });
    expect(mapServiceFailure(failure('SERVICE_NAME_TAKEN'))).toEqual({ name: SERVICE_NAME_TAKEN_COPY });
    expect(mapServiceFailure(failure('SERVER_DOCKER_UNAVAILABLE'))?.serverId).toMatch(/Install Docker/);
    expect(mapServiceFailure(failure('CREDENTIAL_SOURCE_MISMATCH'))?.source).toMatch(/credential/);
  });

  it('returns null for failures with no field', () => {
    expect(mapServiceFailure(failure('INTERNAL_ERROR'))).toBeNull();
    expect(mapServiceFailure(failure('NETWORK_ERROR'))).toBeNull();
  });
});

describe('service-form: credential need', () => {
  it('https repos take a token, ssh repos a deploy key, images a registry password', () => {
    expect(credentialNeedFor({ sourceType: 'git', repositoryUrl: 'https://h/o/r.git' })).toBe('https_token');
    expect(credentialNeedFor({ sourceType: 'git', repositoryUrl: 'git@h:o/r.git' })).toBe('deploy_key');
    expect(credentialNeedFor({ sourceType: 'git', repositoryUrl: 'ssh://git@h/o/r.git' })).toBe('deploy_key');
    expect(credentialNeedFor({ sourceType: 'image', repositoryUrl: null })).toBe('registry_password');
  });
});
