import { describe, expect, it } from "vitest";
import { ADVERSARIAL_VALUES, shellWords } from "../testing/shell-round-trip.js";
import {
  containerNameFor,
  deployWorkspaceFor,
  validateImageRef,
} from "@noodara/domain/validators";
import {
  DEPLOY_COMMAND_NAMES,
  type DeployCommandName,
} from "./deploy-allowlist.js";
import {
  validateHealthcheckConfig,
  type HealthcheckConfig,
} from "@noodara/domain/deployment";
import {
  dockerImageInspect,
  dockerInspectNetworks,
  dockerLogs,
  dockerNetworkConnect,
  dockerRemovePrevious,
  dockerRenameFromPrevious,
  dockerRenameToPrevious,
  dockerStartPrevious,
  dockerStopPrevious,
  probeHttp,
  probeTcp,
  validateContainerIp,
  PREV_STEP_TIMEOUT_SECONDS,
  type HttpHealthcheckConfig,
  type TcpHealthcheckConfig,
} from "./docker-deploy.js";
import {
  createRemoteCommand,
  renderRemoteCommand,
  type RemoteCommand,
} from "./remote-command.js";
import { SHELL_SCRIPTS } from "./shell-scripts.js";
import { supervise } from "./workspace.js";

// Exactness guard for the deploy allowlist (SVC-08, ROADMAP criterion 4). Hand-written on purpose:
// adding a template without updating this list fails the suite.
const EXPECTED_DEPLOY_COMMAND_NAMES: readonly DeployCommandName[] = [
  "git.clone",
  "git.checkout",
  "git.head_sha",
  "git.probe_features",
  "git.keyscan",
  "fs.prepare_workspace",
  "fs.remove_deploy_dir",
  "secrets.write_file",
  "secrets.write_askpass",
  "process.supervise",
  "process.kill_group",
  "process.group_alive",
  "docker.login",
  "docker.logout",
  "docker.pull",
  "docker.build",
  "docker.image_remove",
  "docker.network_create",
  "docker.network_remove",
  "docker.create",
  "docker.start",
  "docker.stop",
  "docker.restart",
  "docker.remove",
  "docker.inspect",
  "docker.logs",
  "docker.ps",
  "docker.kill",
  "docker.builder_prune",
  "docker.inspect_networks",
  "docker.network_connect",
  "docker.rename_to_prev",
  "docker.rename_from_prev",
  "docker.start_prev",
  "docker.stop_prev",
  "docker.remove_prev",
  "docker.image_list_service",
  "docker.image_remove_service",
  "probe.http",
  "probe.tcp",
  // 17-05: manual rollback checks the target image is still on the server.
  "docker.image_inspect",
  // 18-03: deploy the exact pushed SHA.
  "git.fetch_commit",
  "git.fetch_unshallow",
];

// ADR 0008 text, copied by hand. G1: secret file and workspace; G2: launcher and group kill.
const ADR_0008_SCRIPTS = {
  writeSecretFromStdin: 'umask 077 && cat > "$0"',
  prepareWorkspace: 'umask 077 && mkdir -p "$0/secrets" "$0/run"',
  supervise: 'echo $$ > "$0"; exec "$@"',
  killGroup: 'read -r pgid < "$0" && kill -s TERM -- "-$pgid"',
} as const;

const DOLLAR = String.fromCharCode(36);
const BACKTICK = String.fromCharCode(96);
const INTERPOLATION_MARKER = DOLLAR + String.fromCharCode(123);
const COMMAND_SUBSTITUTION_MARKER = DOLLAR + String.fromCharCode(40);
const ALLOWED_PARAMETERS = new Set([
  "0",
  "@",
  DOLLAR,
  "pgid",
  "submodules",
  "lfs",
]);

describe("DEPLOY_COMMAND_NAMES", () => {
  it("is exactly the 41 expected names, in order", () => {
    expect(DEPLOY_COMMAND_NAMES).toEqual(EXPECTED_DEPLOY_COMMAND_NAMES);
    expect(DEPLOY_COMMAND_NAMES).toHaveLength(43);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEPLOY_COMMAND_NAMES)).toBe(true);
  });
});

