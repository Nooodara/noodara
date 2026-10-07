// 12-08: services (SVC-05). Input is validated by the domain before any query, so a bad field
// fails by name (H1). Each mutation commits its row and its activity event in one transaction and
// publishes `service.updated` after the commit (D22). The server row is locked FOR NO KEY UPDATE
// before the port check, so two writes claiming a port on one server run one after the other and
// the second sees the first (H2); unrelated FK inserts are not blocked by that lock mode.
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  classifyServiceEdit,
  validateServiceCreateInput,
  validateServiceEditInput,
  type ServiceEditableFields,
  type ServiceEditField,
} from '@noodara/domain';
import {
  deriveServiceStatus,
  NON_TERMINAL_DEPLOYMENT_STATUSES,
  preflightPublishedPort,
  type ContainerObservation,
  type DeploymentStatus,
  type PortOwner,
} from '@noodara/domain/deployment';
import type { ServiceSource } from '@noodara/domain/validators';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { Database } from '../db/client.js';
import { gitHostKeyColumnsForUrlChange } from '../db/git-host-key-store.js';
import { deployments } from '../db/schema/deployments.js';
import { environments } from '../db/schema/environments.js';
import { projects } from '../db/schema/projects.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import type { ServiceOperation, ServiceRemoteCleanup } from '../deploy/service-ops.js';
import type { RecordServiceOperationInput, ServiceOperationQueue, ServiceOperationTarget } from '../deploy/service-ops-job.js';
import { buildServiceUpdatedEvent } from '../events/deploy-engine-events.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import type { MasterKeys, ServiceActor } from './server-service-deps.js';
import {
  credentialChangesForSource,
  deleteCredentialRows,
  getServiceCredentials,
  masterKeysFromEnvironment,
  removeServiceCredential,
  setRegistryCredential,
  setRepositoryCredential,
  type RegistryCredentialInput,
  type RepositoryCredentialInput,
  type ServiceCredentialsResult,
  type ServiceCredentialsView,
  type ServiceCredentialTarget,
} from './service-credentials.js';
import { containerObservationFromCache, toServiceView, type ServiceRow, type ServiceView } from './service-view.js';
import { nextUpdatedAt } from './updated-at.js';

export interface PanelPort {
  readonly port: number;
  readonly label: string;
}

export interface ServiceServicesDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly events: ServerEventPublisher;
  /** The panel's own host ports (API and public URL); a service may never publish on them. */
  readonly panelPorts: readonly PanelPort[];
  /** Master keys for credential envelopes; defaults to the environment's, resolved lazily. */
  readonly masterKeys?: () => Promise<MasterKeys>;
  /** 12-14: the stop/restart/remove producer; without it an operation is QUEUE_UNAVAILABLE. */
  readonly operationQueue?: ServiceOperationQueue;
  /** 12-14: remote cleanup on delete; without it a deployed service cannot be deleted. */
  readonly remoteCleanup?: ServiceRemoteCleanup;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const SERVICE_NAME_UNIQUE_CONSTRAINT = 'services_environment_name_lower_unique_idx';
const PANEL_LABEL = 'Noodara panel';

/** The API port plus the public URL's port (or its scheme default), deduplicated. */
export function panelPortsFromEnv(input: { readonly apiPort: number; readonly publicUrl: string }): PanelPort[] {
  const ports = [input.apiPort];
  try {
    const url = new URL(input.publicUrl);
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : null;
    if (port !== null) ports.push(port);
  } catch {
    // env.ts validates NOODARA_PUBLIC_URL at boot; an unparsable value only loses the extra port.
  }
  return [...new Set(ports)].map((port) => ({ port, label: PANEL_LABEL }));
}

type SourceColumns = Pick<
  ServiceRow,
  'sourceType' | 'repositoryUrl' | 'branch' | 'buildContext' | 'dockerfilePath' | 'buildTarget' | 'imageRef'
>;

/** Every source column is written, so switching kinds clears the other kind's columns. */
export function serviceColumnsFromSource(source: ServiceSource): SourceColumns {
  if (source.kind === 'image') {
    return {
      sourceType: 'image',
      repositoryUrl: null,
      branch: null,
      buildContext: null,
      dockerfilePath: null,
      buildTarget: null,
      imageRef: source.imageRef,
    };
  }
  return {
    sourceType: 'git',
    repositoryUrl: source.repositoryUrl,
    branch: source.branch,
    buildContext: source.buildContext,
    dockerfilePath: source.dockerfilePath,
    buildTarget: source.target,
    imageRef: null,
  };
}

