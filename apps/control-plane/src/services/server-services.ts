// D-01/D-17: the one factory phase 4's routes and worker import to reach every server service —
// a thin closure binding `deps` to each service function, no logic and no DI container of its
// own. Re-exports every service's input/result types so phase 4 has a single import site instead
// of reaching into five separate service modules.
import {
  connectAndDiscover,
  type ConnectAndDiscoverInput,
  type ConnectAndDiscoverResult,
} from './connect-and-discover.js';
import { deleteServer, type DeleteServerInput, type DeleteServerResult } from './delete-server.js';
import { editServer, type EditServerInput, type EditServerResult } from './edit-server.js';
import {
  registerServer,
  type RegisterServerInput,
  type RegisterServerResult,
} from './register-server.js';
import type { ServerServicesDeps } from './server-service-deps.js';
import {
  trustFingerprint,
  type TrustFingerprintInput,
  type TrustFingerprintResult,
} from './trust-fingerprint.js';

export type {
  ConnectAndDiscoverInput,
  ConnectAndDiscoverResult,
  DeleteServerInput,
  DeleteServerResult,
  EditServerInput,
  EditServerResult,
  RegisterServerInput,
  RegisterServerResult,
  TrustFingerprintInput,
  TrustFingerprintResult,
};

export interface ServerServices {
  registerServer(input: RegisterServerInput): Promise<RegisterServerResult>;
  editServer(input: EditServerInput): Promise<EditServerResult>;
  deleteServer(input: DeleteServerInput): Promise<DeleteServerResult>;
  connectAndDiscover(input: ConnectAndDiscoverInput): Promise<ConnectAndDiscoverResult>;
  trustFingerprint(input: TrustFingerprintInput): Promise<TrustFingerprintResult>;
}

/**
 * D-01: binds `deps` once and returns the five server services as plain input-only functions —
 * every later caller (phase 4's routes, the connect-server worker) takes a `ServerServices`
 * instance instead of threading `deps` through each call site itself.
 */
export function createServerServices(deps: ServerServicesDeps): ServerServices {
  return {
    registerServer: (input) => registerServer(deps, input),
    editServer: (input) => editServer(deps, input),
    deleteServer: (input) => deleteServer(deps, input),
    connectAndDiscover: (input) => connectAndDiscover(deps, input),
    trustFingerprint: (input) => trustFingerprint(deps, input),
  };
}
