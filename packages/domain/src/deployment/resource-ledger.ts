// In-job resource ledger (DEP-06, QA-08). The deploy job records every remote resource it creates
// and asks for the cleanup set of the exit it ends in. Rules:
// - Secrets files and the workspace are removed on every exit, secrets first.
// - The per-service container `noodara-<serviceId>` is never in any cleanup set: once an attempt
//   has created it (fixed name, stop-then-start, OPEN_QUESTIONS #5) it IS the service's container
//   and a failed start keeps it for diagnosis; before that the previous one still runs.
// - The per-attempt image goes only when no container of this attempt uses it. The image of a
//   container this attempt replaced is never in a cleanup set: after SUCCESS it is a known-good
//   rollback target and image retention (17-04) decides whether it stays.
// - The network goes only when this attempt created it and attached nothing to it.
// - 22-05: proxy resources (the dynamic file, the proxy's network membership) belong to the
//   domains, never to an attempt: no exit lists them, and a network the proxy joined stays.
// - WORKER_CRASHED: the in-job ledger is lost, so the set uses only the deterministic names.
// - 17-02 (H1): the previous container is kept as `noodara-<serviceId>-prev` until the new one
//   passes its healthcheck. Its image is the restore target, so no exit ever lists it.
// Removals are never forced, so a second run (or an in-use image) is a no-op, never an error.

import type { CommandOutput } from '../discovery/docker-version.js';
import {
  containerNameFor,
  deploymentImageRefFor,
  deployWorkspaceFor,
  networkNameFor,
  type ContainerName,
  type DeploySecretName,
  type DeployWorkspacePath,
  type ImageRef,
  type NetworkName,
} from '../validators/docker-naming.js';
import { fail, ok, type ValidationResult } from '../validators/network.js';

export const DEPLOYMENT_EXITS = Object.freeze([
  'SUCCESS',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'WORKER_CRASHED',
] as const);

export type DeploymentExit = (typeof DEPLOYMENT_EXITS)[number];

export interface ResourceLedger {
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly names: {
    readonly workspace: DeployWorkspacePath;
    readonly image: ImageRef;
    readonly network: NetworkName;
    readonly container: ContainerName;
  };
  readonly workspaceCreated: boolean;
  readonly secretsFiles: readonly string[];
  readonly imageCreated: boolean;
  readonly networkCreatedByAttempt: boolean;
  readonly containerCreated: boolean;
  /** Image of the per-service container this attempt removed, when it is this service's own. */
  readonly replacedImage: ImageRef | null;
  /** Image of the container kept as `-prev` (the restore target); never cleaned up on failure. */
  readonly previousImage: string | null;
  /** 22-05: the proxy joined the service network (the service has domains); the network stays. */
  readonly proxyAttached: boolean;
}

export type LedgerEvent =
  | { readonly kind: 'workspace_created' }
  | { readonly kind: 'secrets_file_written'; readonly name: DeploySecretName | 'docker_config' | 'env' }
  | { readonly kind: 'image_created' }
  /** Only when the network did not exist before this attempt. */
  | { readonly kind: 'network_created' }
  | { readonly kind: 'container_created' }
  /** 17-02: the previous container was stopped and kept as `-prev` (not removed). */
  | { readonly kind: 'previous_container_kept'; readonly imageRef: string | null }
  | { readonly kind: 'previous_container_removed'; readonly imageRef: string | null }
  /** 22-05: the proxy is connected to the service network. */
  | { readonly kind: 'proxy_attached' };

export type CleanupResource =
  | { readonly kind: 'secrets_file'; readonly path: string }
  | { readonly kind: 'workspace'; readonly path: string }
  | { readonly kind: 'image'; readonly ref: string }
  | { readonly kind: 'network'; readonly name: string };

export type CleanupOutcome = 'removed' | 'already_absent' | 'in_use' | 'failed';

const RESOURCE_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function createResourceLedger(
  serviceId: string,
  deploymentId: string,
): ValidationResult<ResourceLedger> {
  const workspace = deployWorkspaceFor(deploymentId);
  const image = deploymentImageRefFor(serviceId, deploymentId);
  const network = networkNameFor(serviceId);
  const container = containerNameFor(serviceId);
  if (!workspace.ok || !image.ok || !network.ok || !container.ok) {
    return fail('RESOURCE_ID_INVALID', 'Resource id must be a lowercase UUID');
  }
  return ok({
    serviceId,
    deploymentId,
    names: {
      workspace: workspace.value.root,
      image: image.value,
      network: network.value,
      container: container.value,
    },
    workspaceCreated: false,
    secretsFiles: [],
    imageCreated: false,
    networkCreatedByAttempt: false,
    containerCreated: false,
    replacedImage: null,
    previousImage: null,
    proxyAttached: false,
  });
}

