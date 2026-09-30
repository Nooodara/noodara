// BuildKit detection (D-03: detect, don't infer). ADR 0008 G3: the first stdout line of
// `docker build --help` is `Usage:  docker buildx build ...` (two spaces) when BuildKit is the
// builder a real build would use, and `Usage:  docker build ...` otherwise. `docker buildx
// version`, `docker info` and `docker buildx inspect` false-positive under DOCKER_BUILDKIT=0, so
// they are never used. Pure and never throws; unrecognised output is `unparseable`, never
// collapsed into `plugin_missing`.

import type { CommandOutput } from "./docker-version.js";

const COMMAND_NOT_FOUND_EXIT_CODE = 127;
const BUILDX_USAGE = "Usage:  docker buildx build";
const LEGACY_USAGE = "Usage:  docker build";
const BUILDKIT_DISABLED_MARKER = "BuildKit is currently disabled";

export type BuildKitStatus =
  | { readonly kind: "active"; readonly version: string | null }
  | { readonly kind: "plugin_missing" }
  // Measured in G3 (`legacy_env` capture): plugin installed but DOCKER_BUILDKIT=0 forces the
  // legacy builder. Kept apart from plugin_missing so the remediation is not misreported.
  | { readonly kind: "buildkit_disabled" }
  | { readonly kind: "daemon_unreachable" }
  | { readonly kind: "unparseable"; readonly reason: string };

function startsWithUsage(line: string, usage: string): boolean {
  return line === usage || line.startsWith(`${usage} `);
}

export function parseBuildKitStatus(output: CommandOutput): BuildKitStatus {
  if (
    output.exitCode === COMMAND_NOT_FOUND_EXIT_CODE &&
    output.stdout.trim().length === 0
  ) {
    return { kind: "unparseable", reason: "docker command not found" };
  }
  if (output.exitCode !== 0) {
    if (output.stderr.includes("Cannot connect to the Docker daemon")) {
      return { kind: "daemon_unreachable" };
    }
    return {
      kind: "unparseable",
      reason: `docker build --help exited with code ${String(output.exitCode)}`,
    };
  }

  const newline = output.stdout.indexOf("\n");
  const firstLine = (
    newline === -1 ? output.stdout : output.stdout.slice(0, newline)
  ).trimEnd();
  if (startsWithUsage(firstLine, BUILDX_USAGE)) {
    // The help text carries no version; the field exists for a future richer command.
    return { kind: "active", version: null };
  }
  if (startsWithUsage(firstLine, LEGACY_USAGE)) {
    return output.stderr.includes(BUILDKIT_DISABLED_MARKER)
      ? { kind: "buildkit_disabled" }
      : { kind: "plugin_missing" };
  }
  return {
    kind: "unparseable",
    reason: "First output line was not a recognised docker build usage line",
  };
}
