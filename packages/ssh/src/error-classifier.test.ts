// Table-driven, exhaustive tests for the ssh2 -> ServerErrorCode classifier (SERV-07). Every row
// comes from docs/adr/0004-ssh-adapter-empirical-contracts.md's measured error-shape table — this
// file implements ADR 0004, it does not re-derive it. See tests/integration/ssh/contracts.test.ts
// for the standing integration assertions that produced these shapes against real fixtures.
import { createRedactor } from '@noodara/domain/security';
import { SERVER_ERROR_CODES, type ServerErrorCode } from '@noodara/domain/server';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CLASSIFICATION_RULES,
  classifySshError,
  type ClassifyContext,
} from './error-classifier.js';
import { CommandTimeoutError, TransportClosedError, UnsupportedOsError } from './errors.js';

/** Every field `ssh2` might attach to an `Error`, built the same way contracts.test.ts observed
 *  it (level/code/errno/syscall/fatal, all optional, message always present). */
interface Ssh2LikeErrorShape {
  readonly message?: string;
  readonly level?: string;
  readonly code?: string;
  readonly errno?: number;
  readonly syscall?: string;
  readonly fatal?: boolean;
}

/** The same fields as `Ssh2LikeErrorShape`, but mutable — only `ssh2Error`'s own construction
 *  needs to assign them; every other consumer receives the frozen `Ssh2LikeErrorShape` view. */
interface MutableSsh2LikeErrorShape {
  message?: string;
  level?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  fatal?: boolean;
}

function ssh2Error(shape: Ssh2LikeErrorShape): Error {
  const error = new Error(shape.message ?? '') as Error & MutableSsh2LikeErrorShape;
  if (shape.level !== undefined) error.level = shape.level;
  if (shape.code !== undefined) error.code = shape.code;
  if (shape.errno !== undefined) error.errno = shape.errno;
  if (shape.syscall !== undefined) error.syscall = shape.syscall;
  if (shape.fatal !== undefined) error.fatal = shape.fatal;
  return error;
}

interface ClassificationCase {
  readonly description: string;
  readonly phase: ClassifyContext['phase'];
  readonly buildError: () => unknown;
  readonly expectedCode: ServerErrorCode;
  readonly expectedRuleName: string;
}

// One case per row of ADR 0004's ssh2 error-shape table (SERV-07, A5), rows 1-7 (row 8 — mid-exec
// transport death — has its own dedicated tests below since it needs no `ssh2` Error at all).
const ADR_ROWS: readonly ClassificationCase[] = [
  {
    description: 'row 1: wrong password (pwuser)',
    phase: 'connect',
    buildError: () =>
      ssh2Error({
        level: 'client-authentication',
        message: 'All configured authentication methods failed',
      }),
    expectedCode: 'AUTH_FAILED',
    expectedRuleName: 'auth-failed',
  },
  {
    description: 'row 2: valid-but-unauthorized key (ed25519_unauthorized against deployer)',
    phase: 'connect',
    buildError: () =>
      ssh2Error({
        level: 'client-authentication',
        message: 'All configured authentication methods failed',
      }),
    expectedCode: 'AUTH_FAILED',
    expectedRuleName: 'auth-failed',
  },
  {
    description: 'row 3: correct key, wrong/nonexistent username',
    phase: 'connect',
    buildError: () =>
      ssh2Error({
        level: 'client-authentication',
        message: 'All configured authentication methods failed',
      }),
    expectedCode: 'AUTH_FAILED',
    expectedRuleName: 'auth-failed',
  },
  {
    description:
      'row 4: hostname under .invalid TLD stalls to the full readyTimeout instead of a fast ENOTFOUND (measured surprise)',
    phase: 'connect',
    buildError: () =>
      ssh2Error({ level: 'client-timeout', message: 'Timed out while waiting for handshake' }),
    expectedCode: 'CONNECT_TIMEOUT',
    expectedRuleName: 'connect-timeout',
  },
  {
    description: 'row 5: host/port of a stopped container (refused)',
    phase: 'connect',
    buildError: () => ssh2Error({ level: 'client-socket', code: 'ECONNREFUSED' }),
    expectedCode: 'CONNECT_TIMEOUT',
    expectedRuleName: 'connect-refused',
  },
  {
    description: 'row 6: blackhole listener (silent peer)',
    phase: 'connect',
    buildError: () =>
      ssh2Error({ level: 'client-timeout', message: 'Timed out while waiting for handshake' }),
    expectedCode: 'CONNECT_TIMEOUT',
    expectedRuleName: 'connect-timeout',
  },
  {
    description: 'row 7: pinned fingerprint mismatch (hostVerifier returns false)',
    phase: 'connect',
    buildError: () =>
      ssh2Error({
        level: 'handshake',
        message: 'Host denied (verification failed)',
        fatal: true,
      }),
    expectedCode: 'HOST_KEY_CHANGED',
    expectedRuleName: 'host-key-changed',
  },
];

