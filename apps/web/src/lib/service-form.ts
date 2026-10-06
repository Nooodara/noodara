// 13-11: pure state for the service create/edit sheet. Every field is checked with the same
// @noodara/domain validator the control plane runs (validateServiceCreateInput /
// validateServiceEditInput), so a value the server would reject is caught inline before any
// request. Credentials never pass through here: they are write-only and live in
// SourceCredentialFields, outside the form values.
import {
  classifyServiceEdit,
  validateBuildContextPath,
  validateBuildTarget,
  validateDockerfilePath,
  validateGitBranch,
  validateImageRef,
  validateInternalPort,
  validatePublishedPort,
  validateRepositoryUrl,
  validateResourceId,
  validateServiceCreateInput,
  validateServiceEditInput,
  validateServiceName,
  validateServiceSource,
  type ServiceEditClassification,
  type ServiceEditableFields,
  type ServiceName,
  type ContainerPort,
  type PublishedPort,
} from '@noodara/domain';
import type { ApiFailure, DeployApiErrorCode, ServerView } from './api-client';
import type { ServiceView } from './deploy-api';

/** Git builds the repository's Dockerfile at the root; Dockerfile exposes the build paths. Both
 *  are the domain's `git` source kind. */
export type SourceMode = 'git' | 'dockerfile' | 'image';

export const SOURCE_MODE_OPTIONS = [
  { value: 'git', label: 'Git' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'image', label: 'Image' },
] as const satisfies readonly { value: SourceMode; label: string }[];

export const DEFAULT_BUILD_CONTEXT = '.';
export const DEFAULT_DOCKERFILE_PATH = 'Dockerfile';

export interface ServiceFormValues {
  readonly name: string;
  readonly serverId: string;
  readonly mode: SourceMode;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly buildContext: string;
  readonly dockerfilePath: string;
  readonly target: string;
  readonly imageRef: string;
  readonly internalPort: string;
  readonly publishedPort: string;
}

/** `source` is the segmented control's own line: a source-level failure with no single field. */
export type ServiceFormField = Exclude<keyof ServiceFormValues, 'mode'> | 'source';
export type ServiceFormErrors = Partial<Record<ServiceFormField, string>>;

export function emptyServiceForm(serverId = ''): ServiceFormValues {
  return {
    name: '',
    serverId,
    mode: 'git',
    repositoryUrl: '',
    branch: 'main',
    buildContext: DEFAULT_BUILD_CONTEXT,
    dockerfilePath: DEFAULT_DOCKERFILE_PATH,
    target: '',
    imageRef: '',
    internalPort: '3000',
    publishedPort: '',
  };
}

function modeOf(view: ServiceView): SourceMode {
  if (view.sourceType === 'image') return 'image';
  const defaults =
    (view.buildContext ?? DEFAULT_BUILD_CONTEXT) === DEFAULT_BUILD_CONTEXT &&
    (view.dockerfilePath ?? DEFAULT_DOCKERFILE_PATH) === DEFAULT_DOCKERFILE_PATH &&
    view.buildTarget === null;
  return defaults ? 'git' : 'dockerfile';
}

export function serviceFormFromView(view: ServiceView): ServiceFormValues {
  return {
    name: view.name,
    serverId: view.serverId,
    mode: modeOf(view),
    repositoryUrl: view.repositoryUrl ?? '',
    branch: view.branch ?? 'main',
    buildContext: view.buildContext ?? DEFAULT_BUILD_CONTEXT,
    dockerfilePath: view.dockerfilePath ?? DEFAULT_DOCKERFILE_PATH,
    target: view.buildTarget ?? '',
    imageRef: view.imageRef ?? '',
    internalPort: String(view.internalPort),
    publishedPort: view.publishedPort === null ? '' : String(view.publishedPort),
  };
}

/** Only CONNECTED servers where discovery found Docker can run a service (A2). */
export function eligibleServers(servers: readonly ServerView[]): ServerView[] {
  return servers.filter((server) => server.status === 'CONNECTED' && server.dockerInstalled === true);
}

