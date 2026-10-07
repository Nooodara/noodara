// 14-07 A3/H4: `noodara services reset-host-key <serviceId>` forgets the SSH host key pinned for a
// service's Git host, so the next deploy trusts the host's key on first use again. The argument is
// validated before any database access; an unknown id names nothing else about the database.
import { validateResourceId } from '@noodara/domain/validators';
import type { ResetGitHostKeyResult } from '../services/service-services.js';

export interface ServicesResetHostKeyDeps {
  readonly serviceId: string;
  /** The database operation (resetGitHostKey bound to a handle, in production). */
  readonly reset: (serviceId: string) => Promise<ResetGitHostKeyResult>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const RESET_HOST_KEY_EXIT = Object.freeze({ ok: 0, notFound: 1, invalidArgument: 2 });

/** Returns the process exit code; `cli/index.ts` sets it. */
export async function servicesResetHostKeyCommand(deps: ServicesResetHostKeyDeps): Promise<number> {
  const id = validateResourceId(deps.serviceId.trim());
  if (!id.ok) {
    deps.err('noodara: INVALID_SERVICE_ID: the service id must be a UUID.');
    return RESET_HOST_KEY_EXIT.invalidArgument;
  }
  const result = await deps.reset(id.value);
  switch (result) {
    case 'not_found':
      deps.err('noodara: SERVICE_NOT_FOUND: no service has this id.');
      return RESET_HOST_KEY_EXIT.notFound;
    case 'not_pinned':
      deps.out('No SSH host key is pinned for this service; nothing to reset.');
      return RESET_HOST_KEY_EXIT.ok;
    case 'cleared':
      deps.out(
        "Forgot the pinned SSH host key. The next deploy trusts the Git host's current key on first use; verify its fingerprint first.",
      );
      return RESET_HOST_KEY_EXIT.ok;
  }
}
