// 13-05: typed calls for the deploy-engine routes the UI uses (docs/deploy-engine.md). Every call
// goes through api-client's apiGet/apiSend, so it shares the relative-path rule, the 15s timeout,
// the fixed ApiFailure vocabulary and the 401 `unauthorized` flag; nothing here retries.
//
// Response and request types are inferred from the control-plane's own Zod schemas through
// type-only imports. `import type` is erased at build, so no control-plane module reaches the
// browser bundle; the boundaries-ignore comments cover exactly these imports.
//
// Credentials are write-only (A2): the PUT bodies go out once, are never stored or logged here,
// and the only credential read returns presence, type and a deploy key's public half.

import type * as ApiContract from "@noodara/domain/api-contract";
import {
  deployApiGet,
  deployApiSend,
  type ApiFailure,
  type DeployApiErrorCode,
  type ApiResult as CoreApiResult,
} from "./api-client";

/** Every deploy-api call resolves to this: success, or a failure in the deploy-engine vocabulary. */
export type DeployApiResult<T> = CoreApiResult<T, DeployApiErrorCode>;
type ApiResult<T> = DeployApiResult<T>;

/** What a Zod schema parses to (its `z.output`), read without importing zod into apps/web. */
type Output<S> = S extends { readonly _zod: { readonly output: infer O } }
  ? O
  : never;
/** What a Zod schema accepts (its `z.input`). */
type Input<S> = S extends { readonly _zod: { readonly input: infer I } }
  ? I
  : never;

export type ProjectView = Output<typeof ApiContract.ProjectViewSchema>;
export type EnvironmentView = Output<
  typeof ApiContract.EnvironmentViewSchema
>;
export type ProjectList = Output<
  typeof ApiContract.ListProjectsResponseSchema
>;
export type EnvironmentList = Output<
  typeof ApiContract.ListEnvironmentsResponseSchema
>;
export type DeleteProjectResult = Output<
  typeof ApiContract.DeleteProjectResponseSchema
>;
export type CreateProjectBody = Input<
  typeof ApiContract.CreateProjectBodySchema
>;
export type UpdateProjectBody = Input<
  typeof ApiContract.UpdateProjectBodySchema
>;
export type CreateEnvironmentBody = Input<
  typeof ApiContract.CreateEnvironmentBodySchema
>;
export type UpdateEnvironmentBody = Input<
  typeof ApiContract.UpdateEnvironmentBodySchema
>;
export type DeleteEnvironmentResult = Output<
  typeof ApiContract.DeleteEnvironmentResponseSchema
>;

export type ServiceView = Output<typeof ApiContract.ServiceViewSchema>;
export type ServiceList = Output<
  typeof ApiContract.ListServicesResponseSchema
>;
export type UpdateServiceResult = Output<
  typeof ApiContract.UpdateServiceResponseSchema
>;
export type CreateServiceBody = Input<
  typeof ApiContract.CreateServiceBodySchema
>;
export type UpdateServiceBody = Input<
  typeof ApiContract.UpdateServiceBodySchema
>;
/** Presence, type and a deploy key's public half only: the response has no secret field. */
export type ServiceCredentials = Output<
  typeof ApiContract.ServiceCredentialsResponseSchema
>;
export type RepositoryCredentialBody = Input<
  typeof ApiContract.RepositoryCredentialBodySchema
>;
export type RegistryCredentialBody = Input<
  typeof ApiContract.RegistryCredentialBodySchema
>;
export type RuntimeLogs = Output<
  typeof ApiContract.RuntimeLogsResponseSchema
>;
export type RuntimeLogLine = RuntimeLogs["lines"][number];
/** The services routes declare these two 2xx bodies inline; they wrap the exported ServiceView. */
export interface ServiceOperationResult {
  readonly service: ServiceView;
}
export interface DeleteServiceResult {
  readonly ok: true;
  readonly serviceId: string;
}

export type DeploymentView = Output<
  typeof ApiContract.DeploymentViewSchema
>;
export type DeploymentList = Output<
  typeof ApiContract.DeploymentListResponseSchema
>;
export type DeploymentLogs = Output<
  typeof ApiContract.DeploymentLogsResponseSchema
>;
export type DeploymentLogChunk = Output<
  typeof ApiContract.DeploymentLogChunkViewSchema
>;
export type DeploymentLogPhase = DeploymentLogChunk["phase"];

/** One route per operation (`SERVICE_OPERATIONS` in apps/control-plane/src/deploy/service-ops.ts). */
export const SERVICE_OPERATIONS = Object.freeze([
  "stop",
  "restart",
  "remove",
] as const);
export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];

export const CREDENTIAL_SLOTS = Object.freeze([
  "repository",
  "registry",
] as const);
export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

