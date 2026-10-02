// RED stub (11-15): replaced by the implementation in the GREEN commit.
import type { Redactor, SecretValue } from '@noodara/domain/security';
import type { CommitSha, DeployWorkspace, ServiceSource } from '@noodara/domain/validators';
import type { SshDeploySession, StreamChunk } from '@noodara/ssh';
import type { StepLimits, StepResult } from './step-result.js';

export type GitCredential =
  | { readonly kind: 'none' }
  | { readonly kind: 'deploy_key'; readonly privateKey: SecretValue }
  | { readonly kind: 'https_token'; readonly token: SecretValue };

export interface CloneRepositoryInput {
  readonly session: SshDeploySession;
  readonly redactor: Redactor;
  readonly workspace: DeployWorkspace;
  readonly source: Extract<ServiceSource, { kind: 'git' }>;
  readonly credential: GitCredential;
  readonly limits: StepLimits;
  readonly signal?: AbortSignal;
  readonly onChunk?: (chunk: StreamChunk) => void;
}

export interface ClonedRepository {
  readonly commitSha: CommitSha;
}

export function cloneRepository(_input: CloneRepositoryInput): Promise<StepResult<ClonedRepository>> {
  return Promise.reject(new Error('not implemented'));
}