function secretsPath(ledger: ResourceLedger, name: DeploySecretName | 'docker_config' | 'env'): string {
  const file = name === 'docker_config' ? 'docker' : name;
  return `${ledger.names.workspace}/secrets/${file}`;
}

function ownReplacedImage(ledger: ResourceLedger, imageRef: string | null): ImageRef | null {
  if (imageRef === null || imageRef === ledger.names.image) {
    return null;
  }
  const own = new RegExp(`^noodara/${ledger.serviceId}:${RESOURCE_ID}$`);
  return own.test(imageRef) ? (imageRef as ImageRef) : null;
}

/** Returns a new ledger with the event recorded; the input is never mutated. */
export function recordResource(ledger: ResourceLedger, event: LedgerEvent): ResourceLedger {
  switch (event.kind) {
    case 'workspace_created':
      return { ...ledger, workspaceCreated: true };
    case 'secrets_file_written': {
      const path = secretsPath(ledger, event.name);
      return ledger.secretsFiles.includes(path)
        ? ledger
        : { ...ledger, secretsFiles: [...ledger.secretsFiles, path] };
    }
    case 'image_created':
      return { ...ledger, imageCreated: true };
    case 'network_created':
      return { ...ledger, networkCreatedByAttempt: true };
    case 'container_created':
      return { ...ledger, containerCreated: true };
    case 'previous_container_kept':
      return { ...ledger, previousImage: event.imageRef };
    case 'previous_container_removed':
      return { ...ledger, replacedImage: ownReplacedImage(ledger, event.imageRef) };
    case 'proxy_attached':
      return { ...ledger, proxyAttached: true };
  }
}

/** Deterministic and side-effect free: the same ledger and exit always yield the same set. */
export function cleanupSetFor(
  ledger: ResourceLedger,
  exit: DeploymentExit,
): readonly CleanupResource[] {
  const workspace: CleanupResource = { kind: 'workspace', path: ledger.names.workspace };
  if (exit === 'WORKER_CRASHED') {
    // `rm -rf` of the workspace also takes its secrets; an image still in use is refused.
    return keepPrevious(ledger, [workspace, { kind: 'image', ref: ledger.names.image }]);
  }

  const set: CleanupResource[] = [
    ...ledger.secretsFiles.map((path): CleanupResource => ({ kind: 'secrets_file', path })),
    workspace,
  ];
  const failed = exit !== 'SUCCESS';
  if (failed && ledger.imageCreated && !ledger.containerCreated) {
    set.push({ kind: 'image', ref: ledger.names.image });
  }
  if (failed && ledger.networkCreatedByAttempt && !ledger.containerCreated && !ledger.proxyAttached) {
    set.push({ kind: 'network', name: ledger.names.network });
  }
  return failed ? keepPrevious(ledger, set) : set;
}

/** H1: the kept previous image is the restore target; a failed exit never lists it. */
function keepPrevious(ledger: ResourceLedger, set: readonly CleanupResource[]): readonly CleanupResource[] {
  const kept = [ledger.previousImage, ledger.replacedImage].filter((ref): ref is string => ref !== null);
  return set.filter((resource) => resource.kind !== 'image' || !kept.includes(resource.ref));
}

const IMAGE_ABSENT = /No such image/i;
const IMAGE_IN_USE = /is using its referenced image|image is being used|must be forced|must force/i;
const NETWORK_ABSENT = /No such network|network \S+ not found/i;
const NETWORK_IN_USE = /active endpoints/i;
const PATH_ABSENT = /No such file or directory/i;

/** Classifies the output of one removal command; only `failed` needs a retry or a report. */
export function classifyCleanupOutcome(
  resource: CleanupResource,
  output: CommandOutput,
): CleanupOutcome {
  if (output.exitCode === 0) {
    return 'removed';
  }
  const { stderr } = output;
  switch (resource.kind) {
    case 'image':
      if (IMAGE_ABSENT.test(stderr)) return 'already_absent';
      return IMAGE_IN_USE.test(stderr) ? 'in_use' : 'failed';
    case 'network':
      if (NETWORK_ABSENT.test(stderr)) return 'already_absent';
      return NETWORK_IN_USE.test(stderr) ? 'in_use' : 'failed';
    case 'workspace':
    case 'secrets_file':
      return PATH_ABSENT.test(stderr) ? 'already_absent' : 'failed';
  }
}

export function isCleanupSettled(outcome: CleanupOutcome): boolean {
  return outcome !== 'failed';
}
