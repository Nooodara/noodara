// 12-11b: the real `loadTarget` port of the deploy job. `resolveDeployTarget` is pure (rows in, a
// DeployTarget or a closed code out); `createLoadTarget` only reads the rows.
// - A corrupt source snapshot or a non-UUID id is a caller bug: it throws `DeployTargetError`
//   with a fixed message (the job handler ends it as WORKER_CRASHED). A stored value is never
//   echoed into the message.
// - SEC: credentials are decrypted here and leave only as SecretValue. A registry password is
//   only ever offered to the registry the image is pulled from.
// - 17-02: the service's healthcheck config (services.healthcheck) is validated here; null keeps
//   the v0.2 post-start polls. A stored value that does not validate is a corrupt row.
// - 17-03: the rollback inputs ride along: services.autoRollback (absent = true) and the
//   service's latest SUCCESS deployment other than this one, as {id, runtimeConfig}. A stored
//   snapshot that does not validate gives runtimeConfig null (that deployment cannot be
//   restarted from it), never an error: the deploy itself must still run.
// - 17-07: `createLoadTarget` also hands the pipeline `recordRollbackStarted`, which writes the
//   `deployment.rollback_started` activity event (ids only) through src/activity/.
// - 18-03: deployments.commit_sha set before the run (a webhook push) is the exact commit to
//   deploy: it rides along as `requestedSha`, re-validated as 40-hex (corrupt = caller bug).
// - 22-05: a service with at least one domain row gets `routes` (is its server's proxy RUNNING,
//   and the H2 re-apply through apply-routes under the per-service route lock); none = no routes.
import { and, desc, eq, inArray, isNotNull, ne, or, type SQL } from 'drizzle-orm';
import {
  parseEnvValue,
  resolveEnv,
  resolveSecretRefs,
  type EnvDefinition,
  type EnvScope,
  type ResolvedEnvEntry,
  type SecretsByScope,
} from '@noodara/domain';
import {
  parseRuntimeConfigSnapshot,
  runtimeConfigEnv,
  validateHealthcheckConfig,
  type RuntimeEnvEntry,
  type HealthcheckConfig,
} from '@noodara/domain/deployment';
import {
  validateCommitSha,
  validateContainerPort,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  validateServiceSource,
  type CommitSha,
  type ResourceId,
  type ServiceSource,
} from '@noodara/domain/validators';
import { writeDeploymentRollbackStartedEvent } from '../activity/index.js';
import type { Database } from '../db/client.js';
import { credentials } from '../db/schema/credentials.js';
import { deployments } from '../db/schema/deployments.js';
import { domains } from '../db/schema/domains.js';
import { secrets } from '../db/schema/secrets.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import { applyRoutes, createRouteLock, sessionRoutePorts, type RouteLock } from '../domains/apply-routes.js';
import { domainApplyLimits, type DomainApplyLimits } from '../domains/domain-apply.js';
import { listChainVariables, type OwnerChain } from '../env/env-store.js';
import { decryptForDeploy, SecretStoreError } from '../secrets/secret-store.js';
import type { MasterKeys } from '../services/server-service-deps.js';
import {
  decodeServiceCredential,
  registryHostOfImageRef,
  repositoryCredentialFits,
  type DecodedServiceCredential,
} from '../services/service-credentials.js';
import type {
  DeployJobFailureCode,
  DeployTarget,
  LoadTargetResult,
  PreviousSuccessDeployment,
} from './deploy-worker.js';
import type { DeployCredential, DeployEnv, DeployEnvLease, DeployRoutes } from './run-deployment.js';

export class DeployTargetError extends Error {
  constructor() {
    super('The deployment record could not be turned into a deploy target');
    this.name = 'DeployTargetError';
  }
}

export interface CredentialRowShape {
  readonly type: string;
  readonly encryptedValue: string;
  readonly keyVersion: number;
}

