import {
  containerNameFor,
  deployWorkspaceFor,
  deploymentImageRefFor,
  networkNameFor,
  resolveRepoBuildPaths,
  validateBuildContextPath,
  validateBuildTarget,
  validateContainerPort,
  validateDockerObjectId,
  validateDockerfilePath,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  type BuildTarget,
  type ContainerName,
  type ContainerPort,
  type DockerConfigDir,
  type ImageRef,
  type NetworkName,
  type RegistryHost,
  type RegistryUsername,
  type RepoBuildPath,
  type ResourceId,
  type ValidationResult,
} from '@noodara/domain/validators';
import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_VALUES, shellWords } from '../testing/shell-round-trip.js';
import * as commands from './index.js';
import {
  dockerBuild,
  dockerCreate,
  dockerImageRemove,
  dockerInspectState,
  dockerBuilderPrune,
  dockerKill,
  dockerLogin,
  dockerLogout,
  dockerLogs,
  dockerNetworkCreate,
  dockerNetworkRemove,
  dockerPs,
  dockerPull,
  dockerRemove,
  dockerRestart,
  dockerStart,
  dockerStop,
} from './docker-deploy.js';
import { renderRemoteCommand, type RemoteCommand } from './remote-command.js';

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

const SERVICE_ID_TEXT = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
const DEPLOYMENT_ID_TEXT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const serviceId = valid(validateResourceId(SERVICE_ID_TEXT));
const deploymentId = valid(validateResourceId(DEPLOYMENT_ID_TEXT));
const ws = valid(deployWorkspaceFor(DEPLOYMENT_ID_TEXT));
const image = valid(deploymentImageRefFor(SERVICE_ID_TEXT, DEPLOYMENT_ID_TEXT));
const container = valid(containerNameFor(SERVICE_ID_TEXT));
const network = valid(networkNameFor(SERVICE_ID_TEXT));
const host = valid(validateRegistryHost('ghcr.io'));
const username = valid(validateRegistryUsername('noodara-bot'));
const target = valid(validateBuildTarget('runtime'));
const port = (value: number): ContainerPort => valid(validateContainerPort(value));
const { contextPath, dockerfilePath } = resolveRepoBuildPaths(
  ws.repo,
  valid(validateBuildContextPath('apps/api')),
  valid(validateDockerfilePath('apps/api/Dockerfile')),
);
const MANAGED_LABELS = [
  '--label',
  'noodara.managed=true',
  '--label',
  `noodara.service_id=${SERVICE_ID_TEXT}`,
  '--label',
  `noodara.deployment_id=${DEPLOYMENT_ID_TEXT}`,
];

describe('dockerLogin / dockerLogout / dockerPull', () => {
  it('login uses the per-deployment --config dir and --password-stdin (ADR 0008 G1)', () => {
    const command = dockerLogin({ config: ws.dockerConfigDir, host, username });

    expect(command.name).toBe('docker.login');
    expect(command.stdin).toBe('secret');
    expect(command.argv).toEqual([
      'docker',
      '--config',
      ws.dockerConfigDir,
      'login',
      '--username',
      username,
      '--password-stdin',
      '--',
      host,
    ]);
  });

  it('logout uses the same --config dir', () => {
    expect(dockerLogout({ config: ws.dockerConfigDir, host }).argv).toEqual([
      'docker',
      '--config',
      ws.dockerConfigDir,
      'logout',
      '--',
      host,
    ]);
  });

  it('pull with a config dir', () => {
    const command = dockerPull({ config: ws.dockerConfigDir, image });

    expect(command.name).toBe('docker.pull');
    expect(command.supervisable).toBe(true);
    expect(command.argv).toEqual(['docker', '--config', ws.dockerConfigDir, 'pull', '--', image]);
  });

  it('pull without a config dir (public image)', () => {
    expect(dockerPull({ config: null, image }).argv).toEqual(['docker', 'pull', '--', image]);
  });
});