describe("SHELL_SCRIPTS", () => {
  const entries = Object.entries(SHELL_SCRIPTS);

  it("is frozen and holds exactly the known scripts", () => {
    expect(Object.isFrozen(SHELL_SCRIPTS)).toBe(true);
    expect(Object.keys(SHELL_SCRIPTS).sort()).toEqual(
      [
        "groupAlive",
        "killGroup",
        "prepareWorkspace",
        "probeFeatures",
        "supervise",
        "writeAskpassFromStdin",
        "writeSecretFromStdin",
      ].sort(),
    );
  });

  it.each(Object.entries(ADR_0008_SCRIPTS))(
    "%s equals the ADR 0008 text",
    (key, text) => {
      expect(SHELL_SCRIPTS[key as keyof typeof ADR_0008_SCRIPTS]).toBe(text);
    },
  );

  it("killGroup uses `kill -s TERM`, never the form dash rejects (ADR 0008 G2)", () => {
    expect(SHELL_SCRIPTS.killGroup).not.toContain("kill -TERM");
  });

  it("groupAlive reads the pgid from the pidfile and asks pgrep for the group", () => {
    expect(SHELL_SCRIPTS.groupAlive).toBe(
      'read -r pgid < "$0" && pgrep -g "$pgid" > /dev/null',
    );
  });

  it("writeAskpassFromStdin writes 0600 under umask 077, then makes it executable by the owner only", () => {
    expect(SHELL_SCRIPTS.writeAskpassFromStdin).toBe(
      'umask 077 && cat > "$0" && chmod 0700 "$0"',
    );
  });

  it.each(entries)(
    "%s contains no interpolation marker, backtick or command substitution",
    (_, script) => {
      expect(script.includes(INTERPOLATION_MARKER)).toBe(false);
      expect(script.includes(BACKTICK)).toBe(false);
      expect(script.includes(COMMAND_SUBSTITUTION_MARKER)).toBe(false);
    },
  );

  it.each(entries)(
    "%s references only positional parameters, $$ or its own locals",
    (_, script) => {
      const dollars = script.split(DOLLAR).length - 1;
      const references = [
        ...script.matchAll(/[$]([0-9@$]|[A-Za-z_][A-Za-z0-9_]*)/g),
      ];
      const names = references.map((match) => match[1] ?? "");

      // `$$` is one reference made of two dollar characters.
      const consumed = names.reduce(
        (total, name) => total + (name === DOLLAR ? 2 : 1),
        0,
      );
      expect(consumed).toBe(dollars);
      for (const name of names)
        expect(ALLOWED_PARAMETERS.has(name), name).toBe(true);
    },
  );

  it("probeFeatures prints exactly the submodules and lfs lines", () => {
    expect(SHELL_SCRIPTS.probeFeatures).toContain(
      'echo "submodules=$submodules"',
    );
    expect(SHELL_SCRIPTS.probeFeatures).toContain('echo "lfs=$lfs"');
    expect(SHELL_SCRIPTS.probeFeatures).toContain(".gitmodules");
    expect(SHELL_SCRIPTS.probeFeatures).toContain("160000");
    expect(SHELL_SCRIPTS.probeFeatures).toContain("filter=lfs");
    expect(SHELL_SCRIPTS.probeFeatures).toContain(
      "version https://git-lfs.github.com/spec/v1",
    );
  });
});

describe("renderRemoteCommand", () => {
  it("quotes every argv token and joins them with one space", () => {
    const command = createRemoteCommand({
      name: "docker.ps",
      argv: ["docker", "ps"],
      stdin: "none",
      supervisable: false,
    });

    expect(renderRemoteCommand(command)).toBe("'docker' 'ps'");
  });

  it("round-trips adversarial tokens through a real POSIX shell as literal words", () => {
    const argv: [string, ...string[]] = ["echo", ...ADVERSARIAL_VALUES];
    const command = createRemoteCommand({
      name: "docker.logs",
      argv,
      stdin: "none",
      supervisable: false,
    });

    expect(shellWords(renderRemoteCommand(command))).toEqual(argv);
  });
});

describe("RemoteCommand", () => {
  it("is frozen, argv included", () => {
    const command = createRemoteCommand({
      name: "docker.ps",
      argv: ["docker", "ps"],
      stdin: "none",
      supervisable: false,
    });

    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.argv)).toBe(true);
  });

  it("copies argv, so a caller cannot mutate the command after creation", () => {
    const argv: [string, ...string[]] = ["docker", "ps"];
    const command = createRemoteCommand({
      name: "docker.ps",
      argv,
      stdin: "none",
      supervisable: false,
    });

    argv.push("--privileged");

    expect(command.argv).toEqual(["docker", "ps"]);
  });

  it("cannot be forged as an object literal outside the commands module", () => {
    // @ts-expect-error the RemoteCommand brand is module-private (T-11-34)
    const forged: RemoteCommand = {
      name: "docker.ps",
      argv: ["docker", "ps"],
      stdin: "none",
      supervisable: false,
    };

    expect(forged.name).toBe("docker.ps");
  });
});

