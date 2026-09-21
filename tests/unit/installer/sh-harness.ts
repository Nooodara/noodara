// Harness for exercising install.sh's functions under a real POSIX shell (D-18 layer 1,
// 06-01-PLAN.md Task 2).
//
// 06-RESEARCH.md Pitfall 1: `bash install.sh` "just works" during development and hides the gap
// from the real published `curl -fsSL .../install.sh | sh`, which on Ubuntu always runs under
// dash regardless of any `#!/bin/bash` shebang -- the shebang is inert when the interpreter is
// invoked explicitly by the pipe. Every function here is exercised through a real `/bin/sh` (and
// `dash`, when available), never `bash`, mirroring
// tests/integration/helpers/boot-process.ts's process-spawn-and-assert shape (the in-repo
// precedent RESEARCH.md's own "Shell testing layer" section names directly).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo-root install.sh, resolved from this file's own location -- never
 *  `process.cwd()`, so this harness works regardless of the test runner's working directory. */
export const INSTALL_SH = path.resolve(HERE, '../../../install.sh');

/** True when `interpreter -c 'echo ${BASH_VERSION:-nobash}'` prints `nobash` -- i.e. the
 *  interpreter is not bash (dash, or any other genuine POSIX-only shell). macOS's own `/bin/sh`
 *  is bash running in POSIX-compatibility mode, so `$BASH_VERSION` is still set there -- this is
 *  the concrete check that tells the two apart. */
export function isDashFamily(interpreter: string): boolean {
  const result = spawnSync(interpreter, ['-c', 'echo ${BASH_VERSION:-nobash}'], {
    encoding: 'utf8',
  });
  return result.stdout.trim() === 'nobash';
}

/** Always `['/bin/sh']`, plus dash's absolute path appended when it resolves on this machine
 *  (`command -v dash`, run through `/bin/sh` itself so this works even before dash's own presence
 *  is known). */
export function posixInterpreters(): string[] {
  const interpreters = ['/bin/sh'];

  const dash = spawnSync('/bin/sh', ['-c', 'command -v dash'], { encoding: 'utf8' });
  if (dash.status === 0) {
    const resolved = dash.stdout.trim();
    if (resolved !== '') {
      interpreters.push(resolved);
    }
  }

  return interpreters;
}

export interface RunInstallerShellOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunInstallerShellResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Sources install.sh as a library (`NOODARA_INSTALL_SH_SOURCE_ONLY=1`) under `interpreter`, then
 *  runs `snippet` in the same shell -- e.g. a direct function call like
 *  `noodara_exit_code_for port-in-use`. Sourcing under the guard only defines functions and sets
 *  constants; it never triggers a real install. */
export function runInstallerShell(
  interpreter: string,
  snippet: string,
  options: RunInstallerShellOptions = {},
): RunInstallerShellResult {
  const script = `NOODARA_INSTALL_SH_SOURCE_ONLY=1 . "${INSTALL_SH}"\n${snippet}`;

  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...options.env };

  const result = spawnSync(interpreter, ['-c', script], {
    encoding: 'utf8',
    env,
    cwd: options.cwd,
  });

  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}
