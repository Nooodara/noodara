// ActivityEvent domain shape (AUTH-04, noodara-domain-model skill §7, ARCHITECTURE.md §6). Phase 1
// provided the type, the auth action union and the construction guard that makes it structurally
// impossible to build an event carrying a raw secret; phase 3 added `server.*`; phase 9 (SET-02/
// SET-03, D-08) adds `account.*`, whose metadata is further restricted to a per-action allowlist
// (`ACCOUNT_ACTION_METADATA_KEYS`) enforced before the general forbidden-key walk below, since
// "no secrets" is not enough for these three actions — D-08 also requires "no previous value,
// nothing else at all". Phase 12 (12-05) adds the deploy engine actions (`project.*`,
// `environment.*`, `service.*`, `deployment.*`), each with a closed, typed metadata allowlist.

import { SecretValue } from '../security/secret-value.js';

/**
 * The exhaustive set of auth-related activity actions this phase emits (D-07's login failures,
 * D-01/D-04's setup/pre-seed, session lifecycle). Widening this union to cover v0.2+ actions
 * (server.*, project.*, ...) is phase 3's job.
 */
export const AUTH_ACTIONS = [
  'auth.setup_completed',
  'auth.admin_preseeded',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.login_blocked',
  'auth.logout',
  'auth.session_revoked',
  'auth.password_reset',
] as const;

export type AuthAction = (typeof AUTH_ACTIONS)[number];

/**
 * The six typed `server.*` activity actions this phase adds (ACT-01, D-16). Metadata shape per
 * action (never before/after values for identity/access fields — those never travel in metadata):
 * - `server.created` — `{ name, host, sshPort, sshUser, credentialType }`
 * - `server.updated` — `{ changedFields: string[], credentialReplaced: boolean }`
 * - `server.deleted` — `{ name, host }`
 * - `server.connection_attempted` — `{ attempts, durationMs, fingerprintCaptured }`, with
 *   `outcome`/`errorCode` carried on the event itself, not in metadata
 * - `server.discovery_completed` — `{ snapshotId, warnings, checksFailed: string[] }`, with
 *   `outcome`/`errorCode` carried on the event itself
 * - `server.fingerprint_trusted` — `{ previousFingerprint, newFingerprint }` (fingerprints are
 *   public, D-16, so they are safe in metadata)
 */
export const SERVER_ACTIONS = [
  'server.created',
  'server.updated',
  'server.deleted',
  'server.connection_attempted',
  'server.discovery_completed',
  'server.fingerprint_trusted',
] as const;

export type ServerAction = (typeof SERVER_ACTIONS)[number];

/**
 * The three `account.*` activity actions added in phase 9 (SET-02/SET-03, D-08). Metadata shape
 * per action is a closed allowlist (`ACCOUNT_ACTION_METADATA_KEYS` below), never the previous
 * value, never a password, hash, token or IP:
 * - `account.name_changed` — `{ name }` (new name only)
 * - `account.email_changed` — `{ email }` (new email only, never `previousEmail`)
 * - `account.password_changed` — `{ sessions_revoked }` (count of other sessions revoked)
 */
export const ACCOUNT_ACTIONS = ['account.name_changed', 'account.email_changed', 'account.password_changed'] as const;

export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

/** The v0.1 actions (auth phase 1 + server phase 3 + account phase 9). `apps/web`'s activity copy
 *  table is exhaustive over exactly this union; the deploy engine actions below join it when
 *  their UI copy lands (Phase 13), which is why they are a separate union for now. */
export type ActivityAction = AuthAction | ServerAction | AccountAction;

/**
 * Deploy engine actions (Phase 12, 12-05). Every one has a closed metadata allowlist
 * (`DEPLOY_ENGINE_ACTION_METADATA_KEYS`) with a fixed value kind per key
 * (`DEPLOY_ENGINE_METADATA_KEY_KINDS`): no repository URL, image reference, branch, command
 * output or credential ever travels in metadata, and `errorCode`/`outcome` live on the event.
 * `entityType` must equal the action's namespace.
 */
export const PROJECT_ACTIONS = [
  'project.created',
  'project.updated',
  'project.archived',
  'project.unarchived',
  'project.deleted',
] as const;

export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export const ENVIRONMENT_ACTIONS = ['environment.created', 'environment.updated', 'environment.deleted'] as const;

export type EnvironmentAction = (typeof ENVIRONMENT_ACTIONS)[number];

/** `service.container_changed` is the reconcile tick's record of a container stopped or removed
 *  outside Noodara (D3); always `actorType: 'system'` in practice. */
export const SERVICE_ACTIONS = [
  'service.created',
  'service.updated',
  'service.deleted',
  'service.started',
  'service.stopped',
  'service.restarted',
  'service.container_changed',
] as const;

