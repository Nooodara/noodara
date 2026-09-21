// 06-04-PLAN.md: install.sh's `.env` generation half of INST-01/INST-02 -- secret generation,
// fresh .env writing (mode 600, HTTP cookie opt-out), and the additive merge/backup mechanism for
// a re-run (D-11). Exercised under every available real POSIX interpreter (`/bin/sh`, plus `dash`
// when present), never `bash` (06-RESEARCH.md Pitfall 1), mirroring preflight.test.ts's own
// conventions.
//
// hard_rule #8: no generated secret value here is ever asserted by literal equality against a
// hardcoded string, echoed in an expect() failure message beyond structural comparison, or
// compared across test runs -- only shape/length/charset and round-trip equality within the same
// generation are asserted.
import { describe, expect, it } from 'vitest';
import { posixInterpreters, runInstallerShell } from './sh-harness.js';

describe.each(posixInterpreters())('install.sh secret generation (%s)', (interpreter) => {
  describe('noodara_generate_secret', () => {
    it('hex prints 64 lowercase hex characters', () => {
      const result = runInstallerShell(interpreter, 'noodara_generate_secret hex');

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('base64 prints a value that decodes to exactly 32 bytes', () => {
      const result = runInstallerShell(interpreter, 'noodara_generate_secret base64');

      expect(result.status).toBe(0);
      const decoded = Buffer.from(result.stdout.trim(), 'base64');
      expect(decoded.length).toBe(32);
    });

    it('two consecutive hex calls never produce the same value', () => {
      const result = runInstallerShell(
        interpreter,
        'a=$(noodara_generate_secret hex); b=$(noodara_generate_secret hex); [ "$a" != "$b" ]',
      );

      expect(result.status).toBe(0);
    });

    it('two consecutive base64 calls never produce the same value', () => {
      const result = runInstallerShell(
        interpreter,
        'a=$(noodara_generate_secret base64); b=$(noodara_generate_secret base64); [ "$a" != "$b" ]',
      );

      expect(result.status).toBe(0);
    });
  });

  describe('noodara_build_database_url', () => {
    it('prints postgresql://noodara:<password>@postgres:5432/noodara', () => {
      const result = runInstallerShell(interpreter, 'noodara_build_database_url examplepw123');

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('postgresql://noodara:examplepw123@postgres:5432/noodara');
    });

    it('round-trips a hex password through URL parsing byte-for-byte', () => {
      const result = runInstallerShell(
        interpreter,
        [
          'password=$(noodara_generate_secret hex)',
          'noodara_build_database_url "$password"',
          'printf "PW=%s\\n" "$password"',
        ].join('\n'),
      );

      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n');
      const url = lines[0] ?? '';
      const pwLine = lines.find((line) => line.startsWith('PW='));
      const originalPassword = pwLine === undefined ? '' : pwLine.slice('PW='.length);

      const parsed = new URL(url);
      expect(decodeURIComponent(parsed.password)).toBe(originalPassword);
    });
  });

  describe('noodara_build_redis_url', () => {
    it('prints redis://:<password>@redis:6379', () => {
      const result = runInstallerShell(interpreter, 'noodara_build_redis_url examplepw123');

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('redis://:examplepw123@redis:6379');
    });

    it('round-trips a hex password through URL parsing byte-for-byte', () => {
      const result = runInstallerShell(
        interpreter,
        [
          'password=$(noodara_generate_secret hex)',
          'noodara_build_redis_url "$password"',
          'printf "PW=%s\\n" "$password"',
        ].join('\n'),
      );

      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n');
      const url = lines[0] ?? '';
      const pwLine = lines.find((line) => line.startsWith('PW='));
      const originalPassword = pwLine === undefined ? '' : pwLine.slice('PW='.length);

      const parsed = new URL(url);
      expect(decodeURIComponent(parsed.password)).toBe(originalPassword);
    });
  });
});