/** The stored row as the domain's editable shape (the row was validated when written). */
export function editableFieldsFromRow(
  row: SourceColumns & Pick<ServiceRow, 'name' | 'internalPort' | 'publishedPort'>,
): ServiceEditableFields {
  const source =
    row.sourceType === 'image'
      ? { kind: 'image', imageRef: row.imageRef }
      : {
          kind: 'git',
          repositoryUrl: row.repositoryUrl,
          branch: row.branch,
          buildContext: row.buildContext,
          dockerfilePath: row.dockerfilePath,
          target: row.buildTarget,
        };
  return {
    name: row.name,
    source,
    internalPort: row.internalPort,
    publishedPort: row.publishedPort,
  } as ServiceEditableFields;
}

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

interface Failure<Code extends string> {
  readonly ok: false;
  readonly code: Code;
  readonly message: string;
}

export interface ServiceInputInvalid {
  readonly ok: false;
  readonly code: 'SERVICE_INPUT_INVALID';
  readonly message: string;
  /** The domain validator's own code, e.g. `REPOSITORY_URL_UNSUPPORTED_SCHEME`. */
  readonly reason: string;
}

function inputInvalid(failure: { code: string; message: string }): ServiceInputInvalid {
  return { ok: false, code: 'SERVICE_INPUT_INVALID', message: failure.message, reason: failure.code };
}

function notFound(kind: 'Project' | 'Environment' | 'Server' | 'Service', id: string): Failure<'NOT_FOUND'> {
  return { ok: false, code: 'NOT_FOUND', message: `${kind} "${id}" not found` };
}

function nameTaken(name: string): Failure<'SERVICE_NAME_TAKEN'> {
  return { ok: false, code: 'SERVICE_NAME_TAKEN', message: `This environment already has a service named "${name}"` };
}

function portInUse(port: number, owner: PortOwner): Failure<'PORT_IN_USE'> {
  const by =
    owner.kind === 'panel'
      ? `the ${owner.label}`
      : owner.kind === 'service'
        ? 'another service on this server'
        : 'a container on this server';
  return { ok: false, code: 'PORT_IN_USE', message: `Port ${port.toString()} is already used by ${by}` };
}

function buildkitUnavailable(): Failure<'SERVER_BUILDKIT_UNAVAILABLE'> {
  return {
    ok: false,
    code: 'SERVER_BUILDKIT_UNAVAILABLE',
    message: 'Dockerfile builds need Docker BuildKit on this server; use an image source or enable BuildKit',
  };
}

function actorFields(actor: ServiceActor): { actorType: 'user' | 'system'; actorId: string | null } {
  return { actorType: actor.type, actorId: actor.type === 'user' ? actor.id : null };
}

/** drizzle wraps the `pg` error; `.code`/`.constraint` live on `cause` (see project-services.ts). */
function uniqueViolationConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' ? cause.constraint : undefined;
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

type ServerGuardRow = Pick<
  typeof servers.$inferSelect,
  'id' | 'status' | 'dockerInstalled' | 'dockerBuildkitAvailable'
>;

