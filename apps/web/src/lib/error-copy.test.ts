import { describe, expect, it } from 'vitest';
import {
  copyForErrorCode,
  copyForServerErrorCode,
  fieldErrorsFromIssues,
  fieldForErrorCode,
  formatRetryAfterDuration,
  normalizeFieldPath,
} from './error-copy';

// 05-UI-SPEC.md SS5.4 -- every ServiceErrorCode's copy is asserted verbatim. Entries that carry a
// literal "{token}" placeholder (NAME_TAKEN, HOST_TAKEN, CONFIRMATION_MISMATCH) are returned
// unsubstituted -- the caller with the real value performs its own replacement, matching how
// CONFIRMATION_MISMATCH's own acceptance criterion is phrased ("asserted verbatim").
describe('copyForErrorCode', () => {
  it('returns the exact SS5.4 string for every ServiceErrorCode', () => {
    expect(copyForErrorCode('VALIDATION_FAILED')).toBe('Check the highlighted fields and try again.');
    expect(copyForErrorCode('INVALID_CREDENTIAL')).toBe(
      'This credential could not be parsed. Check the key format (or password) and try again.',
    );
    expect(copyForErrorCode('UNAUTHORIZED')).toBe('Your session ended. Sign in again.');
    expect(copyForErrorCode('FORBIDDEN_ORIGIN')).toBe(
      'Request blocked for security reasons. Reload the page and try again.',
    );
    expect(copyForErrorCode('NOT_FOUND')).toBe('This server no longer exists.');
    expect(copyForErrorCode('NAME_TAKEN')).toBe('A server named "{name}" already exists.');
    expect(copyForErrorCode('HOST_TAKEN')).toBe('A server at {host}:{port} is already registered.');
    expect(copyForErrorCode('SERVER_BUSY')).toBe(
      'This server has a connection or edit in progress. Try again in a moment.',
    );
    expect(copyForErrorCode('ALREADY_CONNECTING')).toBe('');
    expect(copyForErrorCode('SERVER_NOT_CONNECTED')).toBe('Connect the server before running discovery.');
    expect(copyForErrorCode('NO_PENDING_FINGERPRINT')).toBe("There's no fingerprint change to trust.");
    expect(copyForErrorCode('FINGERPRINT_MISMATCH')).toBe(
      'The observed fingerprint changed since you opened this dialog. Review the new value before trusting.',
    );
    expect(copyForErrorCode('SERVER_NOT_TRUSTABLE')).toBe(
      "There's nothing to trust in this server's current state.",
    );
    expect(copyForErrorCode('CONFIRMATION_MISMATCH')).toBe('That doesn\'t match. Type "{name}" exactly to continue.');
    expect(copyForErrorCode('QUEUE_UNAVAILABLE')).toBe(
      'The connection queue is temporarily unavailable. Try again in a few seconds.',
    );
    expect(copyForErrorCode('SSE_LIMIT_REACHED')).toBe('');
    expect(copyForErrorCode('INTERNAL_ERROR')).toBe(
      'Something went wrong on our end. Try again, and check the server logs if it continues.',
    );
  });

  it('the CONFIRMATION_MISMATCH copy matches SS5.4 verbatim', () => {
    expect(copyForErrorCode('CONFIRMATION_MISMATCH')).toBe('That doesn\'t match. Type "{name}" exactly to continue.');
  });

  // Gap 6 / T-5G-31-04: neither new code's copy carries a fingerprint value, a host, or a "{token}"
  // placeholder a caller would need to substitute -- both are banner/dialog-level, not per-value.
  it('FINGERPRINT_MISMATCH and SERVER_NOT_TRUSTABLE copy carries no interpolation placeholder or leaked value', () => {
    for (const code of ['FINGERPRINT_MISMATCH', 'SERVER_NOT_TRUSTABLE'] as const) {
      const copy = copyForErrorCode(code);
      expect(copy).not.toMatch(/\{.*\}/);
      expect(copy).not.toMatch(/SHA256:/);
      expect(copy.length).toBeGreaterThan(0);
    }
  });
});

describe('copyForServerErrorCode', () => {
  const context = { host: '203.0.113.10', sshPort: 2222 };

  it('returns the exact SS5.1 string for each of the seven ServerErrorCode values, interpolating host/sshPort', () => {
    expect(copyForServerErrorCode('AUTH_FAILED', context)).toBe(
      'Authentication failed. Check the SSH username and credential, then try again.',
    );
    expect(copyForServerErrorCode('HOST_UNRESOLVED', context)).toBe(
      'Could not resolve 203.0.113.10. Check the hostname or IP address and try again.',
    );
    expect(copyForServerErrorCode('CONNECT_TIMEOUT', context)).toBe(
      'Connection timed out. Check that port 2222 is open on 203.0.113.10.',
    );
    expect(copyForServerErrorCode('COMMAND_TIMEOUT', context)).toBe(
      'Discovery timed out while running a command. The server may be slow or unresponsive — try again.',
    );
    expect(copyForServerErrorCode('CONNECTION_LOST', context)).toBe(
      "The connection was lost while Noodara was working. Check the server's network and try again.",
    );
    expect(copyForServerErrorCode('UNSUPPORTED_OS', context)).toBe(
      'Outside the supported matrix (Ubuntu 22.04/24.04). Some features may not work as expected.',
    );
  });

  it('signals HOST_KEY_CHANGED explicitly rather than returning generic text', () => {
    expect(() => copyForServerErrorCode('HOST_KEY_CHANGED', context)).toThrow(/dedicated banner/);
  });
});