/** Digits only; anything else becomes NaN so the domain validator rejects it. */
function parsePort(text: string): number {
  const trimmed = text.trim();
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function parsePublishedPort(text: string): number | null {
  return text.trim() === '' ? null : parsePort(text);
}

/** The wire shape of the source for the current mode. Git mode pins the root Dockerfile. */
export function sourceBody(values: ServiceFormValues): Record<string, unknown> {
  if (values.mode === 'image') return { kind: 'image', imageRef: values.imageRef.trim() };
  if (values.mode === 'git') {
    return {
      kind: 'git',
      repositoryUrl: values.repositoryUrl.trim(),
      branch: values.branch.trim(),
      buildContext: DEFAULT_BUILD_CONTEXT,
      dockerfilePath: DEFAULT_DOCKERFILE_PATH,
      target: null,
    };
  }
  const target = values.target.trim();
  return {
    kind: 'git',
    repositoryUrl: values.repositoryUrl.trim(),
    branch: values.branch.trim(),
    buildContext: values.buildContext.trim(),
    dockerfilePath: values.dockerfilePath.trim(),
    target: target === '' ? null : target,
  };
}

function sentence(message: string): string {
  return message.endsWith('.') ? message : `${message}.`;
}

export const SERVER_REQUIRED_COPY = 'Choose a server to run this service on.';

/** Per-field checks with the domain validators, so each error lands under its own input. */
export function validateServiceFields(values: ServiceFormValues, intent: 'create' | 'edit'): ServiceFormErrors {
  const errors: Record<string, string> = {};
  const check = (field: ServiceFormField, result: { ok: true } | { ok: false; message: string }): void => {
    if (!result.ok) errors[field] = sentence(result.message);
  };

  check('name', validateServiceName(values.name.trim()));
  if (intent === 'create' && !validateResourceId(values.serverId).ok) errors.serverId = SERVER_REQUIRED_COPY;
  if (values.mode === 'image') {
    check('imageRef', validateImageRef(values.imageRef.trim()));
  } else {
    check('repositoryUrl', validateRepositoryUrl(values.repositoryUrl.trim()));
    check('branch', validateGitBranch(values.branch.trim()));
    if (values.mode === 'dockerfile') {
      check('buildContext', validateBuildContextPath(values.buildContext.trim()));
      check('dockerfilePath', validateDockerfilePath(values.dockerfilePath.trim()));
      if (values.target.trim() !== '') check('target', validateBuildTarget(values.target.trim()));
    }
  }
  check('internalPort', validateInternalPort(parsePort(values.internalPort)));
  check('publishedPort', validatePublishedPort(parsePublishedPort(values.publishedPort)));
  return errors;
}

export interface ServiceCreatePayload {
  readonly name: string;
  readonly serverId: string;
  readonly source: Record<string, unknown>;
  readonly internalPort: number;
  readonly publishedPort: number | null;
}

export type FormCheck<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly errors: ServiceFormErrors };

