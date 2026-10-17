// 18-01 (HOOK-01): a service's GitHub push webhook. Enabling draws an opaque hook id (the public
// URL path segment) and a 32-byte HMAC secret from node:crypto, encrypts the secret into
// `credentials` (type 'webhook_secret', the same AES-256-GCM envelope as every other credential)
// and returns it once. Reads expose `enabled` and the payload URL only. Rotation swaps the
// credential row in one transaction; disable clears the hook id and deletes the row, so a later
// delivery resolves exactly like an unknown hook id.
//
// The payload URL is built from the configured public origin only (`webhookPublicOrigin`, checked
// when the routes register), never from a request's Host or X-Forwarded-* headers.
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { encryptSecret, revealSecret, secretValue, type SecretValue } from '@noodara/domain/security';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { Database } from '../db/client.js';
import { credentials } from '../db/schema/credentials.js';
import { services } from '../db/schema/services.js';
import { currentKeyVersion, decryptCredentialEnvelope } from './credential-store.js';
import type { MasterKeys, ServiceActor } from './server-service-deps.js';

/** HMAC secret size: 256 bits, hex-encoded for the GitHub form (64 characters). */
export const WEBHOOK_SECRET_BYTES = 32;
/** Hook id size: 192 bits, base64url (32 characters, inside the column's 22..64 check). */
export const WEBHOOK_HOOK_ID_BYTES = 24;
/** Fresh hook ids drawn when the unique index reports a collision before enable gives up (18-05 H9). */
export const WEBHOOK_HOOK_ID_ATTEMPTS = 3;
const HOOK_ID_UNIQUE_INDEX = 'services_webhook_hook_id_unique_idx';
/** The receiver path (18-02); the hook id is its only variable part. */
export const WEBHOOK_PATH_PREFIX = '/webhooks/github/';

const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

export type RandomBytes = (size: number) => Buffer;

// ---------------------------------------------------------------------------------------------
// Public origin and payload URL (H3)
// ---------------------------------------------------------------------------------------------

/** Fixed messages: the configured value is never quoted (it could carry userinfo). */
export class WebhookOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookOriginError';
  }
}

/** The origin of `NOODARA_PUBLIC_URL`: an absolute http(s) URL without credentials. Throws
 *  `WebhookOriginError` otherwise, so a bad value fails the boot instead of a later request. */
export function webhookPublicOrigin(publicUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new WebhookOriginError('NOODARA_PUBLIC_URL must be an absolute http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebhookOriginError('NOODARA_PUBLIC_URL must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebhookOriginError('NOODARA_PUBLIC_URL must not carry credentials');
  }
  return url.origin;
}

export function webhookPayloadUrl(publicOrigin: string, hookId: string): string {
  return `${publicOrigin}${WEBHOOK_PATH_PREFIX}${hookId}`;
}

// ---------------------------------------------------------------------------------------------
// Generation (H1): CSPRNG only, nothing derived from the service
// ---------------------------------------------------------------------------------------------

export interface GeneratedWebhook {
  readonly hookId: string;
  readonly secret: SecretValue;
}

export function generateHookId(random: RandomBytes = cryptoRandomBytes): string {
  return random(WEBHOOK_HOOK_ID_BYTES).toString('base64url');
}

export function generateWebhookSecret(random: RandomBytes = cryptoRandomBytes): SecretValue {
  const bytes = random(WEBHOOK_SECRET_BYTES);
  const secret = secretValue(bytes.toString('hex'), 'api_key');
  bytes.fill(0);
  return secret;
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface WebhookConfigDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly masterKeys: () => Promise<MasterKeys>;
  /** Already validated by `webhookPublicOrigin`. */
  readonly publicOrigin: string;
  /** Test seam; defaults to `crypto.randomBytes`. */
  readonly randomBytes?: RandomBytes;
}

export interface WebhookTarget {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly serviceId: string;
}