describe("supervised docker.logs --follow (12-16, ADR 0008 G2)", () => {
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const ws = deployWorkspaceFor(id);
  const name = containerNameFor(id);
  if (!ws.ok || !name.ok) throw new Error("fixture ids must be valid");
  const pidFile = ws.value.pidFile("logs");

  it("renders the fixed launcher shape and nothing else, round-tripping as literal words", () => {
    const command = supervise(
      pidFile,
      dockerLogs({ container: name.value, tail: 50, follow: true }),
    );
    const argv = [
      "setsid",
      "-w",
      "sh",
      "-c",
      SHELL_SCRIPTS.supervise,
      pidFile,
      "docker",
      "logs",
      "--tail",
      "50",
      "--timestamps",
      "--follow",
      "--",
      name.value,
    ];

    expect(command.name).toBe("process.supervise");
    expect(command.stdin).toBe("none");
    expect(command.argv).toEqual(argv);
    expect(shellWords(renderRemoteCommand(command))).toEqual(argv);
  });

  it("refuses to supervise the bounded tail form", () => {
    expect(() =>
      supervise(
        pidFile,
        dockerLogs({ container: name.value, tail: 50, follow: false }),
      ),
    ).toThrow(/cannot run under process.supervise/);
  });
});

describe("17-01 H1: probe and -prev templates carry their own hard time cap", () => {
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const sid = containerNameFor(id);
  const ip = validateContainerIp("172.18.0.2");
  const ws = deployWorkspaceFor(id);
  if (!sid.ok || !ip.ok || !ws.ok) throw new Error("fixtures must be valid");
  const serviceId = id as Parameters<typeof dockerRenameToPrevious>[0];
  const pidFile = ws.value.pidFile("build");
  const image = validateImageRef("ghcr.io/acme/api:1.2.3");
  if (!image.ok) throw new Error("fixture image must be valid");

  function config(fields: Record<string, unknown>): HealthcheckConfig {
    const result = validateHealthcheckConfig({
      probeTimeoutS: 7,
      intervalS: 5,
      retries: 3,
      startPeriodS: 0,
      ...fields,
    });
    if (!result.ok) throw new Error("fixture config must be valid");
    return result.value;
  }

  const probes = [
    probeHttp({
      ip: ip.value,
      config: config({
        type: "http",
        path: "/health",
        port: 3000,
      }) as HttpHealthcheckConfig,
    }),
    probeTcp({
      ip: ip.value,
      config: config({ type: "tcp", port: 5432 }) as TcpHealthcheckConfig,
    }),
  ];
  const prevSteps = [
    dockerRenameToPrevious(serviceId),
    dockerRenameFromPrevious(serviceId),
    dockerStartPrevious(serviceId),
    dockerRemovePrevious(serviceId),
    dockerNetworkConnect(serviceId),
    dockerInspectNetworks({ serviceId, container: "previous" }),
    // 17-05: the rollback image check shares the fixed step budget.
    dockerImageInspect(image.value),
  ];

  it.each(probes.map((c) => [c.name, c] as const))(
    "%s runs `timeout -k 1 <probeTimeoutS>` under an empty env, before bash",
    (_, command) => {
      expect(command.argv.slice(0, 7)).toEqual([
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "timeout",
        "-k",
        "1",
        "7",
      ]);
    },
  );

  it.each(prevSteps.map((c) => [c.name, c] as const))(
    "%s starts with `timeout -k 1 <fixed step budget>`",
    (_, command) => {
      expect(command.argv.slice(0, 4)).toEqual([
        "timeout",
        "-k",
        "1",
        String(PREV_STEP_TIMEOUT_SECONDS),
      ]);
    },
  );

  it("docker.stop_prev adds its stop timeout to the step budget", () => {
    expect(
      dockerStopPrevious({ serviceId, timeoutSeconds: 20 }).argv.slice(0, 4),
    ).toEqual(["timeout", "-k", "1", String(20 + PREV_STEP_TIMEOUT_SECONDS)]);
  });

  it.each([...probes, ...prevSteps].map((c) => [c.name, c] as const))(
    "%s is bounded, so it never runs under process.supervise",
    (_, command) => {
      expect(command.supervisable).toBe(false);
      expect(() => supervise(pidFile, command)).toThrow(
        /cannot run under process.supervise/,
      );
    },
  );
});