export interface DeployTargetRows {
  readonly deployment: {
    readonly id: string;
    readonly serviceId: string;
    readonly source: unknown;
    /** 18-03: deployments.commit_sha at load time; null or absent = deploy the branch head. */
    readonly commitSha?: string | null;
  };
  readonly service: {
    readonly id: string;
    readonly serverId: string;
    readonly repositoryCredentialId: string | null;
    readonly registryCredentialId: string | null;
    /** services.healthcheck; null or absent = the default container check (v0.2 behaviour). */
    readonly healthcheck?: unknown;
    /** services.autoRollback; absent = true (the column default). */
    readonly autoRollback?: boolean;
  };
  /** 17-03: the service's latest SUCCESS deployment other than this one; null or absent = none. */
  readonly previousSuccess?: { readonly id: string; readonly runtimeConfig: unknown } | null;
  /** The row `service.repositoryCredentialId` points at, or null when absent. */
  readonly repositoryCredential: CredentialRowShape | null;
  /** The row `service.registryCredentialId` points at, or null when absent. */
  readonly registryCredential: CredentialRowShape | null;
  /** The other services on the same server (for the published-port preflight). */
  readonly otherServices: readonly { readonly serviceId: string; readonly publishedPort: number | null }[];
}

export type PanelPorts = readonly { readonly port: number; readonly label: string }[];

interface SnapshotShape {
  readonly source: ServiceSource;
  readonly internalPort: DeployTarget['internalPort'];
  readonly publishedPort: DeployTarget['publishedPort'];
}

const SNAPSHOT_SOURCE_KEYS = ['repositoryUrl', 'branch', 'buildContext', 'dockerfilePath', 'imageRef'] as const;

function asRecord(snapshot: unknown): Record<string, unknown> {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) throw new DeployTargetError();
  return snapshot as Record<string, unknown>;
}

/** The deployment's source snapshot as a validated ServiceSource (only non-null columns count);
 *  its ports are validated too, so a snapshot that passes here is whole. */
export function sourceFromSnapshot(snapshot: unknown): ServiceSource {
  return snapshotOf(snapshot).source;
}

function sourceOf(record: Record<string, unknown>): ServiceSource {
  const kind = record.sourceType;
  if (kind !== 'git' && kind !== 'image') throw new DeployTargetError();
  const candidate: Record<string, unknown> = { kind };
  const keys = kind === 'git' ? SNAPSHOT_SOURCE_KEYS.filter((key) => key !== 'imageRef') : (['imageRef'] as const);
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined) candidate[key] = value;
  }
  if (kind === 'git' && record.buildTarget !== null && record.buildTarget !== undefined) {
    candidate.target = record.buildTarget;
  }
  if (kind === 'image' && candidate.imageRef === undefined) throw new DeployTargetError();
  const validated = validateServiceSource(candidate);
  if (!validated.ok) throw new DeployTargetError();
  return validated.value;
}

function snapshotOf(snapshot: unknown): SnapshotShape {
  const record = asRecord(snapshot);
  const source = sourceOf(record);
  const internalPort = validateContainerPort(record.internalPort);
  if (!internalPort.ok) throw new DeployTargetError();
  let publishedPort: DeployTarget['publishedPort'] = null;
  if (record.publishedPort !== null && record.publishedPort !== undefined) {
    const checked = validateContainerPort(record.publishedPort);
    if (!checked.ok) throw new DeployTargetError();
    publishedPort = checked.value;
  }
  return { source, internalPort: internalPort.value, publishedPort };
}

function healthcheckOf(stored: unknown): HealthcheckConfig | null {
  if (stored === null || stored === undefined) return null;
  const checked = validateHealthcheckConfig(stored);
  if (!checked.ok) throw new DeployTargetError();
  return checked.value;
}

function previousSuccessOf(rows: DeployTargetRows, deploymentId: ResourceId): PreviousSuccessDeployment | null {
  const previous = rows.previousSuccess;
  if (previous === null || previous === undefined || previous.id === deploymentId) return null;
  const snapshot = parseRuntimeConfigSnapshot(previous.runtimeConfig);
  return { id: resourceId(previous.id), runtimeConfig: snapshot.ok ? snapshot.value : null };
}

function resourceId(id: string): ResourceId {
  const checked = validateResourceId(id);
  if (!checked.ok) throw new DeployTargetError();
  return checked.value;
}