function hasErrors(errors: ServiceFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function buildCreateBody(values: ServiceFormValues): FormCheck<ServiceCreatePayload> {
  const errors = validateServiceFields(values, 'create');
  if (hasErrors(errors)) return { ok: false, errors };
  const body: ServiceCreatePayload = {
    name: values.name.trim(),
    serverId: values.serverId,
    source: sourceBody(values),
    internalPort: parsePort(values.internalPort),
    publishedPort: parsePublishedPort(values.publishedPort),
  };
  // Whole-input check, same function as the server: a disagreement still never sends.
  const whole = validateServiceCreateInput(body);
  if (!whole.ok) return { ok: false, errors: { source: sentence(whole.message) } };
  return { ok: true, body };
}

/** The view's current values in domain types; null when a stored value no longer validates. */
function currentFields(view: ServiceView): ServiceEditableFields | null {
  const values = serviceFormFromView(view);
  const source = validateServiceSource(sourceBody({ ...values, mode: view.sourceType === 'image' ? 'image' : 'dockerfile' }));
  if (!source.ok) return null;
  return {
    name: view.name as ServiceName,
    source: source.value,
    internalPort: view.internalPort as ContainerPort,
    publishedPort: view.publishedPort as PublishedPort | null,
  };
}

export interface ServiceEditPlan {
  readonly body: Record<string, unknown>;
  readonly classification: ServiceEditClassification;
}

/** Changed fields only, plus classifyServiceEdit's verdict (A5). */
export function buildEditBody(view: ServiceView, values: ServiceFormValues): FormCheck<ServiceEditPlan> {
  const errors = validateServiceFields(values, 'edit');
  if (hasErrors(errors)) return { ok: false, errors };
  const full: Record<string, unknown> = {
    name: values.name.trim(),
    source: sourceBody(values),
    internalPort: parsePort(values.internalPort),
    publishedPort: parsePublishedPort(values.publishedPort),
  };
  const edit = validateServiceEditInput(full);
  if (!edit.ok) return { ok: false, errors: { source: sentence(edit.message) } };
  const current = currentFields(view);
  const classification: ServiceEditClassification =
    current === null
      ? { kind: 'redeploy', changedFields: ['name', 'source', 'internalPort', 'publishedPort'] }
      : classifyServiceEdit(current, edit.value);
  const body: Record<string, unknown> = {};
  for (const field of classification.changedFields) body[field] = full[field];
  return { ok: true, body: { body, classification } };
}

/** Live verdict for the redeploy notice; `none` while the form does not validate yet. */
export function previewEdit(view: ServiceView, values: ServiceFormValues): ServiceEditClassification {
  const plan = buildEditBody(view, values);
  return plan.ok ? plan.body.classification : { kind: 'none', changedFields: [] };
}

// ---------------------------------------------------------------------------------------------
// Server failures mapped to fields (A1 "shows the server error when they disagree", H3)
// ---------------------------------------------------------------------------------------------

const REASON_FIELDS: readonly (readonly [string, ServiceFormField])[] = [
  ['SERVICE_NAME', 'name'],
  ['REPOSITORY_URL', 'repositoryUrl'],
  ['GIT_BRANCH', 'branch'],
  ['BUILD_CONTEXT', 'buildContext'],
  ['DOCKERFILE_PATH', 'dockerfilePath'],
  ['BUILD_TARGET', 'target'],
  ['IMAGE_REF', 'imageRef'],
  ['INTERNAL_PORT', 'internalPort'],
  ['PUBLISHED_PORT', 'publishedPort'],
  ['RESOURCE_ID', 'serverId'],
];

export const SERVICE_NAME_TAKEN_COPY = 'A service with this name already exists in this environment. Choose another name.';
export const PORT_IN_USE_COPY =
  'This port is already published on the server. Choose another published port, or leave it empty to keep the service unpublished.';
export const DOCKER_UNAVAILABLE_COPY =
  "Docker isn't available on this server. Install Docker, then run discovery again from the server page.";
export const BUILDKIT_UNAVAILABLE_COPY =
  "This server's Docker can't build with BuildKit. Enable BuildKit (Docker 23 or later) or use the Image source.";
export const CREDENTIAL_MISMATCH_COPY =
  "The saved credential doesn't match this source. Replace or remove it under Access before saving.";
export const SERVICE_INPUT_FALLBACK_COPY = 'The server rejected this source. Check the fields and try again.';

/** Null when the failure has no field: the sheet shows its own banner copy instead. */
export function mapServiceFailure(failure: ApiFailure<DeployApiErrorCode>): ServiceFormErrors | null {
  switch (failure.code) {
    case 'SERVICE_NAME_TAKEN':
      return { name: SERVICE_NAME_TAKEN_COPY };
    case 'PORT_IN_USE':
      return { publishedPort: PORT_IN_USE_COPY };
    case 'SERVER_DOCKER_UNAVAILABLE':
      return { serverId: DOCKER_UNAVAILABLE_COPY };
    case 'SERVER_BUILDKIT_UNAVAILABLE':
      return { source: BUILDKIT_UNAVAILABLE_COPY };
    case 'CREDENTIAL_SOURCE_MISMATCH':
      return { source: CREDENTIAL_MISMATCH_COPY };
    case 'SERVICE_INPUT_INVALID': {
      const reason = failure.reason ?? '';
      const match = REASON_FIELDS.find(([prefix]) => reason.startsWith(prefix));
      const message = failure.message.trim() === '' ? SERVICE_INPUT_FALLBACK_COPY : sentence(failure.message);
      return { [match?.[1] ?? 'source']: message };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Credentials: which slot and kind a source needs. Values are never handled here.
// ---------------------------------------------------------------------------------------------

export type CredentialNeed = 'https_token' | 'deploy_key' | 'registry_password';

export function credentialNeedFor(view: Pick<ServiceView, 'sourceType' | 'repositoryUrl'>): CredentialNeed {
  if (view.sourceType === 'image') return 'registry_password';
  return (view.repositoryUrl ?? '').startsWith('https://') ? 'https_token' : 'deploy_key';
}
