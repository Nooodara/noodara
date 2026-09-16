// The deliberate public surface of `@noodara/ssh` (T-2-42). Every adapter internal — the
// per-command timeout wrapper, the TOFU host verifier, the private-key loader, the ssh2 error
// classifier, the per-target connection mutex, the allowlist's quoting helper and template map,
// and everything under this package's own test-fixture directory — stays unreachable through this
// package's single `.` entrypoint. A phase-3 service reaching past `SshPort`/`runDiscovery` into
// any of that is exactly the coupling this file exists to prevent. `run-discovery.test.ts`'s own
// export-name test asserts this list stays exact, so an accidental addition or removal fails the
// suite.
export type {
  ConnectInput,
  ConnectOutcome,
  ExecResult,
  HostFingerprint,
  SshCredential,
  SshPort,
  SshSession,
  SshTarget,
  SshTimeouts,
} from './ssh-port.js';
// `commandFor` is also part of this surface (beyond the plan's own named list): plan 02-04's
// standing integration suite (tests/integration/ssh/contracts.test.ts, predating this plan) reads
// it from `@noodara/ssh` directly to drive raw ssh2 exec calls against the real allowlist
// templates for its ADR-0004 measurements — the package's single `.` export entry (packages/
// ssh/package.json) makes this the only path that file can reach it through. Everything else in
// ./commands (`escapeShellArg`, `COMMAND_TEMPLATES`, and the per-concern template objects) has no
// consumer outside `packages/ssh` and stays unexported.
export { COMMAND_NAMES, commandFor } from './commands/index.js';
export type { CommandName } from './commands/index.js';
export { createSsh2Adapter } from './ssh2-adapter.js';
export { runDiscovery } from './run-discovery.js';
export type { RunDiscoveryInput, RunDiscoveryTimeouts } from './run-discovery.js';
export { formatFingerprint, parseFingerprint } from './fingerprint.js';
export { RETRYABLE_ERROR_CODES } from './retry.js';
// Additive phase-3 amendment (D-15, plan 03-01): apps/control-plane's registerServer/editServer
// must validate a private-key credential with the same ACCEPTED_KEY_TYPES/RSA_MIN_MODULUS_BITS
// rules the adapter enforces, never duplicating them locally (T-3-10/T-3-15). No existing export
// changes shape and key-loader.ts's own behaviour is untouched.
export { InvalidCredentialError, loadPrivateKey } from './key-loader.js';
export type { LoadPrivateKeyResult, PrivateKeyCredential } from './key-loader.js';