/** FOR NO KEY UPDATE: serializes port claims per server without blocking FK key-share locks. */
async function lockServer(tx: Transaction, serverId: string): Promise<ServerGuardRow | undefined> {
  const [row] = await tx
    .select({
      id: servers.id,
      status: servers.status,
      dockerInstalled: servers.dockerInstalled,
      dockerBuildkitAvailable: servers.dockerBuildkitAvailable,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .for('no key update');
  return row;
}

async function serviceNameInUse(tx: Transaction, environmentId: string, name: string, exceptId?: string): Promise<boolean> {
  const sameName = and(eq(services.environmentId, environmentId), sql`lower(${services.name}) = lower(${name})`);
  const [row] = await tx
    .select({ id: services.id })
    .from(services)
    .where(exceptId === undefined ? sameName : and(sameName, ne(services.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

async function checkPublishedPort(
  tx: Transaction,
  deps: ServiceServicesDeps,
  serverId: string,
  serviceId: string,
  publishedPort: number | null,
): Promise<Failure<'PORT_IN_USE'> | null> {
  if (publishedPort === null) return null;
  const otherServices = await tx
    .select({ serviceId: services.id, publishedPort: services.publishedPort })
    .from(services)
    .where(and(eq(services.serverId, serverId), isNotNull(services.publishedPort)));
  // No `docker ps` here: the engine's pre-deploy preflight checks the live containers (D10).
  const result = preflightPublishedPort({
    serviceId,
    publishedPort,
    otherServices,
    panelPorts: deps.panelPorts,
    containers: [],
  });
  return result.ok ? null : portInUse(result.port, result.owner);
}

type Reader = Pick<Database, 'selectDistinctOn'>;

async function latestDeploymentStatuses(db: Reader, serviceIds: readonly string[]): Promise<Map<string, DeploymentStatus>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([deployments.serviceId], { serviceId: deployments.serviceId, status: deployments.status })
    .from(deployments)
    .where(inArray(deployments.serviceId, [...serviceIds]))
    .orderBy(deployments.serviceId, desc(deployments.createdAt), desc(deployments.id));
  return new Map(rows.map((row) => [row.serviceId, row.status]));
}

async function viewOf(db: Reader, row: ServiceRow): Promise<ServiceView> {
  const status = (await latestDeploymentStatuses(db, [row.id])).get(row.id);
  return toServiceView(row, status === undefined ? null : { status });
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** `null` when the project does not exist. */
export async function listServices(deps: ServiceServicesDeps, projectId: string): Promise<ServiceView[] | null> {
  const [project] = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  const rows = await deps.db.select().from(services).where(eq(services.projectId, projectId)).orderBy(asc(services.name), asc(services.id));
  const latest = await latestDeploymentStatuses(deps.db, rows.map((row) => row.id));
  return rows.map((row) => {
    const status = latest.get(row.id);
    return toServiceView(row, status === undefined ? null : { status });
  });
}

/** Scoped by both ids: a service of another project reads exactly like a missing one (A4). */
export async function getService(deps: ServiceServicesDeps, projectId: string, serviceId: string): Promise<ServiceView | null> {
  const [row] = await deps.db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.projectId, projectId)))
    .limit(1);
  return row ? viewOf(deps.db, row) : null;
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface CreateServiceInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly environmentId: string;
  /** The raw body minus `environmentId`; the domain validator rejects any other key by name. */
  readonly fields: unknown;
}

export type CreateServiceFailureCode =
  | 'SERVICE_INPUT_INVALID'
  | 'NOT_FOUND'
  | 'SERVER_NOT_CONNECTED'
  | 'SERVER_DOCKER_UNAVAILABLE'
  | 'SERVER_BUILDKIT_UNAVAILABLE'
  | 'SERVICE_NAME_TAKEN'
  | 'PORT_IN_USE';

export type CreateServiceResult =
  | { readonly ok: true; readonly service: ServiceView }
  | ServiceInputInvalid
  | Failure<Exclude<CreateServiceFailureCode, 'SERVICE_INPUT_INVALID'>>;

export async function createService(deps: ServiceServicesDeps, input: CreateServiceInput): Promise<CreateServiceResult> {
  const validated = validateServiceCreateInput(input.fields);
  if (!validated.ok) return inputInvalid(validated);
  const fields = validated.value;
  const serviceId = uuidv7();

  let result: CreateServiceResult;
  try {
    result = await deps.db.transaction(async (tx): Promise<CreateServiceResult> => {
      // FOR SHARE: a concurrent project delete waits for this insert, never races past it.
      const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).for('share');
      if (!project) return notFound('Project', input.projectId);
      // FOR KEY SHARE (13-01): a concurrent environment delete (FOR UPDATE) either waits for this
      // insert and then sees the service, or commits first and this lookup finds no row (404).
      const [environment] = await tx
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, input.environmentId), eq(environments.projectId, project.id)))
        .limit(1)
        .for('key share');
      if (!environment) return notFound('Environment', input.environmentId);

      const server = await lockServer(tx, fields.serverId);
      if (!server) return notFound('Server', fields.serverId);
      if (server.status !== 'CONNECTED') {
        return { ok: false, code: 'SERVER_NOT_CONNECTED', message: 'The server must be connected before it can run services' };
      }
      if (server.dockerInstalled !== true) {
        return { ok: false, code: 'SERVER_DOCKER_UNAVAILABLE', message: 'Docker is not installed on this server' };
      }
      // ADR 0008 G3: unknown (null) BuildKit support is treated as unavailable.
      if (fields.source.kind === 'git' && server.dockerBuildkitAvailable !== true) return buildkitUnavailable();

      if (await serviceNameInUse(tx, environment.id, fields.name)) return nameTaken(fields.name);
      const portFailure = await checkPublishedPort(tx, deps, server.id, serviceId, fields.publishedPort);
      if (portFailure) return portFailure;

      const now = deps.now();
      const [row] = await tx
        .insert(services)
        .values({
          id: serviceId,
          projectId: project.id,
          environmentId: environment.id,
          serverId: server.id,
          name: fields.name,
          ...serviceColumnsFromSource(fields.source),
          internalPort: fields.internalPort,
          publishedPort: fields.publishedPort,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error('createService: insert returned no row');

      await writeActivityEvent(
        tx,
        {
          ...actorFields(input.actor),
          entityType: 'service',
          entityId: row.id,
          action: 'service.created',
          outcome: 'success',
          metadata: {
            projectId: row.projectId,
            environmentId: row.environmentId,
            serverId: row.serverId,
            name: row.name,
            sourceType: row.sourceType,
          },
        },
        now,
      );
      return { ok: true, service: toServiceView(row, null) };
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) === SERVICE_NAME_UNIQUE_CONSTRAINT) return nameTaken(fields.name);
    throw error;
  }
  if (result.ok) await publishServerEvent(deps.events, buildServiceUpdatedEvent(result.service));
  return result;
}

// ---------------------------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------------------------

export interface UpdateServiceInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly serviceId: string;
  readonly fields: unknown;
}

