// D-01/D-04: the first-boot admin bootstrap. Exactly one of three things happens on every boot,
// decided in this order — an existing admin makes NOODARA_ADMIN_* a no-op (warned, D-04); no
// admin plus both pre-seed variables present creates the admin directly and skips the setup
// token entirely (D-04); no admin and no pre-seed variables issues (or re-prints) a setup token
// (D-01). Must run to completion before Fastify starts listening (wired in server.ts) — a boot
// that cannot establish an admin path must never start serving.
import { createHmac } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  hashSetupToken,
  isTokenUsable,
  revealSecret,
  secretValue,
  SETUP_TOKEN_TTL_SECONDS,
  type SecretValue,
} from '@noodara/domain/security';
import { validateEmail, validatePassword } from '@noodara/domain/validators';
import { runInBootstrap } from '../auth/bootstrap-context.js';
import { writeActivityEvent, type ActivityWriteHandle } from '../activity/write-activity-event.js';
import { setupTokens } from '../db/schema/setup-tokens.js';
import type { Env } from '../env.js';
import { adminExists } from '../services/setup-service.js';
import { markUsed } from '../services/setup-token-repository.js';

export interface BootstrapAdminLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Narrow structural shape of the Better Auth `auth` singleton this module needs — deliberately
 * not `typeof auth` (auth.ts's real generic type), so this module stays independently unit-
 * testable against a fake, mirroring setup-service.ts's own precedent for `signUpEmail`.
 */
export interface BootstrapAdminAuth {
  api: {
    signUpEmail(input: {
      body: { name: string; email: string; password: string };
    }): Promise<{ user: { id: string } }>;
  };
}

export type BootstrapAdminEnv = Pick<
  Env,
  'NOODARA_ADMIN_EMAIL' | 'NOODARA_ADMIN_PASSWORD' | 'BETTER_AUTH_SECRET'
>;

export interface BootstrapAdminDeps {
  readonly db: ActivityWriteHandle;
  readonly auth: BootstrapAdminAuth;
  readonly logger: BootstrapAdminLogger;
  readonly env: BootstrapAdminEnv;
  readonly now?: Date;
}

/** Raised when a pre-seeded `NOODARA_ADMIN_PASSWORD`/`NOODARA_ADMIN_EMAIL` fails the domain
 *  policy — the boot must abort with a non-zero exit and no user created (server.ts). */
export class AdminPreseedPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminPreseedPolicyError';
  }
}

/**
 * Deterministically derives the printable setup-token value from the token row's own id and the
 * app's stable `BETTER_AUTH_SECRET`. This is what makes D-01's "cada arranque vuelve a
 * imprimirlo" possible without ever persisting anything beyond the row's SHA-256 hash: the same
 * row id plus the same secret always yields the same raw value, so a later boot can reprint it
 * exactly by recomputing it — never by reading it back from storage.
 */
export function deriveSetupTokenValue(rowId: string, secret: string): SecretValue {
  const raw = createHmac('sha256', secret).update(rowId).digest('base64url');
  return secretValue(raw, 'setup_token');
}

/**
 * Writes the setup token directly to stdout, deliberately bypassing pino: this is the one value
 * that must reach the operator unredacted, and this fixed `NOODARA_SETUP_TOKEN=<value>` shape is
 * the contract phase 6's installer reads from `docker compose logs api`.
 */
function printSetupToken(token: SecretValue): void {
  process.stdout.write(`NOODARA_SETUP_TOKEN=${revealSecret(token)}\n`);
}

/**
 * Finds the currently active (unused) `setup`-purpose token row, if any. The table's own
 * `setup_tokens_active_purpose_idx` partial unique index (Plan 01-07) guarantees at most one such
 * row exists per purpose at a time, so this can never return more than one candidate.
 */
async function findActiveSetupTokenRow(
  db: ActivityWriteHandle,
): Promise<typeof setupTokens.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(setupTokens)
    .where(and(eq(setupTokens.purpose, 'setup'), isNull(setupTokens.usedAt)));
  return row;
}

