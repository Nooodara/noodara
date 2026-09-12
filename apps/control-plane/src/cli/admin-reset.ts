// D-03: `noodara admin reset` — issues a single-use `recovery`-purpose token with the exact same
// mechanics as the setup token (Plan 01-12's shared `setup_tokens` table/model), so a locked-out
// admin can regain access without email and without a second token system.
import { revealSecret } from '@noodara/domain/security';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { adminExists } from '../services/setup-service.js';
import { issueToken } from '../services/setup-token-repository.js';

export interface AdminResetLogger {
  error(msg: string): void;
}

export interface AdminResetDeps {
  readonly db: ActivityWriteHandle;
  readonly logger: AdminResetLogger;
  readonly now?: Date;
}

/**
 * Returns the intended process exit code (0 success, 1 no-admin-yet) rather than calling
 * `process.exit` itself — `cli/index.ts` is the single place that decides the real exit code.
 */
export async function adminResetCommand(deps: AdminResetDeps): Promise<number> {
  const hasAdmin = await adminExists(deps.db);
  if (!hasAdmin) {
    deps.logger.error(
      'No admin exists yet — use the setup token printed at boot (`docker compose logs api`) instead of `admin reset`.',
    );
    return 1;
  }

  const issued = await issueToken(deps.db, 'recovery', deps.now ?? new Date());
  // Deliberately bypasses pino, same contract as the boot-time setup token (bootstrap-admin.ts):
  // this is the one value that must reach the operator unredacted.
  process.stdout.write(`NOODARA_RECOVERY_TOKEN=${revealSecret(issued.token)}\n`);
  return 0;
}