export type UpdateServiceFailureCode =
  | 'SERVICE_INPUT_INVALID'
  | 'NOT_FOUND'
  | 'SERVER_BUILDKIT_UNAVAILABLE'
  | 'SERVICE_NAME_TAKEN'
  | 'PORT_IN_USE';

export interface UpdateServiceSuccess {
  readonly ok: true;
  readonly service: ServiceView;
  /** True when the change only takes effect in a new container (source or a port changed). */
  readonly requiresRedeploy: boolean;
  readonly changedFields: readonly ServiceEditField[];
}

export type UpdateServiceResult =
  | UpdateServiceSuccess
  | ServiceInputInvalid
  | Failure<Exclude<UpdateServiceFailureCode, 'SERVICE_INPUT_INVALID'>>;

export async function updateService(deps: ServiceServicesDeps, input: UpdateServiceInput): Promise<UpdateServiceResult> {
  const validated = validateServiceEditInput(input.fields);
  if (!validated.ok) return inputInvalid(validated);
  const edit = validated.value;
  const scoped = and(eq(services.id, input.serviceId), eq(services.projectId, input.projectId));

  let result: UpdateServiceResult;
  try {
    result = await deps.db.transaction(async (tx): Promise<UpdateServiceResult> => {
      const [located] = await tx.select({ serverId: services.serverId }).from(services).where(scoped).limit(1);
      if (!located) return notFound('Service', input.serviceId);
      // Server first, then the service: the same lock order as create, so port claims serialize.
      const server = await lockServer(tx, located.serverId);
      const [current] = await tx.select().from(services).where(scoped).for('update');
      if (!current || !server) return notFound('Service', input.serviceId);

      const classification = classifyServiceEdit(editableFieldsFromRow(current), edit);
      const changed = new Set(classification.changedFields);
      if (classification.kind === 'none') {
        return { ok: true, service: await viewOf(tx, current), requiresRedeploy: false, changedFields: [] };
      }
      if (changed.has('source') && edit.source?.kind === 'git' && server.dockerBuildkitAvailable !== true) {
        return buildkitUnavailable();
      }
      if (changed.has('name') && edit.name !== undefined && (await serviceNameInUse(tx, current.environmentId, edit.name, current.id))) {
        return nameTaken(edit.name);
      }
      if (changed.has('publishedPort') && edit.publishedPort !== undefined) {
        const portFailure = await checkPublishedPort(tx, deps, server.id, current.id, edit.publishedPort);
        if (portFailure) return portFailure;
      }

      const now = deps.now();
      // A credential never follows the service to another repository or registry (A3).
      const sourceColumns = changed.has('source') && edit.source !== undefined ? serviceColumnsFromSource(edit.source) : null;
      const credentialChanges =
        sourceColumns === null
          ? { columns: {}, staleIds: [] }
          : await credentialChangesForSource(tx, { masterKeys: masterKeysOf(deps) }, current, sourceColumns, now);
      const [row] = await tx
        .update(services)
        .set({
          ...(changed.has('name') && edit.name !== undefined ? { name: edit.name } : {}),
          ...(sourceColumns ?? {}),
          // 14-07 H2: a pinned Git host key never follows the service to another host.
          ...(sourceColumns === null ? {} : gitHostKeyColumnsForUrlChange(current, sourceColumns.repositoryUrl)),
          ...credentialChanges.columns,
          ...(changed.has('internalPort') && edit.internalPort !== undefined ? { internalPort: edit.internalPort } : {}),
          ...(changed.has('publishedPort') && edit.publishedPort !== undefined ? { publishedPort: edit.publishedPort } : {}),
          updatedAt: nextUpdatedAt(current.updatedAt, now),
        })
        .where(eq(services.id, current.id))
        .returning();
      if (!row) throw new Error('updateService: update returned no row');
      await deleteCredentialRows(tx, credentialChanges.staleIds);

      const requiresRedeploy = classification.kind === 'redeploy';
      await writeActivityEvent(
        tx,
        {
          ...actorFields(input.actor),
          entityType: 'service',
          entityId: row.id,
          action: 'service.updated',
          outcome: 'success',
          metadata: {
            changedFields: [...classification.changedFields],
            requiresRedeploy,
            ...(credentialChanges.staleIds.length > 0 ? { credentialReplaced: true } : {}),
          },
        },
        now,
      );
      return { ok: true, service: await viewOf(tx, row), requiresRedeploy, changedFields: classification.changedFields };
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) === SERVICE_NAME_UNIQUE_CONSTRAINT && edit.name !== undefined) {
      return nameTaken(edit.name);
    }
    throw error;
  }
  // A no-op edit (nothing changed) commits nothing, so it publishes nothing.
  if (result.ok && result.changedFields.length > 0) await publishServerEvent(deps.events, buildServiceUpdatedEvent(result.service));
  return result;
}

