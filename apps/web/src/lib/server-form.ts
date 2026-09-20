// 05-17-PLAN.md Task 1: the pure form-state to request-body builder for the add/edit server
// sheet. `apps/web` never imports a control-plane-internal module into the browser bundle
// (api-client.ts's own documented rule) -- `WireCredential`/`CreateServerBody`/`UpdateServerBody`
// below are hand-typed to match `apps/control-plane/src/routes/server-schemas.ts`'s
// `WireCredentialSchema`/`CreateServerBodySchema`/`UpdateServerBodySchema` exactly (both
// `.strict()`), not imported from there. `validateSshPort` is reused from `@noodara/domain` so the
// client-side port range check agrees with the server's own rule rather than a second,
// independent copy of it (05-17-PLAN.md's own read_first note).
//
// Every request body is assembled by explicit key assignment with conditional spreads -- never a
// spread of the whole form-state object -- so an unselected credential branch or a blank optional
// field can never leak into a `.strict()` schema's rejection.
import { validateSshPort } from '@noodara/domain/validators';

export interface PrivateKeyCredentialFormValue {
  readonly type: 'ssh_private_key';
  readonly privateKey: string;
  readonly passphrase: string;
}

export interface PasswordCredentialFormValue {
  readonly type: 'ssh_password';
  readonly password: string;
}

export type CredentialFormValue = PrivateKeyCredentialFormValue | PasswordCredentialFormValue;

export function emptyPrivateKeyCredential(): PrivateKeyCredentialFormValue {
  return { type: 'ssh_private_key', privateKey: '', passphrase: '' };
}

export function emptyPasswordCredential(): PasswordCredentialFormValue {
  return { type: 'ssh_password', password: '' };
}

export interface ServerFormState {
  readonly name: string;
  readonly host: string;
  /** Raw input text, never a number -- '' means "blank", the placeholder-shown-not-value case
   *  05-UI-SPEC.md SS2.4 requires for both port and user. */
  readonly sshPort: string;
  readonly sshUser: string;
  readonly credential: CredentialFormValue;
}

// Private key selected by default (D-04) -- every blank field, matching a freshly opened create
// sheet.
export function emptyServerFormState(): ServerFormState {
  return { name: '', host: '', sshPort: '', sshUser: '', credential: emptyPrivateKeyCredential() };
}

export interface WireCredentialPrivateKey {
  readonly type: 'ssh_private_key';
  readonly privateKey: string;
  readonly passphrase?: string;
}

export interface WireCredentialPassword {
  readonly type: 'ssh_password';
  readonly password: string;
}

export type WireCredential = WireCredentialPrivateKey | WireCredentialPassword;

export interface CreateServerBody {
  readonly name: string;
  readonly host: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly credential: WireCredential;
}

export interface UpdateServerBody {
  readonly name?: string;
  readonly host?: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly credential?: WireCredential;
}

/** The one place a `CredentialFormValue` becomes a `WireCredential` -- a blank passphrase is
 *  omitted rather than sent as an empty string (`WireCredentialSchema`'s `passphrase` is
 *  `.min(1).optional()`, so an empty string would be a validation failure, not a "no passphrase"
 *  signal). */
function buildCredentialWire(credential: CredentialFormValue): WireCredential {
  if (credential.type === 'ssh_password') {
    return { type: 'ssh_password', password: credential.password };
  }

  const trimmedPassphrase = credential.passphrase.trim();
  return trimmedPassphrase === ''
    ? { type: 'ssh_private_key', privateKey: credential.privateKey }
    : { type: 'ssh_private_key', privateKey: credential.privateKey, passphrase: credential.passphrase };
}

/** `POST /api/servers`'s body -- `CreateServerBodySchema` is `.strict()`, so `sshPort`/`sshUser`
 *  are omitted entirely when their field is blank rather than sent as a default (22/root) or an
 *  empty string. */
export function buildCreateBody(current: ServerFormState): CreateServerBody {
  const trimmedPort = current.sshPort.trim();
  const trimmedUser = current.sshUser.trim();

  return {
    name: current.name,
    host: current.host,
    ...(trimmedPort === '' ? {} : { sshPort: Number(trimmedPort) }),
    ...(trimmedUser === '' ? {} : { sshUser: trimmedUser }),
    credential: buildCredentialWire(current.credential),
  };
}

/** `PATCH /api/servers/:id`'s body -- includes only the fields whose value differs from `initial`
 *  (the values the sheet opened with), and includes `credential` only when `credentialReplaced` is
 *  true (the user activated "Replace" and provided a new value) -- never because the in-memory
 *  credential form state happens to differ from some prior render, since a credential is never
 *  read back from the server to compare against in the first place. */
export function buildUpdateBody(
  current: ServerFormState,
  initial: ServerFormState,
  credentialReplaced: boolean,
): UpdateServerBody {
  const trimmedPort = current.sshPort.trim();
  const portChanged = current.sshPort !== initial.sshPort && trimmedPort !== '';

  return {
    ...(current.name !== initial.name ? { name: current.name } : {}),
    ...(current.host !== initial.host ? { host: current.host } : {}),
    ...(portChanged ? { sshPort: Number(trimmedPort) } : {}),
    ...(current.sshUser !== initial.sshUser ? { sshUser: current.sshUser } : {}),
    ...(credentialReplaced ? { credential: buildCredentialWire(current.credential) } : {}),
  };
}

export interface ServerFormErrors {
  readonly name?: string;
  readonly host?: string;
  readonly sshPort?: string;
  readonly sshUser?: string;
  readonly credential?: string;
}

/** Client-side pre-check only -- flags exactly the four things a blank/malformed field can tell
 *  you without a round trip (blank name, blank host, an out-of-range port, a missing credential
 *  value). Never blocks submission for anything only the server can judge (name/host uniqueness,
 *  whether a credential actually parses) -- those surface as `NAME_TAKEN`/`HOST_TAKEN`/
 *  `INVALID_CREDENTIAL` from a real API response instead. The port range check reuses
 *  `@noodara/domain`'s own `validateSshPort` so this rule can never silently drift from the
 *  server's. */
export function validateServerForm(current: ServerFormState): ServerFormErrors {
  const errors: { name?: string; host?: string; sshPort?: string; credential?: string } = {};

  if (current.name.trim() === '') {
    errors.name = 'Name is required.';
  }
  if (current.host.trim() === '') {
    errors.host = 'Host is required.';
  }

  const trimmedPort = current.sshPort.trim();
  if (trimmedPort !== '') {
    const parsedPort = Number(trimmedPort);
    const portOk = Number.isInteger(parsedPort) && validateSshPort(parsedPort).ok;
    if (!portOk) {
      errors.sshPort = 'Port must be between 1 and 65535.';
    }
  }

  const hasCredentialValue =
    current.credential.type === 'ssh_password'
      ? current.credential.password.trim() !== ''
      : current.credential.privateKey.trim() !== '';
  if (!hasCredentialValue) {
    errors.credential = 'A credential is required.';
  }

  return errors;
}
