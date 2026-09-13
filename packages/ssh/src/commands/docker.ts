// Docker/compose version templates (D-12). Structured output only — `--format` JSON and
// `--short`, never free-text parsing (RESEARCH Pitfall 6). `docker compose` is the v2 plugin
// subcommand form; the deprecated v1 `docker-compose` standalone binary is never used.
export const DOCKER_COMMANDS = {
  'docker.version': "docker version --format '{{json .}}'",
  'docker.compose_version': 'docker compose version --short',
} as const;