// ---------------------------------------------------------------------------------------------
// Operations and delete (12-14)
// ---------------------------------------------------------------------------------------------

type Selector = Pick<Database, 'select'>;

/** A non-terminal deployment exists: the deploy owns the container. */
async function hasActiveDeployment(db: Selector, serviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, [...NON_TERMINAL_DEPLOYMENT_STATUSES])))
    .limit(1);
  return row !== undefined;
}

/** Deployments a worker claimed (`startedAt` set): the only ones that can leave remote resources.
 *  Newest first, as the cleanup expects. */
export async function claimedDeploymentIds(db: Selector, serviceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), isNotNull(deployments.startedAt)))
    .orderBy(desc(deployments.createdAt), desc(deployments.id));
  return rows.map((row) => row.id);
}

async function scopedServiceRow(db: Selector, projectId: string, serviceId: string) {
  const [row] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.projectId, projectId)))
    .limit(1);
  return row;
}

const deploymentInProgress = (): Failure<'DEPLOYMENT_IN_PROGRESS'> => ({
  ok: false,
  code: 'DEPLOYMENT_IN_PROGRESS',
  message: 'This service has a deployment in progress; wait for it to finish or cancel it',
});

export interface RequestServiceOperationInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly serviceId: string;
  readonly operation: ServiceOperation;
}

export type RequestServiceOperationFailureCode =
  | 'NOT_FOUND'
  | 'DEPLOYMENT_IN_PROGRESS'
  | 'SERVICE_NOT_DEPLOYED'
  | 'SERVICE_OPERATION_IN_PROGRESS'
  | 'QUEUE_UNAVAILABLE';

export type RequestServiceOperationResult =
  | { readonly ok: true; readonly service: ServiceView }
  | Failure<RequestServiceOperationFailureCode>;