type CredentialResult =
  | { readonly ok: true; readonly credential: DeployCredential }
  | { readonly ok: false; readonly code: DeployJobFailureCode };

function decodeOrNull(row: CredentialRowShape | null, masterKeys: MasterKeys): DecodedServiceCredential | null {
  if (row === null) return null;
  try {
    return decodeServiceCredential(row, masterKeys);
  } catch {
    // CredentialDecryptError only; its code is not needed by the caller.
    return null;
  }
}

function repositoryCredential(rows: DeployTargetRows, repositoryUrl: string, masterKeys: MasterKeys): CredentialResult {
  if (rows.service.repositoryCredentialId === null) return { ok: true, credential: { kind: 'none' } };
  const failed = { ok: false, code: 'REPOSITORY_AUTH_FAILED' } as const;
  const decoded = decodeOrNull(rows.repositoryCredential, masterKeys);
  if (decoded === null) return failed;
  if (decoded.kind === 'deploy_key') {
    if (!repositoryCredentialFits('git_deploy_key', repositoryUrl)) return failed;
    return { ok: true, credential: { kind: 'deploy_key', privateKey: decoded.privateKey } };
  }
  if (decoded.kind === 'https_token') {
    if (!repositoryCredentialFits('git_https_token', repositoryUrl)) return failed;
    return { ok: true, credential: { kind: 'https_token', token: decoded.token } };
  }
  return failed;
}

function registryCredential(rows: DeployTargetRows, imageRef: string, masterKeys: MasterKeys): CredentialResult {
  if (rows.service.registryCredentialId === null) return { ok: true, credential: { kind: 'none' } };
  const failed = { ok: false, code: 'REGISTRY_AUTH_FAILED' } as const;
  const decoded = decodeOrNull(rows.registryCredential, masterKeys);
  if (decoded?.kind !== 'registry') return failed;
  const host = validateRegistryHost(decoded.host);
  const username = validateRegistryUsername(decoded.username);
  if (!host.ok || !username.ok) return failed;
  if (decoded.host.toLowerCase() !== registryHostOfImageRef(imageRef)) return failed;
  return {
    ok: true,
    credential: { kind: 'registry', registry: { host: host.value, username: username.value, password: decoded.password } },
  };
}

/** 18-03: a stored SHA that is not 40-hex is a corrupt row, never passed on to git. */
function requestedShaOf(stored: string | null | undefined): CommitSha | null {
  if (stored === null || stored === undefined) return null;
  const checked = validateCommitSha(stored);
  if (!checked.ok) throw new DeployTargetError();
  return checked.value;
}

