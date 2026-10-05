// 12-11b: the real `connect` port of the deploy job.
// - SEC: a deploy never trusts a host key on first use. Only a server whose fingerprint was
//   captured by a connect (and is stored in `host_fingerprint`) is connected to, and the adapter
//   rejects any other key (HOST_KEY_CHANGED). Without one the deploy ends SERVER_UNREACHABLE.
// - ERR: every failure is a closed code; no driver, SSH or decrypt message leaves this module.
// - The session is connected with the run's Redactor, so the server credential is masked in the
//   deployment log too.
import { eq } from 'drizzle-orm';
import type { Redactor } from '@noodara/domain/security';
import { parseFingerprint, type HostFingerprint, type SshDeploySession, type SshPort, type SshTimeouts } from '@noodara/ssh';
import type { Database } from '../db/client.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import { decodeCredential } from '../services/credential-store.js';
import type { MasterKeys } from '../services/server-service-deps.js';
import type { ConnectResult } from './deploy-worker.js';

export interface DeployServerRow {
  readonly host: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly hostFingerprint: string | null;
  /** From discovery; null when discovery never ran. */
  readonly dockerInstalled: boolean | null;
  readonly credential: { readonly type: string; readonly encryptedValue: string; readonly keyVersion: number };
}

export interface DeployConnectDeps {
  readonly loadServer: (serverId: string) => Promise<DeployServerRow | null>;
  readonly ssh: SshPort<SshDeploySession>;
  readonly timeouts: SshTimeouts;
  readonly masterKeys: () => Promise<MasterKeys>;
}

const UNREACHABLE: ConnectResult = Object.freeze({ ok: false, code: 'SERVER_UNREACHABLE' });
const NO_DOCKER: ConnectResult = Object.freeze({ ok: false, code: 'DOCKER_UNAVAILABLE' });

function trustedFingerprint(stored: string | null): HostFingerprint | null {
  if (stored === null) return null;
  try {
    return parseFingerprint(stored);
  } catch {
    return null;
  }
}

export function createDeployConnect(
  deps: DeployConnectDeps,
): (serverId: string, redactor: Redactor, signal: AbortSignal | undefined) => Promise<ConnectResult> {
  return async (serverId, redactor) => {
    const row = await deps.loadServer(serverId);
    if (row === null) return UNREACHABLE;
    if (row.dockerInstalled === false) return NO_DOCKER;
    const fingerprint = trustedFingerprint(row.hostFingerprint);
    if (fingerprint === null) return UNREACHABLE;

    const { credential: stored } = row;
    if (stored.type !== 'ssh_private_key' && stored.type !== 'ssh_password') return UNREACHABLE;
    let credential;
    try {
      credential = decodeCredential({ ...stored, type: stored.type }, await deps.masterKeys());
    } catch {
      // A decrypt error can quote the envelope; it is dropped.
      return UNREACHABLE;
    }

    const outcome = await deps.ssh.connect({
      target: { host: row.host, port: row.sshPort, user: row.sshUser },
      credential,
      timeouts: deps.timeouts,
      trustedFingerprint: fingerprint,
      redactor,
    });
    if (!outcome.ok) return UNREACHABLE;
    const { session } = outcome;
    return { ok: true, session, close: () => session.close() };
  };
}

/** The `loadServer` port over the database. */
export function loadDeployServerFromDb(db: Database): (serverId: string) => Promise<DeployServerRow | null> {
  return async (serverId) => {
    const [row] = await db
      .select({
        host: servers.host,
        sshPort: servers.sshPort,
        sshUser: servers.sshUser,
        hostFingerprint: servers.hostFingerprint,
        dockerInstalled: servers.dockerInstalled,
        type: credentials.type,
        encryptedValue: credentials.encryptedValue,
        keyVersion: credentials.keyVersion,
      })
      .from(servers)
      .innerJoin(credentials, eq(credentials.id, servers.credentialId))
      .where(eq(servers.id, serverId))
      .limit(1);
    if (row === undefined) return null;
    const { type, encryptedValue, keyVersion, ...server } = row;
    return { ...server, credential: { type, encryptedValue, keyVersion } };
  };
}