/** Ids are UUIDs server-side. Anything outside this set (a slash, `..`, a query) never reaches a
 *  URL, so a bad id cannot redirect a call to another route. */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function invalidIdFailure(): ApiFailure<DeployApiErrorCode> {
  return {
    ok: false,
    code: "VALIDATION_FAILED",
    message: "This link is not valid.",
    unauthorized: false,
  };
}

/** `/api/...` template whose interpolations must be safe ids; null when one is not. */
function apiPath(
  strings: TemplateStringsArray,
  ...ids: readonly string[]
): string | null {
  let path = strings[0] ?? "";
  for (const [index, id] of ids.entries()) {
    if (!SAFE_ID_PATTERN.test(id)) return null;
    path += id + (strings[index + 1] ?? "");
  }
  return path;
}

function withQuery(
  path: string | null,
  query: Readonly<Record<string, string | number | undefined>>,
): string | null {
  if (path === null) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
}

function get<T>(path: string | null): Promise<ApiResult<T>> {
  return path === null
    ? Promise.resolve(invalidIdFailure())
    : deployApiGet<T>(path);
}

/** Mutations always carry a JSON body (`{}` when the route takes none): a JSON content type is
 *  never a CORS-simple request, so the browser sends Origin and the origin guard can check it. */
function send<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string | null,
  body: object = {},
  sensitive = false,
): Promise<ApiResult<T>> {
  if (path === null) return Promise.resolve(invalidIdFailure());
  return deployApiSend<T>(
    method,
    path,
    body,
    sensitive ? { sensitive: true } : {},
  );
}

// ---------------------------------------------------------------------------------------------
// Projects and environments
// ---------------------------------------------------------------------------------------------

export function listProjects(): Promise<ApiResult<ProjectList>> {
  return get("/api/projects");
}

export function getProject(projectId: string): Promise<ApiResult<ProjectView>> {
  return get(apiPath`/api/projects/${projectId}`);
}

export function createProject(
  body: CreateProjectBody,
): Promise<ApiResult<ProjectView>> {
  return send("POST", "/api/projects", body);
}

export function updateProject(
  projectId: string,
  body: UpdateProjectBody,
): Promise<ApiResult<ProjectView>> {
  return send("PATCH", apiPath`/api/projects/${projectId}`, body);
}

export function archiveProject(
  projectId: string,
): Promise<ApiResult<ProjectView>> {
  return send("POST", apiPath`/api/projects/${projectId}/archive`);
}

export function unarchiveProject(
  projectId: string,
): Promise<ApiResult<ProjectView>> {
  return send("POST", apiPath`/api/projects/${projectId}/unarchive`);
}

export function deleteProject(
  projectId: string,
  confirmName: string,
): Promise<ApiResult<DeleteProjectResult>> {
  return send("DELETE", apiPath`/api/projects/${projectId}`, { confirmName });
}

export function listEnvironments(
  projectId: string,
): Promise<ApiResult<EnvironmentList>> {
  return get(apiPath`/api/projects/${projectId}/environments`);
}

export function getEnvironment(
  projectId: string,
  environmentId: string,
): Promise<ApiResult<EnvironmentView>> {
  return get(apiPath`/api/projects/${projectId}/environments/${environmentId}`);
}

export function createEnvironment(
  projectId: string,
  body: CreateEnvironmentBody,
): Promise<ApiResult<EnvironmentView>> {
  return send("POST", apiPath`/api/projects/${projectId}/environments`, body);
}

export function updateEnvironment(
  projectId: string,
  environmentId: string,
  body: UpdateEnvironmentBody,
): Promise<ApiResult<EnvironmentView>> {
  return send(
    "PATCH",
    apiPath`/api/projects/${projectId}/environments/${environmentId}`,
    body,
  );
}

export function deleteEnvironment(
  projectId: string,
  environmentId: string,
  confirmName: string,
): Promise<ApiResult<DeleteEnvironmentResult>> {
  return send(
    "DELETE",
    apiPath`/api/projects/${projectId}/environments/${environmentId}`,
    { confirmName },
  );
}

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

export function listServices(
  projectId: string,
): Promise<ApiResult<ServiceList>> {
  return get(apiPath`/api/projects/${projectId}/services`);
}

export function getService(
  projectId: string,
  serviceId: string,
): Promise<ApiResult<ServiceView>> {
  return get(apiPath`/api/projects/${projectId}/services/${serviceId}`);
}

export function createService(
  projectId: string,
  body: CreateServiceBody,
): Promise<ApiResult<ServiceView>> {
  return send("POST", apiPath`/api/projects/${projectId}/services`, body);
}

export function updateService(
  projectId: string,
  serviceId: string,
  body: UpdateServiceBody,
): Promise<ApiResult<UpdateServiceResult>> {
  return send(
    "PATCH",
    apiPath`/api/projects/${projectId}/services/${serviceId}`,
    body,
  );
}

export function deleteService(
  projectId: string,
  serviceId: string,
  confirmName: string,
): Promise<ApiResult<DeleteServiceResult>> {
  return send(
    "DELETE",
    apiPath`/api/projects/${projectId}/services/${serviceId}`,
    { confirmName },
  );
}

