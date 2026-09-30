// Constant scripts run as `sh -c <script> <args...>` (ADR 0008 G1/G2). The only variable parts
// travel as positional parameters ("$0", "$@"); no script contains an interpolation marker,
// a backtick or command substitution. /bin/sh is dash on Ubuntu 22.04 and 24.04.
export const SHELL_SCRIPTS = Object.freeze({
  /** G1: secret file from stdin, mode 0600; $0 = target path. */
  writeSecretFromStdin: 'umask 077 && cat > "$0"',
  /** G1 (D7): askpass helper from stdin, then owner-executable; $0 = target path. */
  writeAskpassFromStdin: 'umask 077 && cat > "$0" && chmod 0700 "$0"',
  /** G1: workspace with mode-700 secrets and run dirs; $0 = workspace root. */
  prepareWorkspace: 'umask 077 && mkdir -p "$0/secrets" "$0/run"',
  /** G2: run under `setsid -w`; records the new process group id; $0 = pidfile. */
  supervise: 'echo $$ > "$0"; exec "$@"',
  /** G2: TERM the whole group. `kill -TERM -- "-$pgid"` fails under dash (exit 2). */
  killGroup: 'read -r pgid < "$0" && kill -s TERM -- "-$pgid"',
  /** Exit 0 while any member of the group is alive, 1 when none is; $0 = pidfile. */
  groupAlive: 'read -r pgid < "$0" && pgrep -g "$pgid" > /dev/null',
  /** D-09: prints `submodules=<0|1>` and `lfs=<0|1>`; $0 = repository dir. */
  probeFeatures: [
    'cd "$0" && git rev-parse --git-dir > /dev/null || exit 2',
    'submodules=0',
    'lfs=0',
    "if [ -e .gitmodules ] || git ls-files -s | grep -q '^160000 '; then submodules=1; fi",
    "if git grep -q -I -F -e filter=lfs -- '*.gitattributes' || git grep -q -I -F -e 'version https://git-lfs.github.com/spec/v1'; then lfs=1; fi",
    'echo "submodules=$submodules"',
    'echo "lfs=$lfs"',
  ].join('\n'),
});

export type ShellScriptName = keyof typeof SHELL_SCRIPTS;
