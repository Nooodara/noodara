// RemoteCommand: the only shape a deploy operation can take before it reaches a remote shell
// (SVC-08, T-11-34). The brand is a module-private unique symbol, so an object literal built
// anywhere else fails typecheck. `createRemoteCommand` is exported for the sibling builder modules
// in this directory only: commands/index.ts and packages/ssh/src/index.ts must never re-export it.
import { escapeShellArg } from './allowlist.js';
import type { DeployCommandName } from './deploy-allowlist.js';

declare const remoteCommandBrand: unique symbol;

/** `secret`: the caller writes a secret to the channel's stdin (ADR 0008 G1), never argv. */
export type RemoteCommandStdin = 'none' | 'secret';

export interface RemoteCommand {
  readonly [remoteCommandBrand]: true;
  readonly name: DeployCommandName;
  readonly argv: readonly [string, ...string[]];
  readonly stdin: RemoteCommandStdin;
  /** Long-running operations that may run under process.supervise (clone, build, pull). */
  readonly supervisable: boolean;
}

export interface RemoteCommandSpec {
  readonly name: DeployCommandName;
  readonly argv: readonly [string, ...string[]];
  readonly stdin: RemoteCommandStdin;
  readonly supervisable: boolean;
}

/** Internal to packages/ssh/src/commands. Copies and freezes argv. */
export function createRemoteCommand(spec: RemoteCommandSpec): RemoteCommand {
  const argv = Object.freeze([...spec.argv]);
  return Object.freeze({
    name: spec.name,
    argv,
    stdin: spec.stdin,
    supervisable: spec.supervisable,
  }) as RemoteCommand;
}

/** Every argv token through escapeShellArg, joined by one space. */
export function renderRemoteCommand(command: RemoteCommand): string {
  return command.argv.map(escapeShellArg).join(' ');
}
