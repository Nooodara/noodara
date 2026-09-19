import { describe, expect, it } from 'vitest';
import { SERVER_STATUSES, type ServerStatus } from '@noodara/domain/server';
import { DISCOVERY_CHECK_STATUSES, type DiscoveryCheckStatus } from '@noodara/domain/discovery';
import { discoveryCheckTone, serverStatusTone, STATUS_WORDS, type Tone } from './tone.js';

// Iterates the domain package's own frozen status tuples rather than a locally declared array,
// so a seventh `ServerStatus`/`DiscoveryCheckStatus` added in packages/domain fails this suite
// instead of silently going unmapped (05-22-PLAN.md Task 1 behaviour).

const EXPECTED_SERVER_STATUS_TONE: Record<ServerStatus, Tone> = {
  CONNECTED: 'ok',
  CONNECTING: 'warn',
  ERROR: 'error',
  UNREACHABLE: 'error',
  PENDING: 'idle',
  DISCONNECTED: 'idle',
};

const EXPECTED_DISCOVERY_CHECK_TONE: Record<DiscoveryCheckStatus, Tone> = {
  pass: 'ok',
  fail: 'error',
  skipped: 'idle',
  not_applicable: 'idle',
};

describe('serverStatusTone', () => {
  it.each(SERVER_STATUSES)('maps %s to its expected tone', (status) => {
    expect(serverStatusTone(status)).toBe(EXPECTED_SERVER_STATUS_TONE[status]);
  });
});

describe('discoveryCheckTone', () => {
  it.each(DISCOVERY_CHECK_STATUSES)('maps %s to its expected tone', (status) => {
    expect(discoveryCheckTone(status)).toBe(EXPECTED_DISCOVERY_CHECK_TONE[status]);
  });
});

describe('STATUS_WORDS', () => {
  it.each(SERVER_STATUSES)('has a non-empty word for the %s server status', (status) => {
    expect(STATUS_WORDS[status]).toBeTruthy();
  });

  it.each(['ok', 'warn', 'error', 'idle'] as const)('has a non-empty word for the %s tone', (tone) => {
    expect(STATUS_WORDS[tone]).toBeTruthy();
  });
});