export interface WebhookView {
  readonly enabled: boolean;
  readonly payloadUrl: string | null;
}

/** Returned by enable and rotate only: the one time the secret leaves the server. */
export interface WebhookSecretView {
  readonly enabled: true;
  readonly payloadUrl: string;
  readonly secret: SecretValue;
}

interface Failure<Code extends string> {
  readonly ok: false;
  readonly code: Code;
  readonly message: string;
}

export type WebhookFailureCode =
  | 'NOT_FOUND'
  | 'WEBHOOK_SOURCE_NOT_GIT'
  | 'WEBHOOK_ALREADY_ENABLED'
  | 'WEBHOOK_NOT_ENABLED'
  | 'WEBHOOK_HOOK_ID_CONFLICT';

export type WebhookSecretResult = { readonly ok: true; readonly webhook: WebhookSecretView } | Failure<WebhookFailureCode>;

export type WebhookDisableResult = { readonly ok: true; readonly webhook: WebhookView } | Failure<'NOT_FOUND'>;

const WEBHOOK_COLUMNS = {
  id: services.id,
  sourceType: services.sourceType,
  webhookHookId: services.webhookHookId,
  webhookSecretCredentialId: services.webhookSecretCredentialId,
};

interface WebhookRow {
  readonly webhookHookId: string | null;
  readonly webhookSecretCredentialId: string | null;
}

function scopedService(projectId: string, serviceId: string) {
  return and(eq(services.id, serviceId), eq(services.projectId, projectId));
}

/** A hook id whose secret was removed (SET NULL) fails closed and counts as disabled. */
function isEnabled(row: WebhookRow): row is { webhookHookId: string; webhookSecretCredentialId: string } {
  return row.webhookHookId !== null && row.webhookSecretCredentialId !== null;
}

function viewOf(row: WebhookRow, publicOrigin: string): WebhookView {
  return isEnabled(row)
    ? { enabled: true, payloadUrl: webhookPayloadUrl(publicOrigin, row.webhookHookId) }
    : { enabled: false, payloadUrl: null };
}

function notFound(serviceId: string): Failure<'NOT_FOUND'> {
  return { ok: false, code: 'NOT_FOUND', message: `Service "${serviceId}" not found` };
}

const SOURCE_NOT_GIT: Failure<'WEBHOOK_SOURCE_NOT_GIT'> = Object.freeze({
  ok: false,
  code: 'WEBHOOK_SOURCE_NOT_GIT',
  message: 'A push webhook needs a service built from a Git repository',
});

const ALREADY_ENABLED: Failure<'WEBHOOK_ALREADY_ENABLED'> = Object.freeze({
  ok: false,
  code: 'WEBHOOK_ALREADY_ENABLED',
  message: 'The webhook is already enabled; rotate the secret to get a new one',
});

const NOT_ENABLED: Failure<'WEBHOOK_NOT_ENABLED'> = Object.freeze({
  ok: false,
  code: 'WEBHOOK_NOT_ENABLED',
  message: 'The webhook is not enabled',
});

const HOOK_ID_CONFLICT: Failure<'WEBHOOK_HOOK_ID_CONFLICT'> = Object.freeze({
  ok: false,
  code: 'WEBHOOK_HOOK_ID_CONFLICT',
  message: 'Could not allocate a unique webhook URL; try again',
});

/** drizzle wraps the `pg` error; `.code`/`.constraint` live on `cause` (see service-services.ts). */
function isHookIdCollision(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' && cause.constraint === HOOK_ID_UNIQUE_INDEX;
}

/** Thrown inside the enable transaction to roll back the credential row when no id was free. */
class HookIdExhaustedError extends Error {
  constructor() {
    super('webhook-config: no free hook id');
    this.name = 'HookIdExhaustedError';
  }
}

/**
 * Points the service at a fresh hook id and the new credential. Each attempt runs in a savepoint,
 * so a unique violation on the hook-id index aborts only that attempt and the next one draws a new
 * id. Any other error propagates unchanged.
 */
