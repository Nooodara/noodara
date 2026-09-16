// Pure edit classification (SERV-02, D-14 of phase 1). Tells the caller which reason-gated
// transition an edit implies; it never performs the transition itself. The mapping to
// `transition()`:
//   'identity' -> transition(current, 'PENDING', { reason: 'identity_changed' })
//   'access'   -> transition(current, 'DISCONNECTED', { reason: 'clean_close' })
//   'none'     -> no transition
// The caller only performs a transition when the server was `CONNECTED` at edit time — editing a
// server that is PENDING/CONNECTING/DISCONNECTED/UNREACHABLE/ERROR never triggers either edge,
// since both reason-gated edges in server-state.ts originate from CONNECTED.

/** Fields that define a server's identity: changing either means "this is a different server". */
export interface ServerIdentityFields {
  readonly host: string;
  readonly sshPort: number;
}

/** Fields that define who/what can access the server, distinct from its identity. */
export interface ServerAccessFields {
  readonly sshUser: string;
  readonly credentialReplaced: boolean;
}

export type EditClassification = 'none' | 'identity' | 'access';

/**
 * Classifies a server edit purely from before/after fields. `name` is deliberately not part of
 * either input interface: renaming a server is neither an identity nor an access change.
 * Identity wins over access when both change in the same edit.
 */
export function classifyServerEdit(
  before: ServerIdentityFields & ServerAccessFields,
  after: ServerIdentityFields & ServerAccessFields,
): EditClassification {
  if (before.host !== after.host || before.sshPort !== after.sshPort) {
    return 'identity';
  }

  if (before.sshUser !== after.sshUser || after.credentialReplaced) {
    return 'access';
  }

  return 'none';
}
