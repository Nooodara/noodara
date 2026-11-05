// 28-02: BYOK AI provider settings (one row per install).
// - PUT: key checks (H1) and model allowlist (A2) first, then one bounded validation call with the
//   key registered in the Redactor (A3). Only a valid key reaches the transaction, which stores the
//   encrypted key, points the settings row at it (the 0019 trigger deletes the previous key in the
//   same transaction, H1) and writes the activity event (A1).
// - DELETE: one transaction; the trigger removes the key with the row (A1).
// - Every write asserts the referenced credential is an ai_provider_key (H2).
// - No failure carries the key: messages are fixed and reasons are closed codes.
import {
  AI_PROVIDER_MODELS,
  AiProviderSettingsViewSchema,
  type AiProvider,
  type AiProviderSettingsView,
} from '@noodara/domain/api-contract';
import { revealSecret, type Redactor, type SecretValue } from '@noodara/domain/security';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { writeAiSettingsEvent } from '../../activity/ai-settings-events.js';
import type { Database } from '../../db/client.js';
import { aiProviderSettings } from '../../db/schema/v05-ai.js';
import {
  assertAiProviderKeyCredential,
  insertAiProviderKey,
  parseAiProviderKey,
  readAiProviderKey,
  type AiProviderKeyInvalidReason,
} from '../../secrets/ai-provider-key-store.js';
import type { SecretStoreHandle } from '../../secrets/secret-store.js';
import type { MasterKeys, ServiceActor } from '../../services/server-service-deps.js';
import type { KeyValidationFailureCode, ProviderKeyValidator } from './provider-key-validator.js';

export interface AiSettingsServiceDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly masterKeys: MasterKeys;
  readonly redactor: Redactor;
  readonly validateKey: ProviderKeyValidator;
}

export const AI_PROVIDER_INPUT_INVALID = 'AI_PROVIDER_INPUT_INVALID';
export const AI_PROVIDER_INPUT_INVALID_STATUS = 422;

export type AiSettingsInputReason = AiProviderKeyInvalidReason | 'model_not_allowed';

export type AiSettingsFailure =
  | {
      readonly ok: false;
      readonly code: typeof AI_PROVIDER_INPUT_INVALID;
      readonly message: string;
      readonly reason: AiSettingsInputReason;
    }
  | { readonly ok: false; readonly code: KeyValidationFailureCode | 'NOT_FOUND' | 'AI_PROVIDER_NOT_CONFIGURED'; readonly message: string };

export type AiSettingsResult = { readonly ok: true; readonly settings: AiProviderSettingsView } | AiSettingsFailure;

const INPUT_MESSAGES: Readonly<Record<AiSettingsInputReason, string>> = {
  too_short: 'The API key is too short.',
  too_long: 'The API key is too long.',
  invalid_characters: 'The API key may only contain printable characters without spaces.',
  model_not_allowed: 'This model is not available for the selected provider.',
};

const VALIDATION_MESSAGES: Readonly<Record<KeyValidationFailureCode, string>> = {
  AI_PROVIDER_AUTH_FAILED: 'The AI provider rejected the API key.',
  AI_PROVIDER_RATE_LIMITED: 'The AI provider is rate limiting requests. Wait a moment and try again.',
  AI_PROVIDER_UNAVAILABLE: 'The AI provider did not answer the validation request. Try again in a few minutes.',
};