async function claimHookId(tx: Transaction, serviceId: string, credentialId: string, random: RandomBytes): Promise<string> {
  for (let attempt = 0; attempt < WEBHOOK_HOOK_ID_ATTEMPTS; attempt += 1) {
    const hookId = generateHookId(random);
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint
          .update(services)
          .set({ webhookHookId: hookId, webhookSecretCredentialId: credentialId })
          .where(eq(services.id, serviceId));
      });
      return hookId;
    } catch (error) {
      if (!isHookIdCollision(error)) throw error;
    }
  }
  throw new HookIdExhaustedError();
}

export async function getWebhookConfig(
  deps: Pick<WebhookConfigDeps, 'db' | 'publicOrigin'>,
  projectId: string,
  serviceId: string,
): Promise<WebhookView | null> {
  const [row] = await deps.db.select(WEBHOOK_COLUMNS).from(services).where(scopedService(projectId, serviceId)).limit(1);
  return row ? viewOf(row, deps.publicOrigin) : null;
}

async function lockService(tx: Transaction, target: WebhookTarget) {
  const [row] = await tx.select(WEBHOOK_COLUMNS).from(services).where(scopedService(target.projectId, target.serviceId)).for('update');
  return row;
}

async function insertSecret(tx: Transaction, deps: WebhookConfigDeps, secret: SecretValue, now: Date): Promise<string> {
  const keys = await deps.masterKeys();
  const version = await currentKeyVersion(tx);
  const [row] = await tx
    .insert(credentials)
    .values({
      type: 'webhook_secret',
      encryptedValue: encryptSecret(revealSecret(secret), { key: keys.current, version }),
      keyVersion: version,
      publicKey: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: credentials.id });
  if (!row) throw new Error('webhook-config: credential insert returned no row');
  return row.id;
}

async function deleteSecret(tx: Transaction, id: string | null): Promise<void> {
  if (id !== null) await tx.delete(credentials).where(eq(credentials.id, id));
}

/** Metadata names the change only; the hook id, the secret and the URL never travel in it. */
async function recordChange(
  tx: Transaction,
  target: WebhookTarget,
  serviceId: string,
  changedField: 'webhook' | 'webhookSecret',
  credentialReplaced: boolean,
  now: Date,
): Promise<void> {
  await writeActivityEvent(
    tx,
    {
      actorType: target.actor.type,
      actorId: target.actor.type === 'user' ? target.actor.id : null,
      entityType: 'service',
      entityId: serviceId,
      action: 'service.updated',
      outcome: 'success',
      metadata: { changedFields: [changedField], requiresRedeploy: false, credentialReplaced },
    },
    now,
  );
}

/**
 * Enables the webhook of a Git service. A second enable is a named 409 and never rotates the
 * secret behind the user's back (H2). A hook id left without a secret is replaced. A hook id that
 * collides on the unique index is redrawn; if every attempt collides the whole enable rolls back
 * and answers the typed WEBHOOK_HOOK_ID_CONFLICT (409), never a 500 (18-05 H9).
 */
export async function enableWebhook(deps: WebhookConfigDeps, target: WebhookTarget): Promise<WebhookSecretResult> {
  const random = deps.randomBytes ?? cryptoRandomBytes;
  try {
    return await deps.db.transaction(async (tx): Promise<WebhookSecretResult> => {
      const service = await lockService(tx, target);
      if (!service) return notFound(target.serviceId);
      if (service.sourceType !== 'git') return SOURCE_NOT_GIT;
      if (isEnabled(service)) return ALREADY_ENABLED;

      const now = deps.now();
      const secret = generateWebhookSecret(random);
      const credentialId = await insertSecret(tx, deps, secret, now);
      const hookId = await claimHookId(tx, service.id, credentialId, random);
      await deleteSecret(tx, service.webhookSecretCredentialId);
      await recordChange(tx, target, service.id, 'webhook', false, now);
      return { ok: true, webhook: { enabled: true, payloadUrl: webhookPayloadUrl(deps.publicOrigin, hookId), secret } };
    });
  } catch (error) {
    if (error instanceof HookIdExhaustedError) return HOOK_ID_CONFLICT;
    throw error;
  }
}