/** Queues stop / restart / remove. The job re-checks the target before touching the server. */
export async function requestServiceOperation(
  deps: ServiceServicesDeps,
  input: RequestServiceOperationInput,
): Promise<RequestServiceOperationResult> {
  const row = await scopedServiceRow(deps.db, input.projectId, input.serviceId);
  if (!row) return notFound('Service', input.serviceId);
  if (await hasActiveDeployment(deps.db, row.id)) return deploymentInProgress();
  if ((await claimedDeploymentIds(deps.db, row.id)).length === 0) {
    return { ok: false, code: 'SERVICE_NOT_DEPLOYED', message: 'This service has not been deployed yet' };
  }
  if (deps.operationQueue === undefined) {
    return { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable; try again shortly' };
  }
  const enqueued = await deps.operationQueue.enqueue({
    serviceId: row.id,
    operation: input.operation,
    actorId: input.actor.type === 'user' ? input.actor.id : null,
  });
  if (!enqueued.ok) return { ok: false, code: enqueued.code, message: enqueued.message };
  return { ok: true, service: await viewOf(deps.db, row) };
}

/** The job's target: `null` when the service is gone. */
export async function loadServiceOperationTarget(db: Database, serviceId: string): Promise<ServiceOperationTarget | null> {
  const [row] = await db.select({ serverId: services.serverId }).from(services).where(eq(services.id, serviceId)).limit(1);
  if (!row) return null;
  return { serverId: row.serverId, activeDeployment: await hasActiveDeployment(db, serviceId) };
}

const OPERATION_ACTIONS = {
  stop: 'service.stopped',
  restart: 'service.restarted',
  remove: 'service.container_changed',
} as const satisfies Record<ServiceOperation, string>;

/** Writes the operation's activity event and the status cache in one transaction. `null` when
 *  the service no longer exists. Only ids, codes and counts reach the event (never output). */
export async function recordServiceOperation(
  db: Database,
  now: () => Date,
  input: RecordServiceOperationInput,
): Promise<ServiceView | null> {
  return db.transaction(async (tx) => {
    const [service] = await tx.select().from(services).where(eq(services.id, input.serviceId)).for('update');
    if (!service) return null;
    const latest = (await latestDeploymentStatuses(tx, [service.id])).get(service.id);
    const { result } = input;
    const container: ContainerObservation = result.ok
      ? result.container
      : result.code === 'CONTAINER_NOT_FOUND'
        ? { kind: 'absent' }
        : containerObservationFromCache(service.status);
    const cached = deriveServiceStatus({ latestDeployment: latest === undefined ? null : { status: latest }, container });
    const at = now();
    const updatedAt = nextUpdatedAt(service.updatedAt, at);
    const [updated] = await tx.update(services).set({ status: cached, updatedAt }).where(eq(services.id, service.id)).returning();

    const action = OPERATION_ACTIONS[input.operation];
    const metadata =
      action === 'service.container_changed'
        ? { serverId: input.serverId, previousStatus: service.status, observedState: container.kind }
        : { serverId: input.serverId, durationMs: result.durationMs };
    await writeActivityEvent(
      tx,
      {
        ...actorFields(input.actor),
        entityType: 'service',
        entityId: service.id,
        action,
        outcome: result.ok ? 'success' : 'failure',
        ...(result.ok ? {} : { errorCode: result.code }),
        metadata,
      },
      at,
    );
    return toServiceView(updated ?? { ...service, status: cached, updatedAt }, latest === undefined ? null : { status: latest });
  });
}

export interface DeleteServiceInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly serviceId: string;
  readonly confirmName: string;
}

export type DeleteServiceFailureCode =
  | 'NOT_FOUND'
  | 'DELETE_CONFIRMATION_MISMATCH'
  | 'DEPLOYMENT_IN_PROGRESS'
  | 'SERVER_UNREACHABLE'
  | 'SERVER_DOCKER_UNAVAILABLE'
  | 'SERVICE_CLEANUP_FAILED';

export type DeleteServiceResult = { readonly ok: true; readonly serviceId: string } | Failure<DeleteServiceFailureCode>;

const CLEANUP_UNAVAILABLE = {
  ok: false,
  code: 'SERVICE_CLEANUP_FAILED',
  message: 'Remote cleanup is not available; the service was kept',
} as const;

/**
 * Removes the service's container, network, images and workspaces from its server (only when a
 * deployment was ever claimed), then its row, deployments (cascade) and credentials. A cleanup
 * failure keeps the row and records a failed `service.deleted`, so the delete can be retried.
 */
