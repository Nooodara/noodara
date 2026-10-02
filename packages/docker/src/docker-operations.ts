// Docker operations (11-15, D26): one allowlisted template per wrapper through
// SshDeploySession.stream, failures classified with classifyDockerError. RED stub.
import type { ContainerStateResult, DockerPsResult } from '@noodara/domain/deployment';
import type { Redactor, SecretValue } from '@noodara/domain/security';
import type {
  ContainerName,
  ContainerPort,
  DeployWorkspace,
  ImageRef,
  NetworkName,
  RegistryHost,
  RegistryUsername,
  ResourceId,
  ServiceSource,
} from '@noodara/domain/validators';
import type { SshDeploySession, StreamChunk } from '@noodara/ssh';
import type { StepLimits, StepResult } from './step-result.js';

export interface DockerStepContext {
  readonly session: SshDeploySession;
  /** The redactor the session was connected with. */
  readonly redactor: Redactor;
  readonly limits: StepLimits;
  readonly signal?: AbortSignal;
  readonly onChunk?: (chunk: StreamChunk) => void;
}

export interface RegistryCredential {
  readonly host: RegistryHost;
  readonly username: RegistryUsername;
  readonly password: SecretValue;
}

export interface PullImageInput {
  readonly workspace: DeployWorkspace;
  readonly image: ImageRef;
  readonly registry: RegistryCredential | null;
}

export interface BuildImageInput {
  readonly workspace: DeployWorkspace;
  readonly source: Extract<ServiceSource, { kind: 'git' }>;
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
}

export interface CreateContainerInput {
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
  readonly image: ImageRef;
  readonly internalPort: ContainerPort;
  readonly publishedPort: ContainerPort | null;
}

export interface ServiceRef {
  readonly serviceId: ResourceId;
}

export interface StopContainerInput extends ServiceRef {
  readonly timeoutSeconds: number;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export function pullImage(_c: DockerStepContext, _i: PullImageInput): Promise<StepResult<ImageRef>> {
  return notImplemented();
}
export function buildImage(_c: DockerStepContext, _i: BuildImageInput): Promise<StepResult<ImageRef>> {
  return notImplemented();
}
export function ensureNetwork(_c: DockerStepContext, _i: ServiceRef): Promise<StepResult<NetworkName>> {
  return notImplemented();
}
export function createContainer(
  _c: DockerStepContext,
  _i: CreateContainerInput,
): Promise<StepResult<ContainerName>> {
  return notImplemented();
}
export function startContainer(_c: DockerStepContext, _i: ServiceRef): Promise<StepResult<ContainerName>> {
  return notImplemented();
}
export function stopContainer(
  _c: DockerStepContext,
  _i: StopContainerInput,
): Promise<StepResult<ContainerName>> {
  return notImplemented();
}
export function restartContainer(
  _c: DockerStepContext,
  _i: StopContainerInput,
): Promise<StepResult<ContainerName>> {
  return notImplemented();
}
export function removeContainer(_c: DockerStepContext, _i: ServiceRef): Promise<StepResult<ContainerName>> {
  return notImplemented();
}
export function removeImage(
  _c: DockerStepContext,
  _i: { readonly image: ImageRef },
): Promise<StepResult<ImageRef>> {
  return notImplemented();
}
export function removeNetwork(_c: DockerStepContext, _i: ServiceRef): Promise<StepResult<NetworkName>> {
  return notImplemented();
}
export function inspectContainerState(
  _c: DockerStepContext,
  _i: ServiceRef,
): Promise<StepResult<ContainerStateResult>> {
  return notImplemented();
}
export function listManagedContainers(_c: DockerStepContext): Promise<StepResult<DockerPsResult>> {
  return notImplemented();
}
export function removeWorkspace(
  _c: DockerStepContext,
  _i: { readonly workspace: DeployWorkspace },
): Promise<StepResult<DeployWorkspace>> {
  return notImplemented();
}
