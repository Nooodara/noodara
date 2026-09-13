// Non-root access checks (D-13, SERV-08). `sudo -n true` — never a bare `sudo` — because a bare
// `sudo` over a non-interactive exec channel (no PTY) hangs waiting for a password prompt that
// can never arrive (RESEARCH Pitfall 7).
export const ACCESS_COMMANDS = {
  'access.sudo': 'sudo -n true',
  'access.docker_group': 'id -nG',
} as const;
