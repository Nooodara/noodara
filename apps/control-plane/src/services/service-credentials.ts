// 12-09 (SVC-03, SVC-04): private source credentials of a service. A Git repository authenticates
// with an ed25519 deploy key Noodara generates (only the public half is ever returned) or with an
// HTTPS token; a private image with a registry username and password. Every value is write-only:
// it is validated here, encrypted with the master key into `credentials` (the same AES-256-GCM
// envelope as server credentials) and leaves this module only as a `SecretValue`. Reads expose
// presence, type and the deploy key's public half, nothing else.
//
// `services.*_credential_id` are RESTRICT, so a credential row is inserted before the service
// points at it and deleted only after the service stopped pointing at it, in one transaction.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { encryptSecret, revealSecret, secretValue, type EncryptionKey, type SecretValue } from '@noodara/domain/security';
import { validateRegistryHost, validateRegistryUsername } from '@noodara/domain/validators';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { Database } from '../db/client.js';
import { credentials } from '../db/schema/credentials.js';
import { services } from '../db/schema/services.js';
import { CredentialDecryptError, currentKeyVersion, decryptCredentialEnvelope } from './credential-store.js';
import type { MasterKeys, ServiceActor } from './server-service-deps.js';

export const HTTPS_TOKEN_MAX_LENGTH = 1024;
export const REGISTRY_PASSWORD_MAX_LENGTH = 4096;

export type RepositoryCredentialType = 'git_deploy_key' | 'git_https_token';
export type ServiceCredentialType = RepositoryCredentialType | 'registry_password';

// ---------------------------------------------------------------------------------------------
// Deploy key generation (node:crypto only)
// ---------------------------------------------------------------------------------------------

export interface GeneratedDeployKey {
  /** The OpenSSH `openssh-key-v1` private key, unencrypted (it is encrypted at rest instead). */
  readonly privateKey: SecretValue;
  /** `ssh-ed25519 <base64> <comment>`: shown to the user to install on the Git host. */
  readonly publicKey: string;
}