// Cases beyond ADR 0004's live-measured rows, but required by this plan's own <behavior>: the
// fast-DNS-failure path A5 says must still exist even though row 4 didn't reach it on this
// resolver, a generic reset/closed socket, the command-timeout and unsupported-OS markers this
// classifier is the single place to recognise, and the documented terminal fallback.
const ADDITIONAL_CASES: readonly ClassificationCase[] = [
  {
    description: 'a fast ENOTFOUND (the structured-field path A5 requires even though row 4 did not reach it)',
    phase: 'connect',
    buildError: () => ssh2Error({ code: 'ENOTFOUND' }),
    expectedCode: 'HOST_UNRESOLVED',
    expectedRuleName: 'host-unresolved',
  },
  {
    description: 'a fast EAI_AGAIN',
    phase: 'connect',
    buildError: () => ssh2Error({ code: 'EAI_AGAIN' }),
    expectedCode: 'HOST_UNRESOLVED',
    expectedRuleName: 'host-unresolved',
  },
  {
    description: 'a reset socket (ECONNRESET) — a session existed, then was lost',
    phase: 'exec',
    buildError: () => ssh2Error({ level: 'client-socket', code: 'ECONNRESET' }),
    expectedCode: 'CONNECTION_LOST',
    expectedRuleName: 'socket-reset',
  },
  {
    description: 'a broken pipe (EPIPE) mid-command',
    phase: 'exec',
    buildError: () => ssh2Error({ code: 'EPIPE' }),
    expectedCode: 'CONNECTION_LOST',
    expectedRuleName: 'socket-reset',
  },
  {
    description: "exec-with-timeout's own CommandTimeoutError",
    phase: 'exec',
    buildError: () => new CommandTimeoutError('discovery.disk', 30_000),
    expectedCode: 'COMMAND_TIMEOUT',
    expectedRuleName: 'command-timeout',
  },
  {
    description: "discovery's own UnsupportedOsError marker (D-11)",
    phase: 'connect',
    buildError: () => new UnsupportedOsError('CentOS 8'),
    expectedCode: 'UNSUPPORTED_OS',
    expectedRuleName: 'unsupported-os',
  },
];

function findMatchingRule(error: unknown, context: ClassifyContext) {
  return ERROR_CLASSIFICATION_RULES.find((rule) => {
    try {
      return rule.matches(error, context);
    } catch {
      return false;
    }
  });
}