export function resolveDeployTarget(rows: DeployTargetRows, masterKeys: MasterKeys, panelPorts: PanelPorts): LoadTargetResult {
  const deploymentId = resourceId(rows.deployment.id);
  const serviceId = resourceId(rows.deployment.serviceId);
  if (rows.service.id !== serviceId) throw new DeployTargetError();
  const { source, internalPort, publishedPort } = snapshotOf(rows.deployment.source);
  const healthcheck = healthcheckOf(rows.service.healthcheck);
  const requestedSha = requestedShaOf(rows.deployment.commitSha);

  const credential =
    source.kind === 'git'
      ? repositoryCredential(rows, source.repositoryUrl, masterKeys)
      : registryCredential(rows, source.imageRef, masterKeys);
  if (!credential.ok) return { ok: false, code: credential.code };

  return {
    ok: true,
    serverId: rows.service.serverId,
    target: {
      serviceId,
      deploymentId,
      source,
      internalPort,
      publishedPort,
      credential: credential.credential,
      otherServices: rows.otherServices,
      panelPorts,
      healthcheck,
      autoRollback: rows.service.autoRollback ?? true,
      previousSuccess: previousSuccessOf(rows, deploymentId),
      requestedSha,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 23-04: env resolution
// ---------------------------------------------------------------------------------------------

export interface DeployEnvRows {
  readonly variables: readonly { readonly scope: EnvScope; readonly key: string; readonly value: string }[];
  readonly secrets: readonly { readonly id: string; readonly scope: EnvScope; readonly name: string; readonly version: number }[];
}

export type DeployEnvFailureCode = 'SECRET_UNRESOLVED' | 'ROLLBACK_TARGET_UNAVAILABLE';

export type ResolvedDeployEnv =
  | {
      readonly ok: true;
      readonly entries: readonly RuntimeEnvEntry[];
      /** Env key -> id of the secret its reference binds to. */
      readonly secretIds: ReadonlyMap<string, string>;
    }
  | { readonly ok: false; readonly code: DeployEnvFailureCode; readonly message: string };

/** A3: names the key and the reference (never a value). */
export function rollbackReferenceMessage(key: string, reference: string): string {
  return `The target deployment's variable ${key} references secret ${reference}, which no longer exists in this service, its environment or its project. Add the secret again, or roll back to another deployment.`;
}

function storedEnvValue(key: string, value: string): EnvDefinition {
  const parsed = parseEnvValue(value, key);
  // A row that no longer parses is passed on as stored (env-services reads it the same way).
  return { key, value: parsed.ok ? parsed.value : { kind: 'plain', value } };
}

/** Pure: the env of one deploy, plain values and pinned references, key-sorted. */
export function resolveDeployEnv(rows: DeployEnvRows, rollbackEnv: readonly RuntimeEnvEntry[] | null): ResolvedDeployEnv {
  const secretsByScope: Record<EnvScope, { readonly name: string; readonly version: number }[]> = {
    project: [],
    environment: [],
    service: [],
  };
  const secretId = new Map<string, string>();
  for (const secret of rows.secrets) {
    secretsByScope[secret.scope].push({ name: secret.name, version: secret.version });
    secretId.set(`${secret.scope}:${secret.name}`, secret.id);
  }

  let resolved: ResolvedEnvEntry[];
  if (rollbackEnv === null) {
    const byScope: Record<EnvScope, EnvDefinition[]> = { project: [], environment: [], service: [] };
    for (const row of rows.variables) byScope[row.scope].push(storedEnvValue(row.key, row.value));
    resolved = resolveEnv(byScope.project, byScope.environment, byScope.service);
  } else {
    resolved = [...rollbackEnv]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((entry) => ({
        key: entry.key,
        value: 'secretRef' in entry ? { kind: 'secret_ref', name: entry.secretRef } : { kind: 'plain', value: entry.value },
        scope: 'service',
        shadowed: [],
      }));
  }

  const bound = resolveSecretRefs(resolved, secretsByScope as SecretsByScope);
  if (!bound.ok) {
    if (rollbackEnv === null) return { ok: false, code: 'SECRET_UNRESOLVED', message: bound.message };
    return {
      ok: false,
      code: 'ROLLBACK_TARGET_UNAVAILABLE',
      message: rollbackReferenceMessage(bound.key ?? '', bound.reference ?? ''),
    };
  }
  const entries: RuntimeEnvEntry[] = [];
  const secretIds = new Map<string, string>();
  for (const binding of bound.value) {
    if ('value' in binding) {
      entries.push({ key: binding.key, value: binding.value });
      continue;
    }
    entries.push({ key: binding.key, secretRef: binding.secretRef, secretVersion: binding.secretVersion });
    const id = secretId.get(`${binding.secretScope}:${binding.secretRef}`);
    if (id !== undefined) secretIds.set(binding.key, id);
  }
  return { ok: true, entries, secretIds };
}

/** The secrets a service sees (env-store's visibility rule); ids and versions, never a value. */
function visibleSecretsOf(chain: OwnerChain): SQL | undefined {
  const levels: (SQL | undefined)[] = [eq(secrets.scope, 'project')];
  if (chain.environmentId !== null) {
    levels.push(and(eq(secrets.scope, 'environment'), eq(secrets.environmentId, chain.environmentId)));
  }
  if (chain.serviceId !== null) levels.push(and(eq(secrets.scope, 'service'), eq(secrets.serviceId, chain.serviceId)));
  return and(eq(secrets.projectId, chain.projectId), or(...levels));
}

/** 23-04 A3: the secrets `chain` sees now: ids, scopes, names and versions, never a value. */
export async function listVisibleSecrets(db: Pick<Database, 'select'>, chain: OwnerChain): Promise<DeployEnvRows['secrets']> {
  return db
    .select({ id: secrets.id, scope: secrets.scope, name: secrets.name, version: secrets.version })
    .from(secrets)
    .where(visibleSecretsOf(chain));
}

/** 23-04 A3: why a rollback target's env no longer resolves (named key and reference), or null. */
export async function rollbackTargetEnvIssue(
  db: Pick<Database, 'select'>,
  chain: OwnerChain,
  runtimeConfig: unknown,
): Promise<string | null> {
  const snapshot = parseRuntimeConfigSnapshot(runtimeConfig);
  if (!snapshot.ok) return null;
  const env = runtimeConfigEnv(snapshot.value);
  if (!env.some((entry) => 'secretRef' in entry)) return null;
  const resolved = resolveDeployEnv({ variables: [], secrets: await listVisibleSecrets(db, chain) }, env);
  return resolved.ok ? null : resolved.message;
}

function envOf(
  db: Database,
  chain: OwnerChain,
  resolved: Extract<ResolvedDeployEnv, { ok: true }>,
  masterKeys: () => Promise<MasterKeys>,
): DeployEnv {
  return {
    entries: resolved.entries,
    open: async (redactor): Promise<DeployEnvLease> => {
      const keys = [...resolved.secretIds.keys()];
      const lease = await decryptForDeploy(
        db,
        {
          chain: { projectId: chain.projectId, environmentId: chain.environmentId ?? '', serviceId: chain.serviceId ?? '' },
          secretIds: [...resolved.secretIds.values()],
        },
        await masterKeys(),
        redactor,
      );
      const byKey = new Map<string, NonNullable<ReturnType<typeof lease.values.get>>>();
      for (const key of keys) {
        const id = resolved.secretIds.get(key);
        const value = id === undefined ? undefined : lease.values.get(id);
        if (value === undefined) {
          lease.release();
          throw new SecretStoreError('SECRET_NOT_IN_SCOPE', id ?? '');
        }
        byKey.set(key, value);
      }
      return { secrets: byKey, release: () => lease.release() };
    },
  };
}

export interface LoadTargetDeps {
  readonly db: Database;
  readonly masterKeys: () => Promise<MasterKeys>;
  readonly panelPorts: PanelPorts;
  /** 22-05: bounds of the H2 re-apply; defaults to a 30 s step. */
  readonly routeLimits?: DomainApplyLimits;
  /** 22-05: defaults to the per-service route lock over `db` (H3). */
  readonly routeLock?: RouteLock;
}

/** The default step bound of a deploy's route re-apply (deploy-runtime keeps its own timeouts). */
export const DEPLOY_ROUTE_STEP_MS = 30_000;

/** 22-05: `routes` for a service with domains, or undefined (no proxy command at all). */
async function routesFor(
  deps: LoadTargetDeps,
  lock: RouteLock,
  service: { readonly id: string; readonly serverId: string },
): Promise<DeployRoutes | undefined> {
  const [routed] = await deps.db.select({ id: domains.id }).from(domains).where(eq(domains.serviceId, service.id)).limit(1);
  if (routed === undefined) return undefined;
  const [server] = await deps.db
    .select({ proxyStatus: servers.proxyStatus })
    .from(servers)
    .where(eq(servers.id, service.serverId))
    .limit(1);
  const limits = deps.routeLimits ?? domainApplyLimits(DEPLOY_ROUTE_STEP_MS);
  return {
    proxyRunning: server?.proxyStatus === 'RUNNING',
    reapply: (session, internalPort) =>
      applyRoutes(service.id, sessionRoutePorts(deps.db, session), { lock, limits, internalPort }),
  };
}

/** The job's `loadTarget` port over the database. Throws only on a driver error or a caller bug. */
export function createLoadTarget(
  deps: LoadTargetDeps,
): (deployment: { readonly id: string; readonly serviceId: string }) => Promise<LoadTargetResult> {
  const routeLock = deps.routeLock ?? createRouteLock(deps.db);
  return async ({ id }) => {
    const [deployment] = await deps.db
      .select({
        id: deployments.id,
        serviceId: deployments.serviceId,
        source: deployments.source,
        commitSha: deployments.commitSha,
        trigger: deployments.trigger,
        runtimeConfig: deployments.runtimeConfig,
      })
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);
    if (deployment === undefined) throw new DeployTargetError();
    const [service] = await deps.db
      .select({
        id: services.id,
        serverId: services.serverId,
        projectId: services.projectId,
        environmentId: services.environmentId,
        repositoryCredentialId: services.repositoryCredentialId,
        registryCredentialId: services.registryCredentialId,
        healthcheck: services.healthcheck,
        autoRollback: services.autoRollback,
      })
      .from(services)
      .where(eq(services.id, deployment.serviceId))
      .limit(1);
    if (service === undefined) throw new DeployTargetError();

    const credentialIds = [service.repositoryCredentialId, service.registryCredentialId].filter(
      (value): value is string => value !== null,
    );
    const credentialRows =
      credentialIds.length === 0
        ? []
        : await deps.db
            .select({
              id: credentials.id,
              type: credentials.type,
              encryptedValue: credentials.encryptedValue,
              keyVersion: credentials.keyVersion,
            })
            .from(credentials)
            .where(inArray(credentials.id, credentialIds));
    const rowFor = (credentialId: string | null): CredentialRowShape | null =>
      credentialId === null ? null : (credentialRows.find((row) => row.id === credentialId) ?? null);

    // Newest first; the id breaks a createdAt tie so the pick is deterministic.
    const [previousSuccess] = await deps.db
      .select({ id: deployments.id, runtimeConfig: deployments.runtimeConfig })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, deployment.serviceId),
          eq(deployments.status, 'SUCCESS'),
          ne(deployments.id, deployment.id),
        ),
      )
      .orderBy(desc(deployments.createdAt), desc(deployments.id))
      .limit(1);

    const otherServices = await deps.db
      .select({ serviceId: services.id, publishedPort: services.publishedPort })
      .from(services)
      .where(and(eq(services.serverId, service.serverId), ne(services.id, service.id), isNotNull(services.publishedPort)));

    // 23-04 A1: built from the service row (not loadOwnerChain), so it costs no extra service read.
    const chain: OwnerChain = {
      owner: { scope: 'service', projectId: service.projectId, serviceId: service.id },
      projectId: service.projectId,
      environmentId: service.environmentId,
      serviceId: service.id,
    };
    const variables = await listChainVariables(deps.db, chain);
    const visibleSecrets = await listVisibleSecrets(deps.db, chain);
    let rollbackEnv: readonly RuntimeEnvEntry[] | null = null;
    if (deployment.trigger === 'rollback') {
      const snapshot = parseRuntimeConfigSnapshot(deployment.runtimeConfig);
      // An unusable snapshot never reaches here: the worker ends it before loading (17-05).
      rollbackEnv = snapshot.ok ? runtimeConfigEnv(snapshot.value) : [];
    }
    const env = resolveDeployEnv({ variables, secrets: visibleSecrets }, rollbackEnv);
    if (!env.ok) return { ok: false, code: env.code, message: env.message };

    const resolved = resolveDeployTarget(
      {
        deployment,
        service,
        repositoryCredential: rowFor(service.repositoryCredentialId),
        registryCredential: rowFor(service.registryCredentialId),
        otherServices,
        previousSuccess: previousSuccess ?? null,
      },
      await deps.masterKeys(),
      deps.panelPorts,
    );
    if (!resolved.ok) return resolved;
    const { deploymentId, serviceId } = resolved.target;
    const recordRollbackStarted = async (targetDeploymentId: string | null): Promise<void> => {
      await writeDeploymentRollbackStartedEvent(deps.db, { deploymentId, serviceId, targetDeploymentId });
    };
    const routes = await routesFor(deps, routeLock, service);
    return {
      ...resolved,
      target: {
        ...resolved.target,
        recordRollbackStarted,
        env: envOf(deps.db, chain, env, deps.masterKeys),
        ...(routes === undefined ? {} : { routes }),
      },
    };
  };
}