export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** `deployment.finished` covers SUCCESS, FAILED (incl. WORKER_CRASHED) and CANCELLED; the final
 *  status is `metadata.status`, the failure code is the event's `errorCode`. */
export const DEPLOYMENT_ACTIONS = ['deployment.queued', 'deployment.cancel_requested', 'deployment.finished'] as const;

export type DeploymentAction = (typeof DEPLOYMENT_ACTIONS)[number];

export const DEPLOY_ENGINE_ACTIONS = [
  ...PROJECT_ACTIONS,
  ...ENVIRONMENT_ACTIONS,
  ...SERVICE_ACTIONS,
  ...DEPLOYMENT_ACTIONS,
] as const;

export type DeployEngineAction = (typeof DEPLOY_ENGINE_ACTIONS)[number];

/** Every action `buildActivityEvent` accepts. */
export type AnyActivityAction = ActivityAction | DeployEngineAction;

export const ALL_ACTIVITY_ACTIONS: readonly AnyActivityAction[] = Object.freeze([
  ...AUTH_ACTIONS,
  ...SERVER_ACTIONS,
  ...ACCOUNT_ACTIONS,
  ...DEPLOY_ENGINE_ACTIONS,
]);

const ACTIVITY_ACTION_SET: ReadonlySet<string> = new Set(ALL_ACTIVITY_ACTIONS);

const ACCOUNT_ACTION_SET: ReadonlySet<string> = new Set(ACCOUNT_ACTIONS);

const DEPLOY_ENGINE_ACTION_SET: ReadonlySet<string> = new Set(DEPLOY_ENGINE_ACTIONS);

/**
 * Value kinds for deploy engine metadata. `text` is a short display string (a name, a slug, a
 * free-text environment kind) that may never embed URL credentials; `id` and `code` are closed
 * charsets; `fields` is a list of field identifiers; `count` is a non-negative integer. `text`,
 * `id` and `code` also accept `null`.
 */
export type DeployEngineMetadataKind = 'text' | 'id' | 'code' | 'fields' | 'boolean' | 'count';

export const DEPLOY_ENGINE_METADATA_KEY_KINDS: Readonly<Record<string, DeployEngineMetadataKind>> = Object.freeze({
  name: 'text',
  slug: 'text',
  kind: 'text',
  projectId: 'id',
  environmentId: 'id',
  serverId: 'id',
  serviceId: 'id',
  deploymentId: 'id',
  commitSha: 'id',
  sourceType: 'code',
  trigger: 'code',
  status: 'code',
  previousStatus: 'code',
  observedState: 'code',
  changedFields: 'fields',
  requiresRedeploy: 'boolean',
  credentialReplaced: 'boolean',
  durationMs: 'count',
  environments: 'count',
  services: 'count',
});

export const DEPLOY_ENGINE_ACTION_METADATA_KEYS: Readonly<Record<DeployEngineAction, readonly string[]>> =
  Object.freeze({
    'project.created': ['name', 'slug'],
    'project.updated': ['changedFields'],
    'project.archived': ['name'],
    'project.unarchived': ['name'],
    'project.deleted': ['name', 'environments', 'services'],
    'environment.created': ['projectId', 'name', 'kind'],
    'environment.updated': ['projectId', 'changedFields'],
    'environment.deleted': ['projectId', 'name'],
    'service.created': ['projectId', 'environmentId', 'serverId', 'name', 'sourceType'],
    'service.updated': ['changedFields', 'requiresRedeploy', 'credentialReplaced'],
    'service.deleted': ['projectId', 'environmentId', 'serverId', 'name'],
    'service.started': ['serverId', 'durationMs'],
    'service.stopped': ['serverId', 'durationMs'],
    'service.restarted': ['serverId', 'durationMs'],
    'service.container_changed': ['serverId', 'previousStatus', 'observedState'],
    'deployment.queued': ['serviceId', 'trigger'],
    'deployment.cancel_requested': ['serviceId', 'status'],
    'deployment.finished': ['serviceId', 'status', 'durationMs', 'commitSha'],
  });

const MAX_TEXT_LENGTH = 256;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 64;
// `scheme://anything@` — a URL with userinfo (token, password or user) never belongs in metadata.
const URL_USERINFO_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]*@/;

