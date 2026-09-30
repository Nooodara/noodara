// Parser for `docker ps --all --no-trunc --size=false --filter label=noodara.managed=true
// --format '{{json .}}'` (ADR 0008 G4). The output is NDJSON: one JSON object per line, never one
// array, so each line is parsed on its own and a bad line never discards the others. Pure and
// never throws. Only `Names` and `State` are required; the closed state vocabulary keeps a
// hostile image or label from spoofing a state (T-11-27).

import type { CommandOutput } from "../discovery/docker-version.js";
import {
  isDockerContainerState,
  type DockerContainerState,
} from "./container-state.js";
import type { ContainerObservation } from "./service-status.js";

const COMMAND_NOT_FOUND_EXIT_CODE = 127;
const EXITED_STATUS = /^Exited \((-?\d+)\)/;

export interface ObservedContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: DockerContainerState;
  readonly exitCode: number | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly ports: string;
}

export type DockerPsResult =
  | {
      readonly kind: "ok";
      readonly containers: readonly ObservedContainer[];
      readonly unparseableLines: readonly {
        readonly line: number;
        readonly reason: string;
      }[];
    }
  | { readonly kind: "daemon_unreachable" }
  | { readonly kind: "unparseable"; readonly reason: string };

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      labels[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return labels;
}

function toContainer(value: unknown): ObservedContainer | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Line was not a JSON object";
  }
  const o = value as Record<string, unknown>;
  const name = str(o["Names"]);
  if (name.length === 0) {
    return "Line had no Names string";
  }
  const state = o["State"];
  if (!isDockerContainerState(state)) {
    return "Line had a missing or unknown State";
  }
  const match = EXITED_STATUS.exec(str(o["Status"]));
  return {
    id: str(o["ID"]),
    name,
    image: str(o["Image"]),
    state,
    exitCode: match?.[1] === undefined ? null : Number(match[1]),
    labels: parseLabels(str(o["Labels"])),
    ports: str(o["Ports"]),
  };
}

export function parseDockerPsOutput(output: CommandOutput): DockerPsResult {
  if (output.exitCode !== 0) {
    if (output.exitCode === COMMAND_NOT_FOUND_EXIT_CODE) {
      return { kind: "unparseable", reason: "docker command not found" };
    }
    if (output.stderr.includes("Cannot connect to the Docker daemon")) {
      return { kind: "daemon_unreachable" };
    }
    return {
      kind: "unparseable",
      reason: `docker ps exited with code ${output.exitCode}`,
    };
  }

  const containers: ObservedContainer[] = [];
  const unparseableLines: { line: number; reason: string }[] = [];
  const lines = output.stdout.split("\n");
  lines.forEach((raw, index) => {
    const text = raw.trim();
    if (text.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      unparseableLines.push({
        line: index + 1,
        reason: "Line was not valid JSON",
      });
      return;
    }
    const result = toContainer(parsed);
    if (typeof result === "string") {
      unparseableLines.push({ line: index + 1, reason: result });
    } else {
      containers.push(result);
    }
  });
  return { kind: "ok", containers, unparseableLines };
}

export function toContainerObservation(
  containers: readonly ObservedContainer[],
  containerName: string,
): ContainerObservation {
  const found = containers.find((c) => c.name === containerName);
  if (found === undefined) {
    return { kind: "absent" };
  }
  switch (found.state) {
    case "running":
      return { kind: "running" };
    case "exited":
    case "created":
    case "dead":
      return { kind: "stopped", exitCode: found.exitCode };
    case "paused":
    case "restarting":
    case "removing":
      return { kind: "unknown" };
  }
}