// Literal backend issue-path format below is empirically confirmed, not guessed: probing
// `@fastify/type-provider-zod`'s real `validatorCompiler` directly against
// `CreateServerBodySchema`/`SetupBodySchema` (apps/control-plane/src/routes/server-schemas.ts,
// setup.ts) produced AJV-shaped `instancePath` values -- a bare top-level field emits a single
// leading-slash segment ('/name', '/host', '/token'), the nested credential discriminated union
// emits a two-segment path ('/credential/privateKey', '/credential/passphrase',
// '/credential/type'), and even the bare object itself failing (e.g. missing entirely) emits just
// '/credential'. This matches `http-errors.test.ts`'s own fixtures exactly
// (`{ instancePath: '/name', message: 'Required' }`).
describe('fieldErrorsFromIssues', () => {
  it('maps a top-level instancePath to its bare form key', () => {
    expect(fieldErrorsFromIssues([{ path: '/sshPort', message: 'Port must be between 1 and 65535' }])).toEqual({
      sshPort: 'Port must be between 1 and 65535',
    });
  });

  it('maps a nested /credential/* instancePath to the single shared "credential" form key', () => {
    expect(
      fieldErrorsFromIssues([
        { path: '/credential/privateKey', message: 'Too small: expected string to have >=1 characters' },
      ]),
    ).toEqual({ credential: 'Too small: expected string to have >=1 characters' });
  });

  it('collapses two different nested credential paths onto the same "credential" key (they share one control)', () => {
    const mapped = fieldErrorsFromIssues([
      { path: '/credential/privateKey', message: 'private key message' },
      { path: '/credential/passphrase', message: 'passphrase message' },
    ]);

    expect(mapped).toEqual({ credential: 'private key message' });
  });

  it('never collapses two distinct top-level fields onto the same key', () => {
    const mapped = fieldErrorsFromIssues([
      { path: '/name', message: 'name message' },
      { path: '/host', message: 'host message' },
    ]);

    expect(mapped).toEqual({ name: 'name message', host: 'host message' });
  });

  it('keeps the first message when a path repeats', () => {
    const mapped = fieldErrorsFromIssues([
      { path: '/email', message: 'first message' },
      { path: '/email', message: 'second message' },
    ]);

    expect(mapped).toEqual({ email: 'first message' });
  });

  it('drops an issue whose path is not a known form field, even in the real leading-slash shape', () => {
    expect(fieldErrorsFromIssues([{ path: '/notARealField', message: 'nope' }])).toEqual({});
  });

  it('drops the bare "/" root path (e.g. an unrecognized top-level key) -- no UI field renders it', () => {
    expect(fieldErrorsFromIssues([{ path: '/', message: 'Unrecognized key: "extra"' }])).toEqual({});
  });
});

describe('normalizeFieldPath', () => {
  it('normalizes a bare top-level instancePath to its form key', () => {
    expect(normalizeFieldPath('/name')).toBe('name');
    expect(normalizeFieldPath('/host')).toBe('host');
    expect(normalizeFieldPath('/token')).toBe('token');
  });

  it('normalizes every nested /credential/* path, and the bare /credential root, to "credential"', () => {
    expect(normalizeFieldPath('/credential/privateKey')).toBe('credential');
    expect(normalizeFieldPath('/credential/passphrase')).toBe('credential');
    expect(normalizeFieldPath('/credential/type')).toBe('credential');
    expect(normalizeFieldPath('/credential')).toBe('credential');
  });

  it('returns null for a path no screen in this app rendered a field for', () => {
    expect(normalizeFieldPath('/notARealField')).toBeNull();
    expect(normalizeFieldPath('/')).toBeNull();
  });
});

describe('fieldForErrorCode', () => {
  it('routes NAME_TAKEN to the Name field, HOST_TAKEN to the Host field and INVALID_CREDENTIAL to the credential block', () => {
    expect(fieldForErrorCode('NAME_TAKEN')).toBe('name');
    expect(fieldForErrorCode('HOST_TAKEN')).toBe('host');
    expect(fieldForErrorCode('INVALID_CREDENTIAL')).toBe('credential');
  });

  it('returns null for a code with no per-field routing', () => {
    expect(fieldForErrorCode('INTERNAL_ERROR')).toBeNull();
  });

  // Gap 6: FINGERPRINT_MISMATCH/SERVER_NOT_TRUSTABLE are banner/dialog-level failures, never routed
  // to a specific form field.
  it('routes FINGERPRINT_MISMATCH and SERVER_NOT_TRUSTABLE to no form field', () => {
    expect(fieldForErrorCode('FINGERPRINT_MISMATCH')).toBeNull();
    expect(fieldForErrorCode('SERVER_NOT_TRUSTABLE')).toBeNull();
  });
});

describe('formatRetryAfterDuration', () => {
  it('renders 120 seconds as "in 2 minutes", never the raw number', () => {
    const rendered = formatRetryAfterDuration(120);

    expect(rendered).toBe('in 2 minutes');
    expect(rendered).not.toContain('120');
  });

  it('renders a sub-minute duration in seconds', () => {
    expect(formatRetryAfterDuration(30)).toBe('in 30 seconds');
  });

  it('degrades non-finite or non-positive input to a generic wait rather than a nonsensical duration', () => {
    expect(formatRetryAfterDuration(0)).toBe('in a moment');
    expect(formatRetryAfterDuration(-5)).toBe('in a moment');
    expect(formatRetryAfterDuration(Number.NaN)).toBe('in a moment');
  });
});