describe('dockerBuild', () => {
  it('builds with plain progress, managed labels and -- before the context', () => {
    const command = dockerBuild({
      contextPath,
      dockerfilePath,
      image,
      target: null,
      serviceId,
      deploymentId,
    });

    expect(command.name).toBe('docker.build');
    expect(command.supervisable).toBe(true);
    expect(command.stdin).toBe('none');
    expect(command.argv).toEqual([
      'docker',
      'build',
      '--progress=plain',
      '--file',
      dockerfilePath,
      '--tag',
      image,
      ...MANAGED_LABELS,
      '--',
      contextPath,
    ]);
  });

  it('adds --target only when one is given', () => {
    const command = dockerBuild({
      contextPath,
      dockerfilePath,
      image,
      target,
      serviceId,
      deploymentId,
    });

    expect(command.argv).toEqual([
      'docker',
      'build',
      '--progress=plain',
      '--file',
      dockerfilePath,
      '--tag',
      image,
      '--target',
      target,
      ...MANAGED_LABELS,
      '--',
      contextPath,
    ]);
  });
});

describe('dockerCreate', () => {
  it('creates on the service network with restart policy, log rotation and managed labels', () => {
    const command = dockerCreate({
      container,
      network,
      image,
      internalPort: port(3000),
      publishedPort: port(8080),
      serviceId,
      deploymentId,
    });

    expect(command.name).toBe('docker.create');
    expect(command.argv).toEqual([
      'docker',
      'create',
      '--name',
      container,
      '--network',
      network,
      '--restart',
      'unless-stopped',
      '--log-opt',
      'max-size=10m',
      '--log-opt',
      'max-file=3',
      ...MANAGED_LABELS,
      '--publish',
      '8080:3000',
      '--',
      image,
    ]);
  });

  it('has no --publish token at all when publishedPort is null', () => {
    const command = dockerCreate({
      container,
      network,
      image,
      internalPort: port(3000),
      publishedPort: null,
      serviceId,
      deploymentId,
    });

    expect(command.argv).not.toContain('--publish');
    expect(command.argv.slice(-2)).toEqual(['--', image]);
  });
});

describe('container, image and network lifecycle', () => {
  it.each([
    ['docker.start', () => dockerStart(container), ['docker', 'start', '--', container]],
    ['docker.remove', () => dockerRemove(container), ['docker', 'rm', '--force', '--', container]],
    ['docker.image_remove', () => dockerImageRemove(image), ['docker', 'image', 'rm', '--', image]],
    [
      'docker.network_create',
      () => dockerNetworkCreate({ network, serviceId }),
      [
        'docker',
        'network',
        'create',
        '--label',
        'noodara.managed=true',
        '--label',
        `noodara.service_id=${SERVICE_ID_TEXT}`,
        '--',
        network,
      ],
    ],
    [
      'docker.network_remove',
      () => dockerNetworkRemove(network),
      ['docker', 'network', 'rm', '--', network],
    ],
    [
      'docker.inspect',
      () => dockerInspectState(container),
      ['docker', 'inspect', '--type', 'container', '--format', '{{json .State}}', '--', container],
    ],
    ['docker.kill', () => dockerKill(container), ['docker', 'kill', '--', container]],
  ] as const)('%s has the exact argv', (name, build, argv) => {
    const command = build();

    expect(command.name).toBe(name);
    expect(command.argv).toEqual(argv);
  });

  it('docker.kill also accepts a Docker object id', () => {
    const id = valid(validateDockerObjectId('0123456789ab'));

    expect(dockerKill(id).argv).toEqual(['docker', 'kill', '--', id]);
  });
});