/** Serializes every settings write (a fresh install has no row to lock FOR UPDATE). */
const SETTINGS_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('noodara.ai_provider_settings'))`;

function inputInvalid(reason: AiSettingsInputReason): AiSettingsFailure {
  return { ok: false, code: AI_PROVIDER_INPUT_INVALID, message: INPUT_MESSAGES[reason], reason };
}

export function isAllowedModel(provider: AiProvider, model: string): boolean {
  return (AI_PROVIDER_MODELS[provider] as readonly string[]).includes(model);
}

/** A3: the key is redacted for exactly the duration of `work`, then released. */
export async function withRegisteredKey<T>(redactor: Redactor, key: SecretValue, work: () => Promise<T>): Promise<T> {
  const raw = revealSecret(key, redactor);
  try {
    return await work();
  } finally {
    redactor.release(raw);
  }
}

type SettingsRow = typeof aiProviderSettings.$inferSelect;

function toView(row: SettingsRow): AiProviderSettingsView {
  return AiProviderSettingsViewSchema.parse({
    provider: row.provider,
    model: row.model,
    keyHint: row.keyHint,
    validatedAt: row.validatedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function lockedSettings(tx: SecretStoreHandle): Promise<SettingsRow | undefined> {
  await tx.execute(SETTINGS_LOCK);
  const [row] = await tx.select().from(aiProviderSettings).for('update');
  return row;
}

export interface SettingsRowInput {
  readonly provider: AiProvider;
  readonly model: string;
  readonly credentialId: string;
  readonly keyHint: string;
  readonly at: Date;
}

/**
 * Points the singleton settings row at `credentialId` (H2: only ever an ai_provider_key). When a
 * row exists its current credential is checked too, so the 0019 trigger can only delete an AI key.
 */
export async function writeSettingsRow(
  tx: SecretStoreHandle,
  existing: SettingsRow | undefined,
  input: SettingsRowInput,
): Promise<SettingsRow> {
  await assertAiProviderKeyCredential(tx, input.credentialId);
  const values = {
    provider: input.provider,
    model: input.model,
    credentialId: input.credentialId,
    keyHint: input.keyHint,
    validatedAt: input.at,
    updatedAt: input.at,
  };
  if (existing === undefined) {
    const [row] = await tx
      .insert(aiProviderSettings)
      .values({ id: uuidv7(), ...values, createdAt: input.at })
      .returning();
    if (row === undefined) throw new Error('ai provider settings insert returned no row');
    return row;
  }
  await assertAiProviderKeyCredential(tx, existing.credentialId);
  const [row] = await tx.update(aiProviderSettings).set(values).where(eq(aiProviderSettings.id, existing.id)).returning();
  if (row === undefined) throw new Error('ai provider settings update returned no row');
  return row;
}

export async function getAiProviderSettings(deps: Pick<AiSettingsServiceDeps, 'db'>): Promise<AiProviderSettingsView | null> {
  const [row] = await deps.db.select().from(aiProviderSettings).limit(1);
  return row === undefined ? null : toView(row);
}

export interface PutAiSettingsInput {
  readonly actor: ServiceActor;
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiKey: string;
}

export async function putAiProviderSettings(deps: AiSettingsServiceDeps, input: PutAiSettingsInput): Promise<AiSettingsResult> {
  const parsed = parseAiProviderKey(input.apiKey);
  if (!parsed.ok) return inputInvalid(parsed.reason);
  if (!isAllowedModel(input.provider, input.model)) return inputInvalid('model_not_allowed');
  const { key } = parsed;
  return withRegisteredKey(deps.redactor, key, async (): Promise<AiSettingsResult> => {
    const outcome = await deps.validateKey({ provider: input.provider, model: input.model, apiKey: key });
    if (!outcome.ok) return { ok: false, code: outcome.code, message: VALIDATION_MESSAGES[outcome.code] };
    const at = deps.now();
    const row = await deps.db.transaction(async (tx) => {
      const existing = await lockedSettings(tx);
      const stored = await insertAiProviderKey(tx, key, deps.masterKeys, at);
      const written = await writeSettingsRow(tx, existing, {
        provider: input.provider,
        model: input.model,
        credentialId: stored.credentialId,
        keyHint: stored.keyHint,
        at,
      });
      await writeAiSettingsEvent(
        tx,
        {
          actor: input.actor,
          action: existing === undefined ? 'ai_settings.configured' : 'ai_settings.replaced',
          settingsId: written.id,
          provider: written.provider,
          model: written.model,
        },
        at,
      );
      return written;
    });
    return { ok: true, settings: toView(row) };
  });
}

export async function deleteAiProviderSettings(
  deps: Pick<AiSettingsServiceDeps, 'db' | 'now'>,
  input: { readonly actor: ServiceActor },
): Promise<{ readonly ok: true } | AiSettingsFailure> {
  const at = deps.now();
  return deps.db.transaction(async (tx): Promise<{ readonly ok: true } | AiSettingsFailure> => {
    const existing = await lockedSettings(tx);
    if (existing === undefined) return { ok: false, code: 'NOT_FOUND', message: 'No AI provider is configured.' };
    await assertAiProviderKeyCredential(tx, existing.credentialId);
    await tx.delete(aiProviderSettings).where(eq(aiProviderSettings.id, existing.id));
    await writeAiSettingsEvent(
      tx,
      {
        actor: input.actor,
        action: 'ai_settings.deleted',
        settingsId: existing.id,
        provider: existing.provider,
        model: existing.model,
      },
      at,
    );
    return { ok: true };
  });
}

export interface StoredAiProvider {
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiKey: SecretValue;
}

/** For the agent (28-04): runs `work` with the decrypted key registered in the Redactor (A3). */
export async function withStoredAiProvider<T>(
  deps: Pick<AiSettingsServiceDeps, 'db' | 'masterKeys' | 'redactor'>,
  work: (provider: StoredAiProvider) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | AiSettingsFailure> {
  const [row] = await deps.db.select().from(aiProviderSettings).limit(1);
  if (row === undefined) {
    return { ok: false, code: 'AI_PROVIDER_NOT_CONFIGURED', message: 'No AI provider is configured.' };
  }
  const view = toView(row);
  const apiKey = await readAiProviderKey(deps.db, row.credentialId, deps.masterKeys);
  const value = await withRegisteredKey(deps.redactor, apiKey, () =>
    work({ provider: view.provider, model: view.model, apiKey }),
  );
  return { ok: true, value };
}
