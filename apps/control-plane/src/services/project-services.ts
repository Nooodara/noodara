// 12-07: projects and environments. Each mutation commits its row change and its activity event
// in one transaction (ARCHITECTURE.md §6). Uniqueness is pre-checked inside the transaction and
// backed by the database's unique indexes; a lost race surfaces as a named failure, never a 500.
// No SSE event is published for projects or environments (ROADMAP D22: clients refetch); a project
// delete publishes `service.deleted` for each service it removed (12-14).
import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  projectSlugWithSuffix,
  validateEnvironmentName,
  validateProjectCreateInput,
  validateProjectUpdateInput,
  type ProjectSlug,
} from '@noodara/domain';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { Database } from '../db/client.js';
import { credentials } from '../db/schema/credentials.js';
import { deployments } from '../db/schema/deployments.js';
import type { ServiceRemoteCleanup } from '../deploy/service-ops.js';
import { noopServerEventPublisher, publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import { environments } from '../db/schema/environments.js';
import { projects } from '../db/schema/projects.js';
import { services } from '../db/schema/services.js';
import type { ServiceActor } from './server-service-deps.js';

export interface ProjectServicesDeps {
  readonly db: Database;
  readonly now: () => Date;
  /** 12-14: remote cleanup of deployed services on delete; without it such a project is kept. */
  readonly remoteCleanup?: ServiceRemoteCleanup;
  /** 12-14: `service.deleted` for each service a project delete removed. */
  readonly events?: ServerEventPublisher;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const PROJECT_NAME_UNIQUE_CONSTRAINT = 'projects_name_lower_unique_idx';
const PROJECT_SLUG_UNIQUE_CONSTRAINT = 'projects_slug_unique_idx';
const ENVIRONMENT_NAME_UNIQUE_CONSTRAINT = 'environments_project_name_lower_unique_idx';

/** Concurrent creates deriving the same slug: the loser retries with a fresh slug pick. */
const MAX_CREATE_ATTEMPTS = 5;
/** Highest `-<n>` suffix tried before giving up on a slug (an internal error, not user input). */
const MAX_SLUG_COUNTER = 1000;
// Same rule as the activity metadata guard: a URL with userinfo never belongs in a name.
const URL_USERINFO_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*@/;

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnvironmentView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type ProjectRow = Pick<
  typeof projects.$inferSelect,
  'id' | 'name' | 'slug' | 'description' | 'archivedAt' | 'createdAt' | 'updatedAt'
>;
type EnvironmentRow = Pick<
  typeof environments.$inferSelect,
  'id' | 'projectId' | 'name' | 'kind' | 'createdAt' | 'updatedAt'
>;

/** Built field by field: a column added to `projects` never reaches the wire by accident. */
export function toProjectView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toEnvironmentView(row: EnvironmentRow): EnvironmentView {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Keys of `next` whose value differs from `current`, in `next`'s key order. */
export function changedFieldNames(current: object, next: object): string[] {
  const before = new Map<string, unknown>(Object.entries(current));
  return Object.entries(next)
    .filter(([key, value]) => value !== before.get(key))
    .map(([key]) => key);
}

/** The derived slug if free, else `<slug>-2`, `<slug>-3`, ... (bounded). */
export async function pickFreeProjectSlug(
  base: ProjectSlug,
  isTaken: (slug: ProjectSlug) => Promise<boolean>,
): Promise<ProjectSlug> {
  if (!(await isTaken(base))) return base;
  for (let counter = 2; counter <= MAX_SLUG_COUNTER; counter += 1) {
    const candidate = projectSlugWithSuffix(base, counter);
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('pickFreeProjectSlug: no free project slug left');
}

/** drizzle wraps the `pg` error; `.code`/`.constraint` live on `cause` (see register-server.ts). */
function uniqueViolationConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' ? cause.constraint : undefined;
}

function actorFields(actor: ServiceActor): { actorType: 'user' | 'system'; actorId: string | null } {
  return { actorType: actor.type, actorId: actor.type === 'user' ? actor.id : null };
}

function projectNameTaken(name: string): { ok: false; code: 'PROJECT_NAME_TAKEN'; message: string } {
  return { ok: false, code: 'PROJECT_NAME_TAKEN', message: `A project named "${name}" already exists` };
}

function environmentNameTaken(name: string): { ok: false; code: 'ENVIRONMENT_NAME_TAKEN'; message: string } {
  return {
    ok: false,
    code: 'ENVIRONMENT_NAME_TAKEN',
    message: `This project already has an environment named "${name}"`,
  };
}

function projectNotFound(projectId: string): { ok: false; code: 'NOT_FOUND'; message: string } {
  return { ok: false, code: 'NOT_FOUND', message: `Project "${projectId}" not found` };
}

function environmentNotFound(environmentId: string): { ok: false; code: 'NOT_FOUND'; message: string } {
  return { ok: false, code: 'NOT_FOUND', message: `Environment "${environmentId}" not found` };
}

function validationFailed(message: string): { ok: false; code: 'VALIDATION_FAILED'; message: string } {
  return { ok: false, code: 'VALIDATION_FAILED', message };
}

const URL_CREDENTIALS_MESSAGE = 'Project name must not contain a URL with credentials';

async function lockProject(tx: Transaction, projectId: string, mode: 'update' | 'share'): Promise<ProjectRow | undefined> {
  const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).for(mode);
  return row;
}

async function projectNameInUse(tx: Transaction, name: string, exceptId?: string): Promise<boolean> {
  const sameName = sql`lower(${projects.name}) = lower(${name})`;
  const [row] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(exceptId === undefined ? sameName : and(sameName, ne(projects.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

async function environmentNameInUse(
  tx: Transaction,
  projectId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const sameName = and(eq(environments.projectId, projectId), sql`lower(${environments.name}) = lower(${name})`);
  const [row] = await tx
    .select({ id: environments.id })
    .from(environments)
    .where(exceptId === undefined ? sameName : and(sameName, ne(environments.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export interface CreateProjectInput {
  readonly actor: ServiceActor;
  readonly name: string;
  readonly description?: string | null;
}

export type CreateProjectFailureCode = 'VALIDATION_FAILED' | 'PROJECT_NAME_TAKEN';

export type CreateProjectResult =
  | { readonly ok: true; readonly project: ProjectView }
  | { readonly ok: false; readonly code: CreateProjectFailureCode; readonly message: string };

export async function createProject(
  deps: ProjectServicesDeps,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  const validated = validateProjectCreateInput({
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (!validated.ok) return validationFailed(validated.message);
  const { name, slug: derivedSlug, description } = validated.value;
  if (URL_USERINFO_PATTERN.test(name)) return validationFailed(URL_CREDENTIALS_MESSAGE);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.db.transaction(async (tx): Promise<CreateProjectResult> => {
        if (await projectNameInUse(tx, name)) return projectNameTaken(name);

        const slug = await pickFreeProjectSlug(derivedSlug, async (candidate) => {
          const [row] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.slug, candidate))
            .limit(1);
          return row !== undefined;
        });

        const now = deps.now();
        const [row] = await tx
          .insert(projects)
          .values({ name, slug, description, createdAt: now, updatedAt: now })
          .returning();
        if (!row) throw new Error('createProject: insert returned no row');

        await writeActivityEvent(
          tx,
          {
            ...actorFields(input.actor),
            entityType: 'project',
            entityId: row.id,
            action: 'project.created',
            outcome: 'success',
            metadata: { name: row.name, slug: row.slug },
          },
          now,
        );
        return { ok: true, project: toProjectView(row) };
      });
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === PROJECT_NAME_UNIQUE_CONSTRAINT) return projectNameTaken(name);
      if (constraint === PROJECT_SLUG_UNIQUE_CONSTRAINT && attempt < MAX_CREATE_ATTEMPTS) continue;
      throw error;
    }
  }
}

export async function listProjects(deps: ProjectServicesDeps): Promise<ProjectView[]> {
  const rows = await deps.db
    .select()
    .from(projects)
    .orderBy(asc(sql`lower(${projects.name})`), asc(projects.id));
  return rows.map(toProjectView);
}

export async function getProject(deps: ProjectServicesDeps, projectId: string): Promise<ProjectView | null> {
  const [row] = await deps.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return row ? toProjectView(row) : null;
}

export interface UpdateProjectInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly name?: string;
  readonly description?: string | null;
}

export type UpdateProjectFailureCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'PROJECT_NAME_TAKEN';

export type UpdateProjectResult =
  | { readonly ok: true; readonly project: ProjectView }
  | { readonly ok: false; readonly code: UpdateProjectFailureCode; readonly message: string };

export async function updateProject(
  deps: ProjectServicesDeps,
  input: UpdateProjectInput,
): Promise<UpdateProjectResult> {
  const validated = validateProjectUpdateInput({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (!validated.ok) return validationFailed(validated.message);
  const update = validated.value;
  if (update.name !== undefined && URL_USERINFO_PATTERN.test(update.name)) {
    return validationFailed(URL_CREDENTIALS_MESSAGE);
  }

  try {
    return await deps.db.transaction(async (tx): Promise<UpdateProjectResult> => {
      const current = await lockProject(tx, input.projectId, 'update');
      if (!current) return projectNotFound(input.projectId);

      if (update.name !== undefined && (await projectNameInUse(tx, update.name, current.id))) {
        return projectNameTaken(update.name);
      }

      const changedFields = changedFieldNames(current, update);
      if (changedFields.length === 0) return { ok: true, project: toProjectView(current) };

      const now = deps.now();
      const [row] = await tx
        .update(projects)
        .set({ ...update, updatedAt: now })
        .where(eq(projects.id, current.id))
        .returning();
      if (!row) throw new Error('updateProject: update returned no row');

      await writeActivityEvent(
        tx,
        {
          ...actorFields(input.actor),
          entityType: 'project',
          entityId: row.id,
          action: 'project.updated',
          outcome: 'success',
          metadata: { changedFields },
        },
        now,
      );
      return { ok: true, project: toProjectView(row) };
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) === PROJECT_NAME_UNIQUE_CONSTRAINT && update.name !== undefined) {
      return projectNameTaken(update.name);
    }
    throw error;
  }
}

export interface SetProjectArchivedInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly archived: boolean;
}

export type SetProjectArchivedFailureCode = 'NOT_FOUND';

export type SetProjectArchivedResult =
  | { readonly ok: true; readonly project: ProjectView }
  | { readonly ok: false; readonly code: SetProjectArchivedFailureCode; readonly message: string };

/** Archive or unarchive. Already in the requested state: a no-op with no activity event. */
export async function setProjectArchived(
  deps: ProjectServicesDeps,
  input: SetProjectArchivedInput,
): Promise<SetProjectArchivedResult> {
  return deps.db.transaction(async (tx): Promise<SetProjectArchivedResult> => {
    const current = await lockProject(tx, input.projectId, 'update');
    if (!current) return projectNotFound(input.projectId);
    if ((current.archivedAt !== null) === input.archived) return { ok: true, project: toProjectView(current) };

    const now = deps.now();
    const [row] = await tx
      .update(projects)
      .set({ archivedAt: input.archived ? now : null, updatedAt: now })
      .where(eq(projects.id, current.id))
      .returning();
    if (!row) throw new Error('setProjectArchived: update returned no row');

    await writeActivityEvent(
      tx,
      {
        ...actorFields(input.actor),
        entityType: 'project',
        entityId: row.id,
        action: input.archived ? 'project.archived' : 'project.unarchived',
        outcome: 'success',
        metadata: { name: row.name },
      },
      now,
    );
    return { ok: true, project: toProjectView(row) };
  });
}

export interface DeleteProjectInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly confirmName: string;
}

export type DeleteProjectFailureCode =
  | 'NOT_FOUND'
  | 'PROJECT_NOT_ARCHIVED'
  | 'DELETE_CONFIRMATION_MISMATCH'
  | 'DEPLOYMENT_IN_PROGRESS'
  | 'SERVER_UNREACHABLE'
  | 'SERVER_DOCKER_UNAVAILABLE'
  | 'SERVICE_CLEANUP_FAILED';

export type DeleteProjectResult =
  | { readonly ok: true; readonly projectId: string }
  | { readonly ok: false; readonly code: DeleteProjectFailureCode; readonly message: string };

/** A worker is running a deployment of one of these services. A QUEUED one is not: the cascade
 *  removes it and its job finds no row. */
async function hasRunningDeployment(db: Pick<Database, 'select'>, serviceIds: readonly string[]): Promise<boolean> {
  if (serviceIds.length === 0) return false;
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(inArray(deployments.serviceId, [...serviceIds]), inArray(deployments.status, ['PREPARING', 'BUILDING', 'DEPLOYING'])))
    .limit(1);
  return row !== undefined;
}

type DeleteProjectFailure = Extract<DeleteProjectResult, { ok: false }>;

function deleteProjectPrecheck(
  current: ProjectRow | undefined,
  input: DeleteProjectInput,
): DeleteProjectFailure | null {
  if (!current) return projectNotFound(input.projectId);
  if (current.archivedAt === null) {
    return { ok: false, code: 'PROJECT_NOT_ARCHIVED', message: 'Archive the project before deleting it' };
  }
  if (input.confirmName !== current.name) {
    return {
      ok: false,
      code: 'DELETE_CONFIRMATION_MISMATCH',
      message: 'Confirmation name does not match the project name',
    };
  }
  return null;
}

const runningDeployment: DeleteProjectFailure = {
  ok: false,
  code: 'DEPLOYMENT_IN_PROGRESS',
  message: 'A service of this project has a deployment in progress; wait for it to finish or cancel it',
};

/** 12-14: removes each deployed service's container, network, images and workspaces first;
 *  the first failure keeps the whole project so the delete can be retried. */
async function cleanupProjectServices(deps: ProjectServicesDeps, projectId: string): Promise<DeleteProjectFailure | null> {
  const rows = await deps.db
    .select({ id: services.id, serverId: services.serverId })
    .from(services)
    .where(eq(services.projectId, projectId));
  if (await hasRunningDeployment(deps.db, rows.map((row) => row.id))) return runningDeployment;
  for (const row of rows) {
    const claimed = await deps.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.serviceId, row.id), isNotNull(deployments.startedAt)))
      .orderBy(desc(deployments.createdAt), desc(deployments.id));
    if (claimed.length === 0) continue;
    if (deps.remoteCleanup === undefined) {
      return { ok: false, code: 'SERVICE_CLEANUP_FAILED', message: 'Remote cleanup is not available; the project was kept' };
    }
    const cleaned = await deps.remoteCleanup({
      serverId: row.serverId,
      serviceId: row.id,
      deploymentIds: claimed.map((deployment) => deployment.id),
    });
    if (!cleaned.ok) return { ok: false, code: cleaned.code, message: cleaned.message };
  }
  return null;
}

/**
 * Deletes an archived project whose exact name the caller repeated (strict `!==`: no trimming,
 * no case folding). The event is written while the row still exists; the project delete cascades
 * environments, services, deployments and log chunks; then the services' credentials go, after
 * the services, because `services.*_credential_id` are RESTRICT. Each deployed service is
 * cleaned on its server first (12-14).
 */
export async function deleteProject(
  deps: ProjectServicesDeps,
  input: DeleteProjectInput,
): Promise<DeleteProjectResult> {
  // Checked before any remote work: a wrong name or an active project never touches a server.
  const [before] = await deps.db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  const refused = deleteProjectPrecheck(before, input) ?? (await cleanupProjectServices(deps, input.projectId));
  if (refused) return refused;

  let deletedServiceIds: string[] = [];
  const result = await deps.db.transaction(async (tx): Promise<DeleteProjectResult> => {
    const current = await lockProject(tx, input.projectId, 'update');
    const failure = deleteProjectPrecheck(current, input);
    if (failure || !current) return failure ?? projectNotFound(input.projectId);

    const [environmentCount] = await tx
      .select({ value: count() })
      .from(environments)
      .where(eq(environments.projectId, current.id));
    const serviceRows = await tx
      .select({
        id: services.id,
        repositoryCredentialId: services.repositoryCredentialId,
        registryCredentialId: services.registryCredentialId,
      })
      .from(services)
      .where(eq(services.projectId, current.id))
      .for('update');
    // A deploy claimed after the cleanup owns new remote resources: refuse rather than leak them.
    if (await hasRunningDeployment(tx, serviceRows.map((row) => row.id))) return runningDeployment;
    const credentialIds = serviceRows
      .flatMap((row) => [row.repositoryCredentialId, row.registryCredentialId])
      .filter((id): id is string => id !== null);

    const now = deps.now();
    await writeActivityEvent(
      tx,
      {
        ...actorFields(input.actor),
        entityType: 'project',
        entityId: current.id,
        action: 'project.deleted',
        outcome: 'success',
        metadata: {
          name: current.name,
          environments: environmentCount?.value ?? 0,
          services: serviceRows.length,
        },
      },
      now,
    );

    await tx.delete(projects).where(eq(projects.id, current.id));
    if (credentialIds.length > 0) {
      await tx.delete(credentials).where(inArray(credentials.id, credentialIds));
    }
    deletedServiceIds = serviceRows.map((row) => row.id);
    return { ok: true, projectId: current.id };
  });
  if (result.ok) {
    const events = deps.events ?? noopServerEventPublisher;
    for (const id of deletedServiceIds) await publishServerEvent(events, { type: 'service.deleted', id });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

/** `kind` is a free label (ROADMAP D23) held to the same slug shape as the name. */
function validateEnvironmentKind(kind: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const result = validateEnvironmentName(kind);
  if (!result.ok) {
    return { ok: false, message: 'Environment kind must be a lowercase slug matching [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?' };
  }
  return { ok: true, value: result.value };
}

export interface CreateEnvironmentInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly name: string;
  /** Defaults to the environment name. */
  readonly kind?: string;
}

export type CreateEnvironmentFailureCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'ENVIRONMENT_NAME_TAKEN';

export type CreateEnvironmentResult =
  | { readonly ok: true; readonly environment: EnvironmentView }
  | { readonly ok: false; readonly code: CreateEnvironmentFailureCode; readonly message: string };

export async function createEnvironment(
  deps: ProjectServicesDeps,
  input: CreateEnvironmentInput,
): Promise<CreateEnvironmentResult> {
  const nameResult = validateEnvironmentName(input.name);
  if (!nameResult.ok) return validationFailed(nameResult.message);
  const name = nameResult.value;
  const kindResult = validateEnvironmentKind(input.kind ?? name);
  if (!kindResult.ok) return validationFailed(kindResult.message);
  const kind = kindResult.value;

  try {
    return await deps.db.transaction(async (tx): Promise<CreateEnvironmentResult> => {
      // FOR SHARE: a concurrent project delete waits for this insert, never races past it.
      const project = await lockProject(tx, input.projectId, 'share');
      if (!project) return projectNotFound(input.projectId);
      if (await environmentNameInUse(tx, project.id, name)) return environmentNameTaken(name);

      const now = deps.now();
      const [row] = await tx
        .insert(environments)
        .values({ projectId: project.id, name, kind, createdAt: now, updatedAt: now })
        .returning();
      if (!row) throw new Error('createEnvironment: insert returned no row');

      await writeActivityEvent(
        tx,
        {
          ...actorFields(input.actor),
          entityType: 'environment',
          entityId: row.id,
          action: 'environment.created',
          outcome: 'success',
          metadata: { projectId: project.id, name: row.name, kind: row.kind },
        },
        now,
      );
      return { ok: true, environment: toEnvironmentView(row) };
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) === ENVIRONMENT_NAME_UNIQUE_CONSTRAINT) return environmentNameTaken(name);
    throw error;
  }
}

/** `null` when the project does not exist. */
export async function listEnvironments(
  deps: ProjectServicesDeps,
  projectId: string,
): Promise<EnvironmentView[] | null> {
  const [project] = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  const rows = await deps.db
    .select()
    .from(environments)
    .where(eq(environments.projectId, projectId))
    .orderBy(asc(environments.name));
  return rows.map(toEnvironmentView);
}

/** Scoped by both ids: an environment of another project reads exactly like a missing one. */
export async function getEnvironment(
  deps: ProjectServicesDeps,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentView | null> {
  const [row] = await deps.db
    .select()
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)))
    .limit(1);
  return row ? toEnvironmentView(row) : null;
}

export interface UpdateEnvironmentInput {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly environmentId: string;
  readonly name?: string;
  readonly kind?: string;
}

export type UpdateEnvironmentFailureCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'ENVIRONMENT_NAME_TAKEN';

export type UpdateEnvironmentResult =
  | { readonly ok: true; readonly environment: EnvironmentView }
  | { readonly ok: false; readonly code: UpdateEnvironmentFailureCode; readonly message: string };

export async function updateEnvironment(
  deps: ProjectServicesDeps,
  input: UpdateEnvironmentInput,
): Promise<UpdateEnvironmentResult> {
  if (input.name === undefined && input.kind === undefined) {
    return validationFailed('Environment edit must change at least one field');
  }
  let update: { name?: string; kind?: string } = {};
  if (input.name !== undefined) {
    const nameResult = validateEnvironmentName(input.name);
    if (!nameResult.ok) return validationFailed(nameResult.message);
    update = { ...update, name: nameResult.value };
  }
  if (input.kind !== undefined) {
    const kindResult = validateEnvironmentKind(input.kind);
    if (!kindResult.ok) return validationFailed(kindResult.message);
    update = { ...update, kind: kindResult.value };
  }
  const newName = update.name;

  try {
    return await deps.db.transaction(async (tx): Promise<UpdateEnvironmentResult> => {
      const [current] = await tx
        .select()
        .from(environments)
        .where(and(eq(environments.id, input.environmentId), eq(environments.projectId, input.projectId)))
        .for('update');
      if (!current) return environmentNotFound(input.environmentId);

      if (newName !== undefined && (await environmentNameInUse(tx, current.projectId, newName, current.id))) {
        return environmentNameTaken(newName);
      }

      const changedFields = changedFieldNames(current, update);
      if (changedFields.length === 0) return { ok: true, environment: toEnvironmentView(current) };

      const now = deps.now();
      const [row] = await tx
        .update(environments)
        .set({ ...update, updatedAt: now })
        .where(eq(environments.id, current.id))
        .returning();
      if (!row) throw new Error('updateEnvironment: update returned no row');

      await writeActivityEvent(
        tx,
        {
          ...actorFields(input.actor),
          entityType: 'environment',
          entityId: row.id,
          action: 'environment.updated',
          outcome: 'success',
          metadata: { projectId: row.projectId, changedFields },
        },
        now,
      );
      return { ok: true, environment: toEnvironmentView(row) };
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) === ENVIRONMENT_NAME_UNIQUE_CONSTRAINT && newName !== undefined) {
      return environmentNameTaken(newName);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------

export interface ProjectServices {
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  listProjects(): Promise<ProjectView[]>;
  getProject(projectId: string): Promise<ProjectView | null>;
  updateProject(input: UpdateProjectInput): Promise<UpdateProjectResult>;
  setProjectArchived(input: SetProjectArchivedInput): Promise<SetProjectArchivedResult>;
  deleteProject(input: DeleteProjectInput): Promise<DeleteProjectResult>;
  createEnvironment(input: CreateEnvironmentInput): Promise<CreateEnvironmentResult>;
  listEnvironments(projectId: string): Promise<EnvironmentView[] | null>;
  getEnvironment(projectId: string, environmentId: string): Promise<EnvironmentView | null>;
  updateEnvironment(input: UpdateEnvironmentInput): Promise<UpdateEnvironmentResult>;
}

export function createProjectServices(deps: ProjectServicesDeps): ProjectServices {
  return {
    createProject: (input) => createProject(deps, input),
    listProjects: () => listProjects(deps),
    getProject: (projectId) => getProject(deps, projectId),
    updateProject: (input) => updateProject(deps, input),
    setProjectArchived: (input) => setProjectArchived(deps, input),
    deleteProject: (input) => deleteProject(deps, input),
    createEnvironment: (input) => createEnvironment(deps, input),
    listEnvironments: (projectId) => listEnvironments(deps, projectId),
    getEnvironment: (projectId, environmentId) => getEnvironment(deps, projectId, environmentId),
    updateEnvironment: (input) => updateEnvironment(deps, input),
  };
}