function isValidMetadataValue(kind: DeployEngineMetadataKind, value: unknown): boolean {
  switch (kind) {
    case 'text':
      return (
        value === null ||
        (typeof value === 'string' && value.length <= MAX_TEXT_LENGTH && !URL_USERINFO_PATTERN.test(value))
      );
    case 'id':
      return value === null || (typeof value === 'string' && ID_PATTERN.test(value));
    case 'code':
      return value === null || (typeof value === 'string' && CODE_PATTERN.test(value));
    case 'fields':
      return (
        Array.isArray(value) &&
        value.length <= MAX_FIELDS &&
        value.every((item) => typeof item === 'string' && FIELD_PATTERN.test(item))
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
}

function assertDeployEngineMetadata(action: DeployEngineAction, metadata: ActivityMetadata): void {
  const allowedKeys = DEPLOY_ENGINE_ACTION_METADATA_KEYS[action];
  for (const [key, value] of Object.entries(metadata)) {
    const kind = DEPLOY_ENGINE_METADATA_KEY_KINDS[key];
    if (!allowedKeys.includes(key) || kind === undefined || !isValidMetadataValue(kind, value)) {
      throw new SensitiveMetadataError(key);
    }
  }
}

/** The structural enforcement of D-08: an `account.*` event's metadata may only ever carry the
 *  keys listed here for its action — never a previous value, never anything else. */
const ACCOUNT_ACTION_METADATA_KEYS: Readonly<Record<AccountAction, readonly string[]>> = Object.freeze({
  'account.name_changed': ['name'],
  'account.email_changed': ['email'],
  'account.password_changed': ['sessions_revoked'],
});

export type ActivityActorType = 'user' | 'system';
export type ActivityOutcome = 'success' | 'failure';

/** `metadata` is JSON-shaped structured detail (ARCHITECTURE.md §6) — never a raw secret. */
export type ActivityMetadata = Record<string, unknown>;

export interface ActivityEvent {
  readonly actorType: ActivityActorType;
  readonly actorId: string | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: AnyActivityAction;
  readonly outcome: ActivityOutcome;
  readonly errorCode?: string;
  readonly metadata: ActivityMetadata;
  readonly occurredAt: Date;
}

export interface BuildActivityEventInput {
  readonly actorType: ActivityActorType;
  readonly actorId?: string | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: AnyActivityAction;
  readonly outcome: ActivityOutcome;
  readonly errorCode?: string;
  readonly metadata?: ActivityMetadata;
}

/** Raised when `input.action` is not in `ALL_ACTIVITY_ACTIONS` (a caller bypassing the static
 *  type, e.g. data loaded from persistence), or when a deploy engine action's `entityType` is not
 *  its own namespace. */
export class InvalidActivityActionError extends Error {
  constructor(action: string, reason = 'Unknown activity action') {
    super(`${reason}: "${action}"`);
    this.name = 'InvalidActivityActionError';
  }
}

/**
 * Raised when `metadata` contains a forbidden key (case-insensitive, checked recursively through
 * nested plain objects and arrays) or a `SecretValue` instance at any depth — the structural
 * guarantee behind AUTH-04's "sin incluir el password" (noodara-security skill §3, §10).
 */
export class SensitiveMetadataError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Activity metadata must not contain a sensitive value (key: "${key}")`);
    this.name = 'SensitiveMetadataError';
    this.key = key;
  }
}

const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'secret',
  'token',
  'credential',
  'privatekey',
  'sshpassword',
  'masterkey',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoSensitiveMetadata(value: unknown): void {
  if (value instanceof SecretValue) {
    throw new SensitiveMetadataError('<SecretValue instance>');
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveMetadata(item);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
        throw new SensitiveMetadataError(key);
      }
      assertNoSensitiveMetadata(nested);
    }
  }
}

/**
 * Builds an `ActivityEvent`. `now` is always supplied by the caller (application-layer clock) —
 * this module never reads the platform's wall-clock API directly, keeping packages/domain pure
 * and this function's output deterministic in tests.
 */
export function buildActivityEvent(input: BuildActivityEventInput, now: Date): ActivityEvent {
  if (!ACTIVITY_ACTION_SET.has(input.action)) {
    throw new InvalidActivityActionError(input.action);
  }

  const metadata = input.metadata ?? {};

  if (DEPLOY_ENGINE_ACTION_SET.has(input.action)) {
    const action = input.action as DeployEngineAction;
    if (input.entityType !== action.slice(0, action.indexOf('.'))) {
      throw new InvalidActivityActionError(action, 'Activity entityType does not match action');
    }
    assertDeployEngineMetadata(action, metadata);
  }

  if (ACCOUNT_ACTION_SET.has(input.action)) {
    const allowedKeys = ACCOUNT_ACTION_METADATA_KEYS[input.action as AccountAction];
    for (const key of Object.keys(metadata)) {
      if (!allowedKeys.includes(key)) {
        throw new SensitiveMetadataError(key);
      }
    }
  }

  assertNoSensitiveMetadata(metadata);

  return {
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    outcome: input.outcome,
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    metadata,
    occurredAt: now,
  };
}
