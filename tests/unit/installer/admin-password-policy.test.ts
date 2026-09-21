// Post-execution fix (orchestrator audit WR-04, code review report
// .planning/phases/06-instalador-y-docker-compose/06-REVIEW.md): docs/install.md previously
// implied NOODARA_ADMIN_PASSWORD's full policy (length, common-password, equals-identifier) was
// rejected "outright before anything is written", when install.sh itself only ever checked for an
// embedded newline/CR and a literal single quote -- the rest was enforced later, inside the `api`
// container at boot, surfacing as an opaque exit 53 only after a full
// NOODARA_HEALTH_WAIT_ATTEMPTS x NOODARA_HEALTH_WAIT_INTERVAL stall (5 minutes by default).
//
// Design decision (recorded in .planning/STATE.md): install.sh now mirrors, up front, only the
// two parts of packages/domain/src/validators/password.ts's real `validatePassword` that are
// cheap and stable enough not to drift silently -- the minimum length and the equals-identifier
// rule. The common-password list is deliberately NOT mirrored (a data file that could drift from
// a shell copy); docs/install.md instead tells the operator that check happens at control-plane
// boot and surfaces as exit 53.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { posixInterpreters, runInstallerShell } from './sh-harness.js';

/** POSIX single-quote escaping for embedding an arbitrary value into a shell snippet (mirrors
 *  env-file.test.ts's own shQuote). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validate(interpreter: string, email: string, password: string) {
  return runInstallerShell(
    interpreter,
    `noodara_validate_admin_password_policy ${shQuote(email)} ${shQuote(password)}`,
  );
}

describe.each(posixInterpreters())('install.sh noodara_validate_admin_password_policy (%s)', (interpreter) => {
  it('accepts a 12-character password unrelated to the email', () => {
    const result = validate(interpreter, 'admin@example.com', 'twelve-chars');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('rejects an 11-character password, naming NOODARA_ADMIN_PASSWORD but never the value', () => {
    const result = validate(interpreter, 'admin@example.com', 'eleven-char');

    expect(result.status).toBe(30);
    expect(result.stderr).toContain('NOODARA_ADMIN_PASSWORD');
    expect(result.stderr).toContain('12');
    expect(result.stderr).not.toContain('eleven-char');
  });

  it('rejects an empty password', () => {
    const result = validate(interpreter, 'admin@example.com', '');

    expect(result.status).toBe(30);
    expect(result.stderr).toContain('NOODARA_ADMIN_PASSWORD');
  });

  it('rejects a password equal to the full email address, case-insensitively', () => {
    const result = validate(interpreter, 'Admin@Example.com', 'admin@example.com');

    expect(result.status).toBe(30);
    expect(result.stderr).toContain('NOODARA_ADMIN_PASSWORD');
    expect(result.stderr).not.toContain('admin@example.com');
  });

  it('rejects a password equal to the part of the email before the @, case-insensitively', () => {
    const result = validate(interpreter, 'Admin@Example.com', 'ADMIN');

    expect(result.status).toBe(30);
    expect(result.stderr).toContain('NOODARA_ADMIN_PASSWORD');
  });

  it('accepts a password that merely contains the local part as a substring, not an exact match', () => {
    const result = validate(interpreter, 'admin@example.com', 'admin-but-longer-1');

    expect(result.status).toBe(0);
  });

  // Documents the deliberately safe direction of `${#value}`'s byte-vs-character counting under
  // dash/POSIX sh (never the review's own hunted-for false REJECT direction): a password with 6
  // multi-byte (2-byte-each) UTF-8 characters is only 6 real characters -- short of the real
  // PASSWORD_MIN_LENGTH -- but its BYTE length is 12, so this shell-side pre-filter accepts it
  // (a false accept). The real, character-accurate rejection still happens in the control plane at
  // boot (validatePassword), which this shell check is never the final authority over.
  it('accepts (never falsely rejects) a 6-character multi-byte password whose BYTE length is >=12 -- documents the safe over-acceptance direction', () => {
    const sixMultiByteChars = 'á'.repeat(6); // 6 real characters, 12 UTF-8 bytes.
    expect(Buffer.byteLength(sixMultiByteChars, 'utf8')).toBe(12);
    expect([...sixMultiByteChars]).toHaveLength(6);

    const result = validate(interpreter, 'admin@example.com', sixMultiByteChars);

    expect(result.status).toBe(0);
  });
});

// Guard test (WR-04's own instruction): pins install.sh's shell-side
// NOODARA_ADMIN_PASSWORD_MIN_LENGTH constant to the real TypeScript
// PASSWORD_MIN_LENGTH constant it mirrors, extracted from source at test time, so the two can
// never silently drift apart.
describe('NOODARA_ADMIN_PASSWORD_MIN_LENGTH drift guard', () => {
  it('equals packages/domain/src/validators/password.ts\'s real PASSWORD_MIN_LENGTH', () => {
    const domainSource = readFileSync('packages/domain/src/validators/password.ts', 'utf8');
    const match = domainSource.match(/export const PASSWORD_MIN_LENGTH = (\d+);/);
    expect(match, 'PASSWORD_MIN_LENGTH constant not found in password.ts').toBeTruthy();
    const domainMinLength = Number(match?.[1]);
    expect(domainMinLength).toBeGreaterThan(0);

    const result = runInstallerShell('/bin/sh', 'printf "%s" "$NOODARA_ADMIN_PASSWORD_MIN_LENGTH"');
    expect(result.status).toBe(0);
    const shellMinLength = Number(result.stdout);

    expect(shellMinLength).toBe(domainMinLength);
  });
});