function lengthPrefixed(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function sshString(value: string): Buffer {
  return lengthPrefixed(Buffer.from(value, 'utf8'));
}

/** A fresh ed25519 pair from `node:crypto`, serialized per OpenSSH's PROTOCOL.key. */
export function generateDeployKey(comment: string): GeneratedDeployKey {
  const pair = generateKeyPairSync('ed25519');
  const pub = Buffer.from((pair.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const seed = Buffer.from((pair.privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url');

  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), lengthPrefixed(pub)]);
  const checkInt = randomBytes(4);
  const unpadded = Buffer.concat([
    checkInt,
    checkInt,
    sshString('ssh-ed25519'),
    lengthPrefixed(pub),
    lengthPrefixed(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const padLength = (8 - (unpadded.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: padLength }, (_, index) => index + 1));
  const container = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    lengthPrefixed(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    lengthPrefixed(publicBlob),
    lengthPrefixed(Buffer.concat([unpadded, padding])),
  ]);
  const body = container.toString('base64').replace(/.{1,70}/g, '$&\n');
  seed.fill(0);
  unpadded.fill(0);
  container.fill(0);
  return {
    privateKey: secretValue(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}-----END OPENSSH PRIVATE KEY-----\n`, 'ssh_private_key'),
    publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} ${comment}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Input validation (H3): messages are fixed and never quote the submitted value
// ---------------------------------------------------------------------------------------------

export interface CredentialInputFailure {
  readonly ok: false;
  readonly code: 'SERVICE_CREDENTIAL_INVALID';
  readonly reason: string;
  readonly message: string;
}

type Checked<T> = { readonly ok: true; readonly value: T } | CredentialInputFailure;

function invalid(reason: string, message: string): CredentialInputFailure {
  return { ok: false, code: 'SERVICE_CREDENTIAL_INVALID', reason, message };
}

const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function validateHttpsToken(token: string): Checked<SecretValue> {
  if (token.length === 0) return invalid('HTTPS_TOKEN_EMPTY', 'HTTPS token must not be empty');
  if (token.length > HTTPS_TOKEN_MAX_LENGTH) {
    return invalid('HTTPS_TOKEN_TOO_LONG', `HTTPS token must be at most ${HTTPS_TOKEN_MAX_LENGTH.toString()} characters`);
  }
  if (!PRINTABLE_NO_SPACE.test(token)) {
    return invalid('HTTPS_TOKEN_INVALID', 'HTTPS token must be printable ASCII without spaces');
  }
  return { ok: true, value: secretValue(token, 'api_key') };
}

const DOCKER_HUB = 'docker.io';
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

function normalizeRegistryHost(host: string): string {
  const lower = host.toLowerCase();
  return DOCKER_HUB_ALIASES.has(lower) ? DOCKER_HUB : lower;
}

/** The registry an already-validated image reference is pulled from, as Docker resolves it. */
export function registryHostOfImageRef(imageRef: string): string {
  const slash = imageRef.indexOf('/');
  if (slash === -1) return DOCKER_HUB;
  const first = imageRef.slice(0, slash);
  const isRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  return isRegistry ? normalizeRegistryHost(first) : DOCKER_HUB;
}

export interface RegistryCredentialInput {
  readonly host?: string | undefined;
  readonly username: string;
  readonly password: string;
}

export interface RegistryCredential {
  readonly host: string;
  readonly username: string;
  readonly password: SecretValue;
}

export function validateRegistryCredential(input: RegistryCredentialInput, imageRef: string): Checked<RegistryCredential> {
  const username = validateRegistryUsername(input.username);
  if (!username.ok) return invalid(username.code, username.message);

  const imageHost = registryHostOfImageRef(imageRef);
  let host = imageHost;
  if (input.host !== undefined) {
    const checked = validateRegistryHost(input.host);
    if (!checked.ok) return invalid(checked.code, checked.message);
    host = normalizeRegistryHost(checked.value);
    if (host !== imageHost) {
      return invalid('REGISTRY_HOST_MISMATCH', "Registry must be the one the service's image is pulled from");
    }
  }

  if (input.password.length === 0) return invalid('REGISTRY_PASSWORD_EMPTY', 'Registry password must not be empty');
  if (input.password.length > REGISTRY_PASSWORD_MAX_LENGTH) {
    return invalid(
      'REGISTRY_PASSWORD_TOO_LONG',
      `Registry password must be at most ${REGISTRY_PASSWORD_MAX_LENGTH.toString()} characters`,
    );
  }
  if (CONTROL_CHARACTER.test(input.password)) {
    return invalid('REGISTRY_PASSWORD_INVALID', 'Registry password must not contain control characters');
  }
  return { ok: true, value: { host, username: username.value, password: secretValue(input.password, 'api_key') } };
}

function isHttpsRepository(repositoryUrl: string): boolean {
  return repositoryUrl.startsWith('https://');
}

/** A deploy key authenticates ssh URLs (ssh:// and scp-like); a token authenticates https. */
export function repositoryCredentialFits(type: RepositoryCredentialType, repositoryUrl: string): boolean {
  return type === 'git_https_token' ? isHttpsRepository(repositoryUrl) : !isHttpsRepository(repositoryUrl);
}

// ---------------------------------------------------------------------------------------------
// Envelope encode / decode
// ---------------------------------------------------------------------------------------------

export type PlainServiceCredential =
  | ({ readonly kind: 'deploy_key' } & GeneratedDeployKey)
  | { readonly kind: 'https_token'; readonly token: SecretValue }
  | ({ readonly kind: 'registry' } & RegistryCredential);

export type DecodedServiceCredential =
  | { readonly kind: 'deploy_key'; readonly privateKey: SecretValue }
  | { readonly kind: 'https_token'; readonly token: SecretValue }
  | { readonly kind: 'registry'; readonly host: string; readonly username: string; readonly password: SecretValue };

export interface EncodedServiceCredential {
  readonly type: ServiceCredentialType;
  readonly encryptedValue: string;
  readonly keyVersion: number;
  readonly publicKey: string | null;
}

/** One envelope per write: `encryptSecret` draws a fresh 96-bit nonce every call (H1). */
export function encodeServiceCredential(plain: PlainServiceCredential, key: EncryptionKey): EncodedServiceCredential {
  const encrypt = (plaintext: string): string => encryptSecret(plaintext, key);
  switch (plain.kind) {
    case 'deploy_key':
      return {
        type: 'git_deploy_key',
        encryptedValue: encrypt(revealSecret(plain.privateKey)),
        keyVersion: key.version,
        publicKey: plain.publicKey,
      };
    case 'https_token':
      return { type: 'git_https_token', encryptedValue: encrypt(revealSecret(plain.token)), keyVersion: key.version, publicKey: null };
    case 'registry':
      return {
        type: 'registry_password',
        encryptedValue: encrypt(
          JSON.stringify({ host: plain.host, username: plain.username, password: revealSecret(plain.password) }),
        ),
        keyVersion: key.version,
        publicKey: null,
      };
  }
}

function parseRegistryPayload(plaintext: string): { host: string; username: string; password: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    // A JSON.parse message can quote the input; it is dropped, never chained.
    throw new CredentialDecryptError('CREDENTIAL_MALFORMED');
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record.host !== 'string' ||
    typeof record.username !== 'string' ||
    typeof record.password !== 'string'
  ) {
    throw new CredentialDecryptError('CREDENTIAL_MALFORMED');
  }
  return { host: record.host, username: record.username, password: record.password };
}

/** Decrypts a service credential row. Throws only `CredentialDecryptError` (H2). */
export function decodeServiceCredential(
  row: { readonly type: string; readonly encryptedValue: string; readonly keyVersion: number },
  masterKeys: MasterKeys,
): DecodedServiceCredential {
  if (row.type !== 'git_deploy_key' && row.type !== 'git_https_token' && row.type !== 'registry_password') {
    throw new CredentialDecryptError('CREDENTIAL_MALFORMED');
  }
  const plaintext = decryptCredentialEnvelope(row, masterKeys);
  switch (row.type) {
    case 'git_deploy_key':
      return { kind: 'deploy_key', privateKey: secretValue(plaintext, 'ssh_private_key') };
    case 'git_https_token':
      return { kind: 'https_token', token: secretValue(plaintext, 'api_key') };
    case 'registry_password': {
      const payload = parseRegistryPayload(plaintext);
      return {
        kind: 'registry',
        host: payload.host,
        username: payload.username,
        password: secretValue(payload.password, 'api_key'),
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Source changes (A3)
// ---------------------------------------------------------------------------------------------

export interface SourceShape {
  readonly sourceType: 'git' | 'image';
  readonly repositoryUrl: string | null;
  readonly imageRef: string | null;
}

export interface CredentialPlan {
  readonly repository: 'keep' | 'rotate' | 'remove';
  readonly registry: 'keep' | 'remove';
}

/**
 * What a source edit does to the stored credentials: a credential never follows the service to a
 * different repository or registry. A deploy key is rotated when the repository moves to another
 * ssh URL (the old public key stays installed only where it was); a token is removed.
 */
export function planCredentialsForSourceChange(
  current: SourceShape,
  next: SourceShape,
  repositoryType: RepositoryCredentialType | null,
  hasRegistry: boolean,
): CredentialPlan {
  let repository: CredentialPlan['repository'] = 'keep';
  if (repositoryType !== null && current.repositoryUrl !== next.repositoryUrl) {
    const fits = next.sourceType === 'git' && next.repositoryUrl !== null && repositoryCredentialFits(repositoryType, next.repositoryUrl);
    repository = repositoryType === 'git_deploy_key' && fits ? 'rotate' : 'remove';
  }
  let registry: CredentialPlan['registry'] = 'keep';
  if (hasRegistry && current.imageRef !== next.imageRef) {
    const sameRegistry =
      next.imageRef !== null &&
      current.imageRef !== null &&
      registryHostOfImageRef(next.imageRef) === registryHostOfImageRef(current.imageRef);
    registry = sameRegistry ? 'keep' : 'remove';
  }
  return { repository, registry };
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ServiceCredentialsDeps {
  readonly db: Database;
  readonly now: () => Date;
  /** Resolved on first use; tests and the app inject or derive it from the environment. */
  readonly masterKeys: () => Promise<MasterKeys>;
}

export interface ServiceCredentialSummary {
  readonly type: ServiceCredentialType;
  /** The deploy key's public half; `null` for every other type. */
  readonly publicKey: string | null;
}

export interface ServiceCredentialsView {
  readonly repository: ServiceCredentialSummary | null;
  readonly registry: ServiceCredentialSummary | null;
}

interface Failure<Code extends string> {
  readonly ok: false;
  readonly code: Code;
  readonly message: string;
}

export type ServiceCredentialsResult =
  | { readonly ok: true; readonly credentials: ServiceCredentialsView }
  | Failure<'NOT_FOUND' | 'CREDENTIAL_SOURCE_MISMATCH'>
  | CredentialInputFailure;

async function encryptionKey(tx: Transaction, deps: ServiceCredentialsDeps): Promise<EncryptionKey> {
  const keys = await deps.masterKeys();
  return { key: keys.current, version: await currentKeyVersion(tx) };
}

/** Inserts the envelope row and returns its id. */
export async function insertServiceCredential(tx: Transaction, encoded: EncodedServiceCredential, now: Date): Promise<string> {
  const [row] = await tx
    .insert(credentials)
    .values({ ...encoded, createdAt: now, updatedAt: now })
    .returning({ id: credentials.id });
  if (!row) throw new Error('insertServiceCredential: insert returned no row');
  return row.id;
}

/** Deletes credential rows no service points at any more (call after the service update). */
export async function deleteCredentialRows(tx: Transaction, ids: readonly (string | null)[]): Promise<void> {
  const present = ids.filter((id): id is string => id !== null);
  if (present.length > 0) await tx.delete(credentials).where(inArray(credentials.id, present));
}

function summaryOf(row: { type: string; publicKey: string | null } | undefined): ServiceCredentialSummary | null {
  if (!row) return null;
  const type = row.type as ServiceCredentialType;
  return { type, publicKey: type === 'git_deploy_key' ? row.publicKey : null };
}

async function viewFor(
  handle: Pick<Database, 'select'>,
  ids: { repositoryCredentialId: string | null; registryCredentialId: string | null },
): Promise<ServiceCredentialsView> {
  const wanted = [ids.repositoryCredentialId, ids.registryCredentialId].filter((id): id is string => id !== null);
  const rows =
    wanted.length === 0
      ? []
      : await handle
          .select({ id: credentials.id, type: credentials.type, publicKey: credentials.publicKey })
          .from(credentials)
          .where(inArray(credentials.id, wanted));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    repository: summaryOf(ids.repositoryCredentialId === null ? undefined : byId.get(ids.repositoryCredentialId)),
    registry: summaryOf(ids.registryCredentialId === null ? undefined : byId.get(ids.registryCredentialId)),
  };
}

function scopedService(projectId: string, serviceId: string) {
  return and(eq(services.id, serviceId), eq(services.projectId, projectId));
}

const SERVICE_CREDENTIAL_COLUMNS = {
  id: services.id,
  sourceType: services.sourceType,
  repositoryUrl: services.repositoryUrl,
  imageRef: services.imageRef,
  repositoryCredentialId: services.repositoryCredentialId,
  registryCredentialId: services.registryCredentialId,
};

export async function getServiceCredentials(
  deps: Pick<ServiceCredentialsDeps, 'db'>,
  projectId: string,
  serviceId: string,
): Promise<ServiceCredentialsView | null> {
  const [row] = await deps.db
    .select(SERVICE_CREDENTIAL_COLUMNS)
    .from(services)
    .where(scopedService(projectId, serviceId))
    .limit(1);
  return row ? viewFor(deps.db, row) : null;
}

export type RepositoryCredentialInput = { readonly kind: 'deploy_key' } | { readonly kind: 'https_token'; readonly token: string };

export interface ServiceCredentialTarget {
  readonly actor: ServiceActor;
  readonly projectId: string;
  readonly serviceId: string;
}

type Slot = 'repository' | 'registry';
type LockedService = Awaited<ReturnType<typeof lockService>>;

async function lockService(tx: Transaction, target: ServiceCredentialTarget) {
  const [row] = await tx
    .select(SERVICE_CREDENTIAL_COLUMNS)
    .from(services)
    .where(scopedService(target.projectId, target.serviceId))
    .for('update');
  return row;
}

function notFound(serviceId: string): Failure<'NOT_FOUND'> {
  return { ok: false, code: 'NOT_FOUND', message: `Service "${serviceId}" not found` };
}

function mismatch(message: string): Failure<'CREDENTIAL_SOURCE_MISMATCH'> {
  return { ok: false, code: 'CREDENTIAL_SOURCE_MISMATCH', message };
}

/** Points the slot at `nextId` (or nothing), deletes the previous row, records the change. */
async function replaceSlot(
  tx: Transaction,
  target: ServiceCredentialTarget,
  service: NonNullable<LockedService>,
  slot: Slot,
  nextId: string | null,
  now: Date,
): Promise<ServiceCredentialsResult> {
  const column = slot === 'repository' ? 'repositoryCredentialId' : 'registryCredentialId';
  const previousId = service[column];
  if (previousId === null && nextId === null) return { ok: true, credentials: await viewFor(tx, service) };

  await tx.update(services).set({ [column]: nextId }).where(eq(services.id, service.id));
  await deleteCredentialRows(tx, [previousId]);
  await writeActivityEvent(
    tx,
    {
      actorType: target.actor.type,
      actorId: target.actor.type === 'user' ? target.actor.id : null,
      entityType: 'service',
      entityId: service.id,
      action: 'service.updated',
      outcome: 'success',
      metadata: { changedFields: [`${slot}Credential`], requiresRedeploy: false, credentialReplaced: previousId !== null },
    },
    now,
  );
  return { ok: true, credentials: await viewFor(tx, { ...service, [column]: nextId }) };
}

export async function setRepositoryCredential(
  deps: ServiceCredentialsDeps,
  target: ServiceCredentialTarget & { readonly input: RepositoryCredentialInput },
): Promise<ServiceCredentialsResult> {
  let token: SecretValue | null = null;
  if (target.input.kind === 'https_token') {
    const checked = validateHttpsToken(target.input.token);
    if (!checked.ok) return checked;
    token = checked.value;
  }
  const type: RepositoryCredentialType = token === null ? 'git_deploy_key' : 'git_https_token';

  return deps.db.transaction(async (tx): Promise<ServiceCredentialsResult> => {
    const service = await lockService(tx, target);
    if (!service) return notFound(target.serviceId);
    if (service.sourceType !== 'git' || service.repositoryUrl === null) {
      return mismatch('A repository credential needs a service built from a Git repository');
    }
    if (!repositoryCredentialFits(type, service.repositoryUrl)) {
      return mismatch(
        type === 'git_deploy_key'
          ? 'A deploy key needs an ssh repository URL (ssh://user@host/path or user@host:path)'
          : 'An HTTPS token needs an https:// repository URL',
      );
    }
    const plain: PlainServiceCredential =
      token === null
        ? { kind: 'deploy_key', ...generateDeployKey(`noodara-service-${service.id}`) }
        : { kind: 'https_token', token };
    const now = deps.now();
    const id = await insertServiceCredential(tx, encodeServiceCredential(plain, await encryptionKey(tx, deps)), now);
    return replaceSlot(tx, target, service, 'repository', id, now);
  });
}

export async function setRegistryCredential(
  deps: ServiceCredentialsDeps,
  target: ServiceCredentialTarget & { readonly input: RegistryCredentialInput },
): Promise<ServiceCredentialsResult> {
  return deps.db.transaction(async (tx): Promise<ServiceCredentialsResult> => {
    const service = await lockService(tx, target);
    if (!service) return notFound(target.serviceId);
    if (service.sourceType !== 'image' || service.imageRef === null) {
      return mismatch('A registry credential needs a service deployed from an image');
    }
    const checked = validateRegistryCredential(target.input, service.imageRef);
    if (!checked.ok) return checked;
    const now = deps.now();
    const encoded = encodeServiceCredential({ kind: 'registry', ...checked.value }, await encryptionKey(tx, deps));
    const id = await insertServiceCredential(tx, encoded, now);
    return replaceSlot(tx, target, service, 'registry', id, now);
  });
}

export async function removeServiceCredential(
  deps: ServiceCredentialsDeps,
  target: ServiceCredentialTarget & { readonly slot: Slot },
): Promise<ServiceCredentialsResult> {
  return deps.db.transaction(async (tx): Promise<ServiceCredentialsResult> => {
    const service = await lockService(tx, target);
    if (!service) return notFound(target.serviceId);
    return replaceSlot(tx, target, service, target.slot, null, deps.now());
  });
}

/**
 * Applied by `updateService` inside its transaction, before the service row is updated: inserts a
 * rotated deploy key and returns the credential columns to set plus the rows to delete after.
 */
export async function credentialChangesForSource(
  tx: Transaction,
  deps: Pick<ServiceCredentialsDeps, 'masterKeys'>,
  current: SourceShape & {
    readonly id: string;
    readonly repositoryCredentialId: string | null;
    readonly registryCredentialId: string | null;
  },
  next: SourceShape,
  now: Date,
): Promise<{
  readonly columns: { repositoryCredentialId?: string | null; registryCredentialId?: string | null };
  readonly staleIds: readonly string[];
}> {
  let repositoryType: RepositoryCredentialType | null = null;
  if (current.repositoryCredentialId !== null) {
    const [row] = await tx
      .select({ type: credentials.type })
      .from(credentials)
      .where(eq(credentials.id, current.repositoryCredentialId));
    if (row?.type === 'git_deploy_key' || row?.type === 'git_https_token') repositoryType = row.type;
  }
  const plan = planCredentialsForSourceChange(current, next, repositoryType, current.registryCredentialId !== null);

  const columns: { repositoryCredentialId?: string | null; registryCredentialId?: string | null } = {};
  const staleIds: string[] = [];
  if (plan.repository !== 'keep' && current.repositoryCredentialId !== null) {
    staleIds.push(current.repositoryCredentialId);
    columns.repositoryCredentialId = null;
    if (plan.repository === 'rotate') {
      const keys = await deps.masterKeys();
      const key = { key: keys.current, version: await currentKeyVersion(tx) };
      const generated = generateDeployKey(`noodara-service-${current.id}`);
      columns.repositoryCredentialId = await insertServiceCredential(
        tx,
        encodeServiceCredential({ kind: 'deploy_key', ...generated }, key),
        now,
      );
    }
  }
  if (plan.registry === 'remove' && current.registryCredentialId !== null) {
    staleIds.push(current.registryCredentialId);
    columns.registryCredentialId = null;
  }
  return { columns, staleIds };
}

/** The default master keys, from the environment, imported lazily so a unit test importing this
 *  module never parses the process environment. */
export function masterKeysFromEnvironment(): () => Promise<MasterKeys> {
  let cached: Promise<MasterKeys> | undefined;
  return () =>
    (cached ??= Promise.all([import('../env.js'), import('../boot/master-key.js')]).then(([{ env }, { decodeMasterKey }]) => {
      const current = decodeMasterKey(env.NOODARA_MASTER_KEY);
      return env.NOODARA_MASTER_KEY_PREVIOUS === undefined
        ? { current }
        : { current, previous: decodeMasterKey(env.NOODARA_MASTER_KEY_PREVIOUS) };
    }));
}
