import type { ServerStatus } from '@noodara/domain/server';
import type { DiscoveryCheckStatus } from '@noodara/domain/discovery';

// The four semantic status colours a component may ever use (skill SS2.1) -- never a raw
// ServerStatus/DiscoveryCheckStatus string, so a component's styling can never drift from this
// one mapping.
export type Tone = 'ok' | 'warn' | 'error' | 'idle';

// `satisfies Record<ServerStatus, Tone>` makes a new ServerStatus added to packages/domain a
// compile error here, not a silent gap -- tone.test.ts additionally proves every mapped value at
// runtime by iterating the domain package's own SERVER_STATUSES tuple.
const SERVER_STATUS_TONE = {
  PENDING: 'idle',
  CONNECTING: 'warn',
  CONNECTED: 'ok',
  DISCONNECTED: 'idle',
  UNREACHABLE: 'error',
  ERROR: 'error',
} as const satisfies Record<ServerStatus, Tone>;

export function serverStatusTone(status: ServerStatus): Tone {
  return SERVER_STATUS_TONE[status];
}

const DISCOVERY_CHECK_TONE = {
  pass: 'ok',
  fail: 'error',
  skipped: 'idle',
  not_applicable: 'idle',
} as const satisfies Record<DiscoveryCheckStatus, Tone>;

export function discoveryCheckTone(status: DiscoveryCheckStatus): Tone {
  return DISCOVERY_CHECK_TONE[status];
}

const SERVER_STATUS_WORDS = {
  PENDING: 'Pending',
  CONNECTING: 'Connecting',
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  UNREACHABLE: 'Unreachable',
  ERROR: 'Error',
} as const satisfies Record<ServerStatus, string>;

const TONE_WORDS = {
  ok: 'OK',
  warn: 'Warning',
  error: 'Error',
  idle: 'Idle',
} as const satisfies Record<Tone, string>;

// Visible word for every ServerStatus and every Tone -- the reason "state is never colour-only"
// is true rather than aspirational (05-UI-SPEC.md SS8). StatusPill (Task 3) reads the
// ServerStatus half; a later discovery-check component reads the Tone half for its own severity
// labels (05-UI-SPEC.md SS4.2's Pass/Warning/Fail/Pending/Running words are a superset built on
// top of this table, not implemented by this plan).
export const STATUS_WORDS = {
  ...SERVER_STATUS_WORDS,
  ...TONE_WORDS,
} as const;
