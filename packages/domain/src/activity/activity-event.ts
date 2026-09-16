// ActivityEvent domain shape (AUTH-04, noodara-domain-model skill §7, ARCHITECTURE.md §6). This
// phase provides only the type, the auth action union and the construction guard that makes it
// structurally impossible to build an event carrying a raw secret — the writer service that
// actually persists rows into `activity_events` and the non-auth action union members (server.*,
// project.* etc.) land in phase 3 (01-CONTEXT.md: "el servicio completo llega en fase 3").

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

/** The combined set of actions `buildActivityEvent` accepts (auth phase 1 + server phase 3). */
export type ActivityAction = AuthAction | ServerAction;

const ACTIVITY_ACTIONS: readonly string[] = [...AUTH_ACTIONS, ...SERVER_ACTIONS];

export type ActivityActorType = 'user' | 'system';
export type ActivityOutcome = 'success' | 'failure';

/** `metadata` is JSON-shaped structured detail (ARCHITECTURE.md §6) — never a raw secret. */
export type ActivityMetadata = Record<string, unknown>;

export interface ActivityEvent {
  readonly actorType: ActivityActorType;
  readonly actorId: string | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: ActivityAction;
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
  readonly action: ActivityAction;
  readonly outcome: ActivityOutcome;
  readonly errorCode?: string;
  readonly metadata?: ActivityMetadata;
}

/** Raised when `input.action` is not one of the combined `AUTH_ACTIONS`/`SERVER_ACTIONS` set (a
 *  caller bypassing the static type, e.g. data loaded from persistence). */
export class InvalidActivityActionError extends Error {
  constructor(action: string) {
    super(`Unknown activity action: "${action}"`);
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
  if (!ACTIVITY_ACTIONS.includes(input.action)) {
    throw new InvalidActivityActionError(input.action);
  }

  const metadata = input.metadata ?? {};
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