/**
 * Issues a fresh setup-token row with a client-generated id (so `deriveSetupTokenValue` can
 * compute the printable value before the insert), or reprints the existing one if it is still
 * usable. An existing-but-expired row is marked used — not because it was redeemed, but to free
 * the partial-unique-index slot for the fresh row — and is left in the table for audit (D-01).
 */
async function issueOrReprintSetupToken(
  db: ActivityWriteHandle,
  secret: string,
  now: Date,
): Promise<SecretValue> {
  const activeRow = await findActiveSetupTokenRow(db);

  if (activeRow) {
    const usability = isTokenUsable(activeRow, now);
    if (usability.usable) {
      return deriveSetupTokenValue(activeRow.id, secret);
    }
    await markUsed(db, activeRow.id, now);
  }

  const id = uuidv7();
  const token = deriveSetupTokenValue(id, secret);
  const tokenHash = hashSetupToken(revealSecret(token));
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_SECONDS * 1000);
  await db.insert(setupTokens).values({ id, tokenHash, purpose: 'setup', expiresAt });
  return token;
}

/**
 * D-04: creates the admin directly from `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` and skips
 * the setup token entirely. `env.ts` already enforces the all-or-nothing pair invariant, so this
 * is only ever called once both are known to be present. A policy failure throws before Better
 * Auth's sign-up is ever called, so no user is created.
 */
async function preseedAdmin(deps: BootstrapAdminDeps, now: Date): Promise<void> {
  const emailResult = validateEmail(deps.env.NOODARA_ADMIN_EMAIL ?? '');
  if (!emailResult.ok) {
    throw new AdminPreseedPolicyError(emailResult.message);
  }

  const passwordResult = validatePassword(deps.env.NOODARA_ADMIN_PASSWORD ?? '', {
    email: emailResult.value,
  });
  if (!passwordResult.ok) {
    throw new AdminPreseedPolicyError(passwordResult.message);
  }

  const signUpResult = await runInBootstrap(() =>
    deps.auth.api.signUpEmail({
      body: { name: 'Admin', email: emailResult.value, password: passwordResult.value },
    }),
  );

  await deps.db.transaction(async (tx) => {
    await writeActivityEvent(
      tx,
      {
        actorType: 'system',
        actorId: null,
        entityType: 'user',
        entityId: signUpResult.user.id,
        action: 'auth.admin_preseeded',
        outcome: 'success',
        metadata: { email: emailResult.value },
      },
      now,
    );
  });
}

/** D-04: an admin already exists and pre-seed variables are set — ignored, with one warning
 *  naming both variables so the operator knows why they had no effect. */
function warnPreseedIgnored(logger: BootstrapAdminLogger): void {
  logger.warn(
    { ignoredVariables: ['NOODARA_ADMIN_EMAIL', 'NOODARA_ADMIN_PASSWORD'] },
    'An admin already exists; NOODARA_ADMIN_EMAIL and NOODARA_ADMIN_PASSWORD are ignored (D-04)',
  );
}

function hasPreseedVariables(env: BootstrapAdminEnv): boolean {
  const hasEmail = (env.NOODARA_ADMIN_EMAIL ?? '').length > 0;
  const hasPassword = (env.NOODARA_ADMIN_PASSWORD ?? '').length > 0;
  // env.ts already rejects exactly one of the two being set (D-04), so this module can rely on
  // the pair being all-or-nothing rather than re-checking it.
  return hasEmail && hasPassword;
}

/**
 * The full D-01/D-04 boot decision. Resolves before `server.ts` ever calls `app.listen`.
 */
export async function bootstrapAdmin(deps: BootstrapAdminDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const hasAdmin = await adminExists(deps.db);
  const hasPreseed = hasPreseedVariables(deps.env);

  if (hasAdmin) {
    if (hasPreseed) {
      warnPreseedIgnored(deps.logger);
    }
    return;
  }

  if (hasPreseed) {
    await preseedAdmin(deps, now);
    return;
  }

  const token = await issueOrReprintSetupToken(deps.db, deps.env.BETTER_AUTH_SECRET, now);
  printSetupToken(token);
}