describe('dockerStop / dockerRestart', () => {
  it('stop uses --timeout (Docker 29 deprecates --time) and -- before the name', () => {
    const command = dockerStop({ container, timeoutSeconds: 10 });

    expect(command.name).toBe('docker.stop');
    expect(command.argv).toEqual(['docker', 'stop', '--timeout', '10', '--', container]);
  });

  it('restart likewise', () => {
    const command = dockerRestart({ container, timeoutSeconds: 0 });

    expect(command.name).toBe('docker.restart');
    expect(command.argv).toEqual(['docker', 'restart', '--timeout', '0', '--', container]);
  });

  it.each([-1, 301, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects timeoutSeconds %s with a RangeError',
    (timeoutSeconds) => {
      expect(() => dockerStop({ container, timeoutSeconds })).toThrow(RangeError);
      expect(() => dockerRestart({ container, timeoutSeconds })).toThrow(RangeError);
    },
  );

  it('accepts the 300 s upper bound', () => {
    expect(dockerStop({ container, timeoutSeconds: 300 }).argv).toContain('300');
  });
});

describe('dockerLogs', () => {
  it('tails with timestamps', () => {
    const command = dockerLogs({ container, tail: 1000, follow: false });

    expect(command.name).toBe('docker.logs');
    expect(command.argv).toEqual([
      'docker',
      'logs',
      '--tail',
      '1000',
      '--timestamps',
      '--',
      container,
    ]);
  });

  it('adds --follow when asked', () => {
    expect(dockerLogs({ container, tail: 1, follow: true }).argv).toEqual([
      'docker',
      'logs',
      '--tail',
      '1',
      '--timestamps',
      '--follow',
      '--',
      container,
    ]);
  });

  it.each([0, 10_001, 2.5, Number.NaN])('rejects tail %s with a RangeError', (tail) => {
    expect(() => dockerLogs({ container, tail, follow: false })).toThrow(RangeError);
  });

  it('makes only the follow form supervisable (ADR 0008: it must be killable by group)', () => {
    expect(dockerLogs({ container, tail: 10, follow: true }).supervisable).toBe(true);
    expect(dockerLogs({ container, tail: 10, follow: false }).supervisable).toBe(false);
  });

  it('keeps stdin closed in both forms', () => {
    expect(dockerLogs({ container, tail: 10, follow: true }).stdin).toBe('none');
    expect(dockerLogs({ container, tail: 10, follow: false }).stdin).toBe('none');
  });

  it('accepts the 10000 upper bound', () => {
    expect(dockerLogs({ container, tail: 10_000, follow: false }).argv).toContain('10000');
  });
});

describe('dockerBuilderPrune (14-10, D12)', () => {
  it('is the fixed age-based prune: forced, until=168h, no free strings, no --all', () => {
    const command = dockerBuilderPrune();

    expect(command.name).toBe('docker.builder_prune');
    expect(command.argv).toEqual(['docker', 'builder', 'prune', '--force', '--filter', 'until=168h']);
    expect(command.argv).not.toContain('--all');
    expect(command.stdin).toBe('none');
    expect(command.supervisable).toBe(false);
  });

  it('takes no arguments, so no caller string can reach the command', () => {
    expect(dockerBuilderPrune.length).toBe(0);
  });
});

describe('dockerPs', () => {
  // ADR 0008 G4, verbatim.
  const ADR_0008_G4 =
    "docker ps --all --no-trunc --size=false --filter label=noodara.managed=true --format '{{json .}}'";

  it('parses to the same words as the ADR 0008 G4 command', () => {
    const command = dockerPs();

    expect(command.name).toBe('docker.ps');
    expect(command.argv).toEqual(shellWords(ADR_0008_G4));
    expect(shellWords(renderRemoteCommand(command))).toEqual(shellWords(ADR_0008_G4));
    expect(command.argv).toContain('--size=false');
  });
});

// Representative call of every docker builder, for the forbidden-flag guard and the round-trip.
function everyDockerCommand(values: {
  readonly container: ContainerName;
  readonly network: NetworkName;
  readonly image: ImageRef;
  readonly config: DockerConfigDir;
  readonly host: RegistryHost;
  readonly username: RegistryUsername;
  readonly path: RepoBuildPath;
  readonly target: BuildTarget;
  readonly id: ResourceId;
}): RemoteCommand[] {
  const v = values;
  return [
    dockerLogin({ config: v.config, host: v.host, username: v.username }),
    dockerLogout({ config: v.config, host: v.host }),
    dockerPull({ config: v.config, image: v.image }),
    dockerPull({ config: null, image: v.image }),
    dockerBuild({
      contextPath: v.path,
      dockerfilePath: v.path,
      image: v.image,
      target: v.target,
      serviceId: v.id,
      deploymentId: v.id,
    }),
    dockerImageRemove(v.image),
    dockerNetworkCreate({ network: v.network, serviceId: v.id }),
    dockerNetworkRemove(v.network),
    dockerCreate({
      container: v.container,
      network: v.network,
      image: v.image,
      internalPort: port(80),
      publishedPort: port(8080),
      serviceId: v.id,
      deploymentId: v.id,
    }),
    dockerStart(v.container),
    dockerStop({ container: v.container, timeoutSeconds: 10 }),
    dockerRestart({ container: v.container, timeoutSeconds: 10 }),
    dockerRemove(v.container),
    dockerInspectState(v.container),
    dockerLogs({ container: v.container, tail: 100, follow: true }),
    dockerPs(),
    dockerKill(v.container),
    dockerBuilderPrune(),
  ];
}

const FORBIDDEN_EXACT = new Set(['-e', '-v', '--pid', '--volume', '--mount', '--privileged']);
const FORBIDDEN_PREFIXES = [
  '--build-arg',
  '--env',
  '--env-file',
  '--privileged',
  '--cap-add',
  '--volume',
  '--mount',
  '--pid',
  '--network=host',
  '--net=host',
  '--security-opt',
  '--device',
  '--userns',
  '--ipc',
  '--uts',
];

describe('forbidden-flag guard (DEP-08, D13, T-11-36)', () => {
  const representative = everyDockerCommand({
    container,
    network,
    image,
    config: ws.dockerConfigDir,
    host,
    username,
    path: contextPath,
    target,
    id: serviceId,
  });

  it('covers every docker.* deploy template', () => {
    const names = new Set(representative.map((command) => command.name));

    expect([...names].sort()).toEqual(
      commands.DEPLOY_COMMAND_NAMES.filter((name) => name.startsWith('docker.')).sort(),
    );
  });

  it.each(representative.map((command) => [command.name, command] as const))(
    '%s emits no forbidden flag',
    (_, command) => {
      command.argv.forEach((token, index) => {
        expect(FORBIDDEN_EXACT.has(token), token).toBe(false);
        for (const prefix of FORBIDDEN_PREFIXES) {
          expect(token.startsWith(prefix), `${token} starts with ${prefix}`).toBe(false);
        }
        if (token === '--network' || token === '--net') {
          expect(command.argv[index + 1]).not.toBe('host');
        }
      });
    },
  );
});

describe('POSIX round-trip of force-cast adversarial values (T-11-34)', () => {
  it.each(ADVERSARIAL_VALUES)('every docker builder keeps %j as literal words', (value) => {
    const commandsWithValue = everyDockerCommand({
      container: value as ContainerName,
      network: value as NetworkName,
      image: value as ImageRef,
      config: value as DockerConfigDir,
      host: value as RegistryHost,
      username: value as RegistryUsername,
      path: value as RepoBuildPath,
      target: value as BuildTarget,
      id: value as ResourceId,
    });

    for (const command of commandsWithValue) {
      expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
    }
  });
});

describe('commands barrel', () => {
  it('re-exports the deploy builders and registry but never createRemoteCommand', () => {
    expect(commands).toHaveProperty('dockerBuild');
    expect(commands).toHaveProperty('gitClone');
    expect(commands).toHaveProperty('supervise');
    expect(commands).toHaveProperty('renderRemoteCommand');
    expect(commands).toHaveProperty('SHELL_SCRIPTS');
    expect(commands).toHaveProperty('DEPLOY_COMMAND_NAMES');
    expect(commands).not.toHaveProperty('createRemoteCommand');
  });
});
