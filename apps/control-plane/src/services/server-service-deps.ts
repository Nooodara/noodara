// D-17: `ServiceActor` and the injected-dependency contract every service in this directory
// shares. Declared once here so no later plan (registerServer/editServer/deleteServer/
// connectAndDiscover/trustFingerprint) invents its own actor type or dependency plumbing.
// `resolveServerServicesDeps` resolves every default from `env`/the process singletons, then lets
// `overrides` win field-by-field (Claude's Discretion on dependency injection, RESEARCH Pattern 3)
// — this is how unit tests inject a fake `SshPort`, a fixed clock and a fake `db`, without ever
// opening a real connection pool.
import { createSsh2Adapter, type SshPort, type SshTimeouts } from '@noodara/ssh';
import type { Redactor } from '@noodara/domain/security';
import { appRedactor } from '../activity/redaction.js';
import { decodeMasterKey } from '../boot/master-key.js';
import { getDb, type Database } from '../db/client.js';
import { env } from '../env.js';

/**
 * Every application service's caller identity — a specific admin user, or the system itself
 * (e.g. a background worker, a canary test). Declared once (D-17) and shared, never redeclared
 * per service.
 */
export type ServiceActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };

/**
 * The master key(s) available for encrypt/decrypt (`credential-store.ts`'s D-11 rotation window).
 * `previous` is genuinely optional under `exactOptionalPropertyTypes` — omitted entirely when
 * `NOODARA_MASTER_KEY_PREVIOUS` is unset, never set to `undefined`.
 */
export interface MasterKeys {
  readonly current: Buffer;
  readonly previous?: Buffer;
}

export interface ServerServicesDeps {
  readonly db: Database;
  readonly ssh: SshPort;
  readonly timeouts: SshTimeouts;
  readonly redactor: Redactor;
  readonly masterKeys: MasterKeys;
  readonly now: () => Date;
}

function defaultMasterKeys(): MasterKeys {
  const current = decodeMasterKey(env.NOODARA_MASTER_KEY);
  return env.NOODARA_MASTER_KEY_PREVIOUS === undefined
    ? { current }
    : { current, previous: decodeMasterKey(env.NOODARA_MASTER_KEY_PREVIOUS) };
}

/**
 * Resolves `ServerServicesDeps`, building each default lazily so a test supplying `overrides.db`
 * never triggers `getDb()` (and therefore never opens a real Postgres pool). Every field in
 * `overrides` wins over its env-derived default.
 */
export async function resolveServerServicesDeps(
  overrides: Partial<ServerServicesDeps> = {},
): Promise<ServerServicesDeps> {
  const db = overrides.db ?? (await getDb());
  const ssh = overrides.ssh ?? createSsh2Adapter();
  const timeouts: SshTimeouts = overrides.timeouts ?? {
    connectMs: env.NOODARA_SSH_CONNECT_TIMEOUT_MS,
    commandMs: env.NOODARA_SSH_COMMAND_TIMEOUT_MS,
    discoveryMs: env.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
  };
  const redactor = overrides.redactor ?? appRedactor;
  const masterKeys = overrides.masterKeys ?? defaultMasterKeys();
  const now = overrides.now ?? (() => new Date());

  return { db, ssh, timeouts, redactor, masterKeys, now };
}