describe('classifySshError — ADR 0004 rows 1-7 (table-driven)', () => {
  it.each(ADR_ROWS)('$description -> $expectedCode via the "$expectedRuleName" rule', (row) => {
    const redactor = createRedactor();
    const context: ClassifyContext = { phase: row.phase, redactor };
    const error = row.buildError();

    const matchedRule = findMatchingRule(error, context);
    expect(matchedRule?.name).toBe(row.expectedRuleName);

    const result = classifySshError(error, context);
    expect(result.errorCode).toBe(row.expectedCode);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('classifySshError — additional required shapes (ENOTFOUND/EAI_AGAIN, reset socket, command timeout, unsupported OS)', () => {
  it.each(ADDITIONAL_CASES)('$description -> $expectedCode via the "$expectedRuleName" rule', (row) => {
    const redactor = createRedactor();
    const context: ClassifyContext = { phase: row.phase, redactor };
    const error = row.buildError();

    const matchedRule = findMatchingRule(error, context);
    expect(matchedRule?.name).toBe(row.expectedRuleName);

    const result = classifySshError(error, context);
    expect(result.errorCode).toBe(row.expectedCode);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('classifySshError — ADR row 8: mid-exec transport death (no error event ever fires)', () => {
  // Measured identical for both Ubuntu 22.04 and 24.04 (ADR 0004) — the synthetic marker this
  // classifier recognises carries no OS-specific field, so one case covers both variants; a
  // second case is still asserted here to document that the shape is OS-independent by design.
  it.each(['22.04', '24.04'] as const)(
    'a TransportClosedError (Ubuntu %s) matches a named rule, not the terminal fallback, and yields CONNECTION_LOST',
    () => {
      const redactor = createRedactor();
      const context: ClassifyContext = { phase: 'exec', redactor };
      const error = new TransportClosedError('discovery.disk');

      const matchedRule = findMatchingRule(error, context);
      expect(matchedRule?.name).toBe('mid-exec-transport-death');
      expect(matchedRule?.name).not.toBe('unclassified-fallback');

      const result = classifySshError(error, context);
      expect(result.errorCode).toBe('CONNECTION_LOST');
    },
  );
});

describe('classifySshError — documented terminal fallback', () => {
  it('an error object with no recognised field and an arbitrary message classifies to CONNECTION_LOST via the documented fallback, not by accident', () => {
    const redactor = createRedactor();
    const context: ClassifyContext = { phase: 'connect', redactor };
    const error = ssh2Error({ message: 'something ssh2 has never produced in this codebase' });

    const matchedRule = findMatchingRule(error, context);
    expect(matchedRule?.name).toBe('unclassified-fallback');

    const result = classifySshError(error, context);
    expect(result.errorCode).toBe('CONNECTION_LOST');
  });
});

describe('classifySshError — hostile inputs never throw', () => {
  const throwingMessageGetter: unknown = Object.defineProperty(
    { level: 'does-not-exist' },
    'message',
    {
      get(): string {
        throw new Error('message getter should never be read unguarded');
      },
      enumerable: true,
    },
  );

  const HOSTILE_INPUTS: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'a plain string', value: 'a string' },
    { label: 'an empty object', value: {} },
    { label: 'an object whose message getter throws', value: throwingMessageGetter },
  ];

  it.each(HOSTILE_INPUTS)('does not throw for $label, and yields CONNECTION_LOST', ({ value }) => {
    const redactor = createRedactor();
    const context: ClassifyContext = { phase: 'connect', redactor };

    expect(() => classifySshError(value, context)).not.toThrow();
    const result = classifySshError(value, context);
    expect(result.errorCode).toBe('CONNECTION_LOST');
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('classifySshError — exhaustiveness over SERVER_ERROR_CODES', () => {
  it('every code in the union is produced by at least one rule, so no code can become dead', () => {
    for (const code of SERVER_ERROR_CODES) {
      const reachable = ERROR_CLASSIFICATION_RULES.some((rule) => rule.code === code);
      expect(reachable, `no rule in ERROR_CLASSIFICATION_RULES produces ${code}`).toBe(true);
    }
  });
});

describe('classifySshError — messages are actionable, project-authored, and redaction-invariant', () => {
  const REPRESENTATIVE_CASES: readonly ClassificationCase[] = [...ADR_ROWS, ...ADDITIONAL_CASES];

  it('every message is non-empty and unaffected by a redactor holding an unrelated registered credential', () => {
    const redactor = createRedactor();
    redactor.register('super-secret-registered-value', 'ssh_password');

    for (const row of REPRESENTATIVE_CASES) {
      const context: ClassifyContext = { phase: row.phase, redactor };
      const result = classifySshError(row.buildError(), context);

      expect(result.message.length).toBeGreaterThan(0);
      expect(redactor.redact(result.message)).toBe(result.message);
    }
  });

  it('registers the credential used in a raw ssh2 message and asserts the fallback message never leaks it', () => {
    const redactor = createRedactor();
    redactor.register('sk-thisIsALeakedCredential1234567890', 'token');
    const context: ClassifyContext = { phase: 'connect', redactor };
    const error = ssh2Error({
      message: 'unexpected failure while using token sk-thisIsALeakedCredential1234567890',
    });

    const result = classifySshError(error, context);

    expect(result.message).not.toContain('sk-thisIsALeakedCredential1234567890');
  });
});