export async function deleteService(deps: ServiceServicesDeps, input: DeleteServiceInput): Promise<DeleteServiceResult> {
  const row = await scopedServiceRow(deps.db, input.projectId, input.serviceId);
  if (!row) return notFound('Service', input.serviceId);
  if (input.confirmName !== row.name) {
    return { ok: false, code: 'DELETE_CONFIRMATION_MISMATCH', message: 'Confirmation name does not match the service name' };
  }
  if (await hasActiveDeployment(deps.db, row.id)) return deploymentInProgress();

  const metadata = { projectId: row.projectId, environmentId: row.environmentId, serverId: row.serverId, name: row.name };
  const deploymentIds = await claimedDeploymentIds(deps.db, row.id);
  if (deploymentIds.length > 0) {
    const cleaned =
      deps.remoteCleanup === undefined
        ? CLEANUP_UNAVAILABLE
        : await deps.remoteCleanup({ serverId: row.serverId, serviceId: row.id, deploymentIds });
    if (!cleaned.ok) {
      await deps.db.transaction((tx) =>
        writeActivityEvent(
          tx,
          {
            ...actorFields(input.actor),
            entityType: 'service',
            entityId: row.id,
            action: 'service.deleted',
            outcome: 'failure',
            errorCode: cleaned.code,
            metadata,
          },
          deps.now(),
        ),
      );
      return { ok: false, code: cleaned.code, message: cleaned.message };
    }
  }

  const result = await deps.db.transaction(async (tx): Promise<DeleteServiceResult> => {
    const [current] = await tx
      .select()
      .from(services)
      .where(and(eq(services.id, row.id), eq(services.projectId, input.projectId)))
      .for('update');
    if (!current) return notFound('Service', input.serviceId);
    // A deploy claimed after the cleanup owns new remote resources: refuse rather than leak them.
    if (await hasActiveDeployment(tx, current.id)) return deploymentInProgress();
    await writeActivityEvent(
      tx,
      {
        ...actorFields(input.actor),
        entityType: 'service',
        entityId: current.id,
        action: 'service.deleted',
        outcome: 'success',
        metadata,
      },
      deps.now(),
    );
    await tx.delete(services).where(eq(services.id, current.id));
    await deleteCredentialRows(tx, [current.repositoryCredentialId, current.registryCredentialId]);
    return { ok: true, serviceId: current.id };
  });
  if (result.ok) await publishServerEvent(deps.events, { type: 'service.deleted', id: result.serviceId });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------

export interface ServiceServices {
  listServices(projectId: string): Promise<ServiceView[] | null>;
  getService(projectId: string, serviceId: string): Promise<ServiceView | null>;
  createService(input: CreateServiceInput): Promise<CreateServiceResult>;
  updateService(input: UpdateServiceInput): Promise<UpdateServiceResult>;
  requestServiceOperation(input: RequestServiceOperationInput): Promise<RequestServiceOperationResult>;
  deleteService(input: DeleteServiceInput): Promise<DeleteServiceResult>;
  getServiceCredentials(projectId: string, serviceId: string): Promise<ServiceCredentialsView | null>;
  setRepositoryCredential(
    target: ServiceCredentialTarget & { readonly input: RepositoryCredentialInput },
  ): Promise<ServiceCredentialsResult>;
  setRegistryCredential(target: ServiceCredentialTarget & { readonly input: RegistryCredentialInput }): Promise<ServiceCredentialsResult>;
  removeServiceCredential(
    target: ServiceCredentialTarget & { readonly slot: 'repository' | 'registry' },
  ): Promise<ServiceCredentialsResult>;
}

const defaultMasterKeys = new WeakMap<ServiceServicesDeps, () => Promise<MasterKeys>>();

function masterKeysOf(deps: ServiceServicesDeps): () => Promise<MasterKeys> {
  if (deps.masterKeys) return deps.masterKeys;
  let resolved = defaultMasterKeys.get(deps);
  if (!resolved) {
    resolved = masterKeysFromEnvironment();
    defaultMasterKeys.set(deps, resolved);
  }
  return resolved;
}

export function createServiceServices(deps: ServiceServicesDeps): ServiceServices {
  const credentialDeps = { db: deps.db, now: deps.now, masterKeys: masterKeysOf(deps) };
  return {
    getServiceCredentials: (projectId, serviceId) => getServiceCredentials(credentialDeps, projectId, serviceId),
    setRepositoryCredential: (target) => setRepositoryCredential(credentialDeps, target),
    setRegistryCredential: (target) => setRegistryCredential(credentialDeps, target),
    removeServiceCredential: (target) => removeServiceCredential(credentialDeps, target),
    listServices: (projectId) => listServices(deps, projectId),
    getService: (projectId, serviceId) => getService(deps, projectId, serviceId),
    createService: (input) => createService(deps, input),
    updateService: (input) => updateService(deps, input),
    requestServiceOperation: (input) => requestServiceOperation(deps, input),
    deleteService: (input) => deleteService(deps, input),
  };
}