/** Queued (202); the outcome arrives as a `service.updated` event. */
export function runServiceOperation(
  projectId: string,
  serviceId: string,
  operation: ServiceOperation,
): Promise<ApiResult<ServiceOperationResult>> {
  if (!SERVICE_OPERATIONS.includes(operation))
    return Promise.resolve(invalidIdFailure());
  return send(
    "POST",
    apiPath`/api/projects/${projectId}/services/${serviceId}/${operation}`,
  );
}

export function redeployService(
  projectId: string,
  serviceId: string,
): Promise<ApiResult<DeploymentView>> {
  return send(
    "POST",
    apiPath`/api/projects/${projectId}/services/${serviceId}/redeploy`,
  );
}

// ---------------------------------------------------------------------------------------------
// Credentials: write-only. Bodies are sent once and the failure path scrubs any echo of them.
// ---------------------------------------------------------------------------------------------

export function getServiceCredentials(
  projectId: string,
  serviceId: string,
): Promise<ApiResult<ServiceCredentials>> {
  return get(
    apiPath`/api/projects/${projectId}/services/${serviceId}/credentials`,
  );
}

export function setRepositoryCredential(
  projectId: string,
  serviceId: string,
  body: RepositoryCredentialBody,
): Promise<ApiResult<ServiceCredentials>> {
  return send(
    "PUT",
    apiPath`/api/projects/${projectId}/services/${serviceId}/credentials/repository`,
    body,
    true,
  );
}

export function setRegistryCredential(
  projectId: string,
  serviceId: string,
  body: RegistryCredentialBody,
): Promise<ApiResult<ServiceCredentials>> {
  return send(
    "PUT",
    apiPath`/api/projects/${projectId}/services/${serviceId}/credentials/registry`,
    body,
    true,
  );
}

export function removeServiceCredential(
  projectId: string,
  serviceId: string,
  slot: CredentialSlot,
): Promise<ApiResult<ServiceCredentials>> {
  if (!CREDENTIAL_SLOTS.includes(slot))
    return Promise.resolve(invalidIdFailure());
  return send(
    "DELETE",
    apiPath`/api/projects/${projectId}/services/${serviceId}/credentials/${slot}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Deployments and logs
// ---------------------------------------------------------------------------------------------

/** 201 with the QUEUED deployment. Never retried: a second POST would queue a second deploy. */
export function deployService(
  serviceId: string,
): Promise<ApiResult<DeploymentView>> {
  return send("POST", apiPath`/api/services/${serviceId}/deploy`);
}

export interface DeploymentListQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export function listDeployments(
  serviceId: string,
  query: DeploymentListQuery = {},
): Promise<ApiResult<DeploymentList>> {
  return get(
    withQuery(apiPath`/api/services/${serviceId}/deployments`, {
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
}

export function getServiceDeployment(
  serviceId: string,
  deploymentId: string,
): Promise<ApiResult<DeploymentView>> {
  return get(apiPath`/api/services/${serviceId}/deployments/${deploymentId}`);
}

export function getDeployment(
  deploymentId: string,
): Promise<ApiResult<DeploymentView>> {
  return get(apiPath`/api/deployments/${deploymentId}`);
}

/** 202 with the deployment. Never retried, same as deploy. */
export function cancelDeployment(
  deploymentId: string,
): Promise<ApiResult<DeploymentView>> {
  return send("POST", apiPath`/api/deployments/${deploymentId}/cancel`);
}

export interface DeploymentLogsQuery {
  readonly phase?: DeploymentLogPhase;
  readonly since?: number;
  readonly limit?: number;
}

/** Build-log chunks strictly after the (`phase`, `since`) cursor. */
export function getDeploymentLogs(
  deploymentId: string,
  query: DeploymentLogsQuery = {},
): Promise<ApiResult<DeploymentLogs>> {
  return get(
    withQuery(apiPath`/api/deployments/${deploymentId}/logs`, {
      phase: query.phase,
      since: query.since,
      limit: query.limit,
    }),
  );
}

/** One-shot runtime log tail (JSON); the follow stream lives in runtime-log-stream.ts. */
export function getRuntimeLogs(
  projectId: string,
  serviceId: string,
  query: { readonly tail?: number } = {},
): Promise<ApiResult<RuntimeLogs>> {
  return get(
    withQuery(apiPath`/api/projects/${projectId}/services/${serviceId}/logs`, {
      tail: query.tail,
    }),
  );
}

/** Path of the NDJSON follow stream, or null for an unsafe id. */
export function runtimeLogFollowPath(
  projectId: string,
  serviceId: string,
  tail?: number,
): string | null {
  return withQuery(
    apiPath`/api/projects/${projectId}/services/${serviceId}/logs/follow`,
    { tail },
  );
}