/**
 * Replaces the secret and keeps the hook id (the URL configured on GitHub stays valid). The new
 * row is inserted, the service repointed and the old row deleted in one transaction, so a
 * delivery resolved by `resolveWebhookSecret` (one statement) sees exactly one of the two (H1).
 */
export async function rotateWebhookSecret(deps: WebhookConfigDeps, target: WebhookTarget): Promise<WebhookSecretResult> {
  const random = deps.randomBytes ?? cryptoRandomBytes;
  return deps.db.transaction(async (tx): Promise<WebhookSecretResult> => {
    const service = await lockService(tx, target);
    if (!service) return notFound(target.serviceId);
    if (service.sourceType !== 'git') return SOURCE_NOT_GIT;
    if (!isEnabled(service)) return NOT_ENABLED;

    const now = deps.now();
    const secret = generateWebhookSecret(random);
    const credentialId = await insertSecret(tx, deps, secret, now);
    await tx.update(services).set({ webhookSecretCredentialId: credentialId }).where(eq(services.id, service.id));
    await deleteSecret(tx, service.webhookSecretCredentialId);
    await recordChange(tx, target, service.id, 'webhookSecret', true, now);
    return {
      ok: true,
      webhook: { enabled: true, payloadUrl: webhookPayloadUrl(deps.publicOrigin, service.webhookHookId), secret },
    };
  });
}

/** Clears the hook id and deletes the secret row. Disabling a disabled webhook is a no-op. */
export async function disableWebhook(
  deps: Pick<WebhookConfigDeps, 'db' | 'now'>,
  target: WebhookTarget,
): Promise<WebhookDisableResult> {
  return deps.db.transaction(async (tx): Promise<WebhookDisableResult> => {
    const service = await lockService(tx, target);
    if (!service) return notFound(target.serviceId);
    const disabled: WebhookView = { enabled: false, payloadUrl: null };
    if (service.webhookHookId === null && service.webhookSecretCredentialId === null) return { ok: true, webhook: disabled };

    const now = deps.now();
    await tx.update(services).set({ webhookHookId: null, webhookSecretCredentialId: null }).where(eq(services.id, service.id));
    await deleteSecret(tx, service.webhookSecretCredentialId);
    await recordChange(tx, target, service.id, 'webhook', service.webhookSecretCredentialId !== null, now);
    return { ok: true, webhook: disabled };
  });
}

export interface ResolvedWebhook {
  readonly serviceId: string;
  readonly secret: SecretValue;
}

/**
 * The secret a delivery to `hookId` is verified against, or `null` for a malformed, unknown or
 * disabled hook id (all the same to a caller, H2). One statement joins the service to its secret
 * row, so it reads a single snapshot: during a rotation it sees the old pair or the new one,
 * never neither and never both (H1). Throws `CredentialDecryptError` for a corrupt row.
 */
export async function resolveWebhookSecret(
  deps: Pick<WebhookConfigDeps, 'db' | 'masterKeys'>,
  hookId: string,
): Promise<ResolvedWebhook | null> {
  if (!HOOK_ID_PATTERN.test(hookId)) return null;
  const [row] = await deps.db
    .select({ serviceId: services.id, encryptedValue: credentials.encryptedValue, keyVersion: credentials.keyVersion })
    .from(services)
    .innerJoin(credentials, eq(credentials.id, services.webhookSecretCredentialId))
    .where(and(eq(services.webhookHookId, hookId), eq(credentials.type, 'webhook_secret')))
    .limit(1);
  if (!row) return null;
  const plaintext = decryptCredentialEnvelope(row, await deps.masterKeys());
  return { serviceId: row.serviceId, secret: secretValue(plaintext, 'api_key') };
}
