// Post-06-04 security fix (orchestrator audit Finding B, SUSPECTED-then-confirmed): a generated
// `.env` is consumed by Docker Compose (Plan 06-07) both via `env_file:` on individual services
// and via top-level `${VAR}` interpolation into the compose YAML itself -- both mechanisms read
// `.env` through the same dotenv-style parser, which interpolates `$VAR`/`${VAR}` and treats an
// unquoted or double-quoted value's ` #` as an inline comment. Manual investigation (this task,
// not re-derived here) confirmed an operator admin password containing '$', a space and '#' was
// silently corrupted before reaching a container's environment when install.sh wrote it
// unquoted -- and confirmed, via a real `docker compose run` probe, that a single-quoted `.env`
// value is taken fully literally by Compose and reaches the container byte-for-byte.
//
// This suite proves the fix holds through the real `docker compose config` parser (no containers
// are created -- `config` only renders the resolved model) rather than re-asserting the
// unit-level string-building tests/unit/installer/env-file.test.ts already covers.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInstallerShell } from '../../unit/installer/sh-harness.js';

/** POSIX single-quote escaping for embedding an arbitrary value into a shell snippet (mirrors
 *  tests/unit/installer/env-file.test.ts's own shQuote). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// `docker compose config` is a local render of the already-parsed model -- fast, but still a real
// child process spawn against the real Docker CLI, so an explicit timeout applies (hard_rule #8:
// no bare, unbounded spawn of an external tool).
const DOCKER_CONFIG_TIMEOUT_MS = 30_000;

interface ComposeConfigJson {
  services: {
    probe: {
      environment?: Record<string, string>;
    };
  };
}

describe('a generated .env round-trips through Docker Compose config parsing', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('NOODARA_ADMIN_PASSWORD containing $, $$, ${VAR}, a space, " #", a double quote and a backslash resolves byte-identically', () => {
    dir = mkdtempSync(join(tmpdir(), 'noodara-compose-env-'));
    const envPath = join(dir, '.env');
    // Exactly the character classes 06-CONTEXT.md/the orchestrator's Finding B named as at risk:
    // '$', '$$', '${X}' (Compose interpolation), ' #' (Compose's inline-comment marker), a bare
    // space, a double quote and a backslash. No LF/CR and no single quote -- those are rejected
    // outright by noodara_env_assert_single_line/noodara_env_assert_no_single_quote and are
    // covered by tests/unit/installer/env-file.test.ts's own injection-guard suite instead.
    const trickyPassword = 'p@ss$word $$literal ${UNDEFINED_VAR} with space #not-a-comment "quoted" back\\slash';

    const genResult = runInstallerShell(
      '/bin/sh',
      [
        'noodara_generate_env',
        shQuote(envPath),
        shQuote('https://noodara.example.com'),
        '3000',
        '0.1.0',
        shQuote('ghcr.io/example/noodara'),
      ].join(' '),
      { env: { NOODARA_ADMIN_EMAIL: 'admin@example.com', NOODARA_ADMIN_PASSWORD: trickyPassword } },
    );
    expect(genResult.status).toBe(0);

    // Minimal, never-started throwaway compose file (hard_rule #8: `docker compose config`
    // creates nothing -- no `up`). One service, `env_file: .env`, the exact mechanism
    // 06-07-PLAN.md's api/worker/migrate services use for the application variables.
    const composePath = join(dir, 'docker-compose.yml');
    writeFileSync(
      composePath,
      ['services:', '  probe:', '    image: busybox', '    env_file:', '      - .env', ''].join('\n'),
    );

    const stdout = execFileSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: DOCKER_CONFIG_TIMEOUT_MS,
    });
    const config = JSON.parse(stdout) as ComposeConfigJson;
    const rawResolved = config.services.probe.environment?.NOODARA_ADMIN_PASSWORD ?? '';

    // Observed, reported verbatim (do not assume): `docker compose config --format json` prints
    // every literal '$' in an already-resolved (non-interpolated) value doubled as '$$' -- its
    // own round-trip-safe serialization, so the printed config could be re-fed to Compose without
    // a further, unwanted interpolation pass. A real `docker compose run --rm probe sh -c
    // 'printf "%s" "$NOODARA_ADMIN_PASSWORD"'` probe against this exact fixture (this task's own
    // manual investigation, not part of this automated suite) printed the password with single,
    // undoubled '$' characters -- byte-identical to trickyPassword. Undo config's doubling before
    // comparing; this is `config`'s own printer convention, not evidence of corruption.
    const resolved = rawResolved.replace(/\$\$/g, '$');

    expect(resolved).toBe(trickyPassword);
  });
});
