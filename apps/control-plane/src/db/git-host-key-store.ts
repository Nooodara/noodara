// 14-07: the per-service TOFU store of a non-bundled Git host's SSH host keys (services columns
// git_host_key_host + git_host_key). Every stored line is re-validated on read; the first pin is
// a conditional write under the row lock, so concurrent first clones store exactly one key and
// the loser verifies against it. A pinned key for the same host is never replaced here: only the
// operator CLI (services/service-services.ts resetGitHostKey) forgets it.
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  gitSshEndpoint,
  knownHostsContent,
  parseGitHostKeyLine,
  sameKnownHostsHost,
  validateRepositoryUrl,
  type GitHostKey,
} from '@noodara/domain/validators';
import type { GitHostKeyPinResult, GitHostKeyStore, PinnedGitHostKeys } from '../deploy/run-deployment.js';
import type { Database } from './client.js';
import { services } from './schema/services.js';

export interface GitHostKeyColumns {
  readonly gitHostKeyHost: string | null;
  readonly gitHostKey: string | null;
}

export const CLEARED_GIT_HOST_KEY_COLUMNS: GitHostKeyColumns = Object.freeze({ gitHostKeyHost: null, gitHostKey: null });

/** The known_hosts host a repository URL pins, or null (https, or not a valid URL). */
export function knownHostsHostOfUrl(repositoryUrl: string | null): string | null {
  if (repositoryUrl === null) return null;
  const url = validateRepositoryUrl(repositoryUrl);
  if (!url.ok) return null;
  return gitSshEndpoint(url.value)?.knownHostsHost ?? null;
}

/** Stored columns -> pinned keys. Lines that do not re-validate for the stored host are dropped,
 *  so a tampered row pins nothing usable and the next scan fails verification (fail closed). */
export function pinnedFromColumns(columns: GitHostKeyColumns): PinnedGitHostKeys | null {
  if (columns.gitHostKeyHost === null || columns.gitHostKey === null) return null;
  const host = columns.gitHostKeyHost;
  const keys: GitHostKey[] = [];
  for (const line of columns.gitHostKey.split('\n')) {
    if (line === '') continue;
    const parsed = parseGitHostKeyLine(line);
    if (parsed.ok && sameKnownHostsHost(parsed.value.host, host)) keys.push(parsed.value);
  }
  return { host, keys };
}

/** Pinned keys -> stored columns, built only from re-validated key parts. */
export function columnsFromPinned(pinned: PinnedGitHostKeys): GitHostKeyColumns {
  const content = knownHostsContent(pinned.keys.filter((key) => sameKnownHostsHost(key.host, pinned.host)));
  if (content === '') throw new TypeError('A pin needs at least one key for its host');
  return { gitHostKeyHost: pinned.host, gitHostKey: content };
}

/**
 * H2: the columns a service edit must also write. A new repository URL whose SSH host differs
 * from the pinned one (or that is https) clears the pin, so a stale key neither blocks the new
 * host nor is reused for it; the same host keeps its pin.
 */
export function gitHostKeyColumnsForUrlChange(
  current: GitHostKeyColumns,
  nextRepositoryUrl: string | null,
): GitHostKeyColumns | Record<string, never> {
  if (current.gitHostKeyHost === null) return {};
  const next = knownHostsHostOfUrl(nextRepositoryUrl);
  return next !== null && sameKnownHostsHost(next, current.gitHostKeyHost) ? {} : CLEARED_GIT_HOST_KEY_COLUMNS;
}

export function createGitHostKeyStore(db: Database): GitHostKeyStore {
  return {
    async load(serviceId) {
      const [row] = await db
        .select({ gitHostKeyHost: services.gitHostKeyHost, gitHostKey: services.gitHostKey })
        .from(services)
        .where(eq(services.id, serviceId))
        .limit(1);
      return row === undefined ? null : pinnedFromColumns(row);
    },

    async pin(serviceId, pinned): Promise<GitHostKeyPinResult> {
      const columns = columnsFromPinned(pinned);
      return db.transaction(async (tx): Promise<GitHostKeyPinResult> => {
        const [row] = await tx
          .select({
            repositoryUrl: services.repositoryUrl,
            gitHostKeyHost: services.gitHostKeyHost,
            gitHostKey: services.gitHostKey,
          })
          .from(services)
          .where(eq(services.id, serviceId))
          .for('update');
        if (row === undefined) return { kind: 'missing' };
        // The service was re-pointed mid-deploy: this attempt's host is no longer its host.
        const current = knownHostsHostOfUrl(row.repositoryUrl);
        if (current === null || !sameKnownHostsHost(current, pinned.host)) return { kind: 'missing' };
        const existing = pinnedFromColumns(row);
        if (existing !== null && sameKnownHostsHost(existing.host, pinned.host)) {
          return { kind: 'existing', pinned: existing };
        }
        // Conditional even under the lock: only an empty pin or one for another host is written.
        const [stored] = await tx
          .update(services)
          .set(columns)
          .where(
            and(
              eq(services.id, serviceId),
              or(isNull(services.gitHostKey), sql`${services.gitHostKeyHost} IS DISTINCT FROM ${pinned.host}`),
            ),
          )
          .returning({ id: services.id });
        return stored === undefined ? { kind: 'missing' } : { kind: 'stored' };
      });
    },
  };
}
