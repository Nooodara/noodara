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
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  parseRuntimeConfigSnapshot,
  validateHealthcheckConfig,
  type HealthcheckConfig,
} from '@noodara/domain/deployment';
import {
  validateContainerPort,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  validateServiceSource,
  type ResourceId,
  type ServiceSource,
} from '@noodara/domain/validators';
import { writeDeploymentRollbackStartedEvent } from '../activity/index.js';
import type { Database } from '../db/client.js';
import { credentials } from '../db/schema/credentials.js';
import { deployments } from '../db/schema/deployments.js';
import { services } from '../db/schema/services.js';
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
import type { DeployCredential } from './run-deployment.js';

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
  readonly deployment: { readonly id: string; readonly serviceId: string; readonly source: unknown };
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

export function resolveDeployTarget(rows: DeployTargetRows, masterKeys: MasterKeys, panelPorts: PanelPorts): LoadTargetResult {
  const deploymentId = resourceId(rows.deployment.id);
  const serviceId = resourceId(rows.deployment.serviceId);
  if (rows.service.id !== serviceId) throw new DeployTargetError();
  const { source, internalPort, publishedPort } = snapshotOf(rows.deployment.source);
  const healthcheck = healthcheckOf(rows.service.healthcheck);

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
    },
  };
}

export interface LoadTargetDeps {
  readonly db: Database;
  readonly masterKeys: () => Promise<MasterKeys>;
  readonly panelPorts: PanelPorts;
}

/** The job's `loadTarget` port over the database. Throws only on a driver error or a caller bug. */
export function createLoadTarget(
  deps: LoadTargetDeps,
): (deployment: { readonly id: string; readonly serviceId: string }) => Promise<LoadTargetResult> {
  return async ({ id }) => {
    const [deployment] = await deps.db
      .select({ id: deployments.id, serviceId: deployments.serviceId, source: deployments.source })
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);
    if (deployment === undefined) throw new DeployTargetError();
    const [service] = await deps.db
      .select({
        id: services.id,
        serverId: services.serverId,
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
    return { ...resolved, target: { ...resolved.target, recordRollbackStarted } };
  };
}
