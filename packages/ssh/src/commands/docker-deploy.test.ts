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
  validateImageRef,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
  type BuildTarget,
  type ContainerName,
  type ContainerPort,
  type DeploySecretPath,
  type DockerConfigDir,
  type ImageRef,
  type NetworkName,
  type RegistryHost,
  type RegistryUsername,
  type RepoBuildPath,
  type ResourceId,
  type ValidationResult,
} from '@noodara/domain/validators';
import { validateHealthcheckConfig } from '@noodara/domain/deployment';
import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_VALUES, shellWords } from '../testing/shell-round-trip.js';
import * as commands from './index.js';
import { dockerInspectStateSample, dockerLogsWindow, dockerStatsSample } from './metrics.js';
import { proxyNetworkDisconnect } from './proxy.js';
import {
  dockerBuild,
  dockerCreate,
  envFileFor,
  dockerImageInspect,
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
  dockerInspectNetworks,
  dockerListServiceImages,
  dockerNetworkConnect,
  dockerRemovePrevious,
  dockerRemoveServiceImage,
  dockerRenameFromPrevious,
  dockerRenameToPrevious,
  dockerStartPrevious,
  dockerStopPrevious,
  previousContainerNameFor,
  probeHttp,
  probeTcp,
  validateContainerIp,
  PREV_STEP_TIMEOUT_SECONDS,
  PROBE_OUTPUT_MAX_BYTES,
  PROBE_SCRIPTS,
  type ContainerIp,
  type HttpHealthcheckConfig,
  type TcpHealthcheckConfig,
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

describe('dockerCreate envFile (22-01, ADR 0011 A4)', () => {
  const workspace = valid(deployWorkspaceFor(DEPLOYMENT_ID_TEXT));
  const base = {
    container,
    network,
    image,
    internalPort: port(3000),
    publishedPort: null,
    serviceId,
    deploymentId,
  } as const;

  it('envFileFor is <workspace>/secrets/env', () => {
    expect(envFileFor(workspace)).toBe(`.noodara/deploy/${DEPLOYMENT_ID_TEXT}/secrets/env`);
  });

  it('renders --env-file <path> after the log options and before the labels', () => {
    const argv = [...dockerCreate({ ...base, envFile: envFileFor(workspace) }).argv];
    const at = argv.indexOf('--env-file');
    expect(argv[at + 1]).toBe(envFileFor(workspace));
    expect(argv[at - 1]).toBe('max-file=3');
    expect(argv.filter((token) => token === '--env-file')).toHaveLength(1);
    expect(argv.slice(-2)).toEqual(['--', image]);
  });

  it('is unchanged when envFile is omitted', () => {
    expect(dockerCreate(base).argv).not.toContain('--env-file');
  });

  it.each([
    '/etc/passwd',
    `.noodara/deploy/${DEPLOYMENT_ID_TEXT}/repo/.env`,
    `.noodara/deploy/${DEPLOYMENT_ID_TEXT}/secrets/../repo/env`,
    `.noodara/deploy/${DEPLOYMENT_ID_TEXT}/secrets/deploy_key`,
    `.noodara/deploy/${DEPLOYMENT_ID_TEXT}/secrets/env;id`,
    `.noodara/deploy/not-a-uuid/secrets/env`,
    '--privileged',
  ])('A2: rejects env-file path %j outside <workspace>/secrets/env', (path) => {
    expect(() => dockerCreate({ ...base, envFile: path as DeploySecretPath })).toThrow(RangeError);
  });

  it('envFileFor refuses a forged workspace', () => {
    expect(() =>
      envFileFor({ ...workspace, secretsDir: '/tmp/secrets' as DeploySecretPath }),
    ).toThrow();
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

/** 17-01: every service-scoped docker.* template, derived from a service id only. */
function everyServiceScopedDockerCommand(id: ResourceId): RemoteCommand[] {
  return [
    dockerInspectNetworks({ serviceId: id, container: 'current' }),
    dockerNetworkConnect(id),
    proxyNetworkDisconnect(id),
    dockerRenameToPrevious(id),
    dockerRenameFromPrevious(id),
    dockerStartPrevious(id),
    dockerStopPrevious({ serviceId: id, timeoutSeconds: 10 }),
    dockerRemovePrevious(id),
    dockerListServiceImages(id),
    dockerRemoveServiceImage({ serviceId: id, deploymentId }),
    // 27-01: observability probes.
    dockerStatsSample({ serviceId: id }),
    dockerInspectStateSample({ serviceId: id }),
    dockerLogsWindow({ serviceId: id, since: '2026-01-01T00:00:00Z', tail: 10 }),
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
  }).concat(everyServiceScopedDockerCommand(serviceId), [dockerImageInspect(image)]);

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

// --- 17-01 (ADR 0010): healthcheck probes, the -prev container and per-service images ----------

// ADR 0010 A1/H1/H2 text, copied by hand from contracts-v03.test.ts. Changing a probe script must
// update the contract test, the ADR and this copy in the same plan.
const DOLLAR_SIGN = String.fromCharCode(36);
const ADR_0010_HTTP_PROBE = [
  '{ exec 3<>"/dev/tcp/$1/$2"; } 2>/dev/null || { echo "NOODARA_PROBE refused"; exit 0; }',
  String.raw`printf 'GET %s HTTP/1.0\r\nHost: %s:%s\r\nUser-Agent: noodara-healthcheck/1\r\nAccept: */*\r\nConnection: close\r\n\r\n' "$3" "$1" "$2" >&3 2>/dev/null || { echo "NOODARA_PROBE error"; exit 0; }`,
  'IFS= read -r -n 64 line <&3 || [ -n "$line" ] || { echo "NOODARA_PROBE empty"; exit 0; }',
  `line=${DOLLAR_SIGN}{line%$'\\r'}`,
  'case $line in',
  `  "HTTP/1."[01]" "[1-5][0-9][0-9]|"HTTP/1."[01]" "[1-5][0-9][0-9]" "*) echo "NOODARA_PROBE http ${DOLLAR_SIGN}{line:9:3}" ;;`,
  '  *) echo "NOODARA_PROBE malformed" ;;',
  'esac',
].join('\n');
const ADR_0010_TCP_PROBE =
  '{ exec 3<>"/dev/tcp/$1/$2"; } 2>/dev/null && echo "NOODARA_PROBE open" || echo "NOODARA_PROBE refused"';
const PROBE_WRAPPER = (seconds: number): string[] => [
  'env',
  '-i',
  'PATH=/usr/bin:/bin',
  'timeout',
  '-k',
  '1',
  String(seconds),
  'bash',
  '--noprofile',
  '--norc',
  '-c',
];

const ip = valid(validateContainerIp('172.18.0.2'));
const PREV = `noodara-${SERVICE_ID_TEXT}-prev`;

function httpConfig(fields: Record<string, unknown> = {}): HttpHealthcheckConfig {
  const config = valid(
    validateHealthcheckConfig({
      type: 'http',
      path: '/health',
      port: 3000,
      probeTimeoutS: 5,
      intervalS: 5,
      retries: 3,
      startPeriodS: 0,
      ...fields,
    }),
  );
  if (config.type !== 'http') throw new Error('fixture must be an http healthcheck');
  return config;
}

function tcpConfig(fields: Record<string, unknown> = {}): TcpHealthcheckConfig {
  const config = valid(
    validateHealthcheckConfig({
      type: 'tcp',
      port: 5432,
      probeTimeoutS: 2,
      intervalS: 5,
      retries: 3,
      startPeriodS: 0,
      ...fields,
    }),
  );
  if (config.type !== 'tcp') throw new Error('fixture must be a tcp healthcheck');
  return config;
}

describe('validateContainerIp (ADR 0010 A1: the IP read from docker inspect)', () => {
  it.each(['172.18.0.2', '10.0.0.5', '192.168.255.254', '1.2.3.4'])('accepts %s', (value) => {
    expect(validateContainerIp(value)).toEqual({ ok: true, value });
  });

  it.each([
    '',
    '0.0.0.0',
    '127.0.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '172.18.0.256',
    '172.18.0',
    '172.018.0.2',
    ' 172.18.0.2',
    '172.18.0.2\n',
    'fe80::1',
    'localhost',
    '172.18.0.2; id',
  ])('rejects %j with CONTAINER_IP_INVALID', (value) => {
    expect(validateContainerIp(value)).toMatchObject({ ok: false, code: 'CONTAINER_IP_INVALID' });
  });
});

describe('PROBE_SCRIPTS (ADR 0010 A1/H1/H2)', () => {
  it('is frozen and equals the ADR 0010 contract text', () => {
    expect(Object.isFrozen(PROBE_SCRIPTS)).toBe(true);
    expect(Object.keys(PROBE_SCRIPTS).sort()).toEqual(['http', 'tcp']);
    expect(PROBE_SCRIPTS.http).toBe(ADR_0010_HTTP_PROBE);
    expect(PROBE_SCRIPTS.tcp).toBe(ADR_0010_TCP_PROBE);
  });

  it('reads at most 64 bytes (the status line) and never echoes the line itself (A4, H2)', () => {
    expect(PROBE_SCRIPTS.http).toContain('read -r -n 64 line');
    // Only fixed words and the three status digits ever reach stdout.
    const echoes = [...PROBE_SCRIPTS.http.matchAll(/echo "([^"]*)"/g)].map((m) => m[1]);
    expect(echoes).toEqual([
      'NOODARA_PROBE refused',
      'NOODARA_PROBE error',
      'NOODARA_PROBE empty',
      `NOODARA_PROBE http ${DOLLAR_SIGN}{line:9:3}`,
      'NOODARA_PROBE malformed',
    ]);
    expect(PROBE_SCRIPTS.http).not.toMatch(/\bcat\b|\bcurl\b|\bwget\b|Location/);
  });

  it.each(Object.entries(PROBE_SCRIPTS))(
    '%s references only $1-$3 and its own local, never command substitution or a backtick',
    (_, script) => {
      expect(script.includes(`${DOLLAR_SIGN}(`)).toBe(false);
      expect(script.includes(String.fromCharCode(96))).toBe(false);
      const names = [...script.matchAll(/[$]\{?([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g)].map(
        (m) => m[1],
      );
      for (const name of names) expect(['1', '2', '3', 'line'], name).toContain(name);
    },
  );
});

describe('probeHttp / probeTcp (ADR 0010 A1/H1)', () => {
  it('http: the env -i + timeout + bash --noprofile --norc wrapper, then ip, port and path as positionals', () => {
    const command = probeHttp({ ip, config: httpConfig() });

    expect(command.name).toBe('probe.http');
    expect(command.stdin).toBe('none');
    expect(command.supervisable).toBe(false);
    expect(command.argv).toEqual([
      ...PROBE_WRAPPER(5),
      PROBE_SCRIPTS.http,
      'noodara-probe',
      '172.18.0.2',
      '3000',
      '/health',
    ]);
    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });

  it('tcp: the same wrapper, ip and port only', () => {
    const command = probeTcp({ ip, config: tcpConfig() });

    expect(command.name).toBe('probe.tcp');
    expect(command.argv).toEqual([
      ...PROBE_WRAPPER(2),
      PROBE_SCRIPTS.tcp,
      'noodara-probe',
      '172.18.0.2',
      '5432',
    ]);
  });

  it('the hard cap is the probe timeout itself (1-30 s), with a 1 s kill grace', () => {
    expect(probeHttp({ ip, config: httpConfig({ probeTimeoutS: 1 }) }).argv.slice(3, 7)).toEqual([
      'timeout',
      '-k',
      '1',
      '1',
    ]);
    expect(probeTcp({ ip, config: tcpConfig({ probeTimeoutS: 30 }) }).argv[6]).toBe('30');
  });

  it('keeps a validated path with a query string as one literal word', () => {
    const command = probeHttp({ ip, config: httpConfig({ path: '/healthz?full=1,x=%20+y=@' }) });

    expect(command.argv.at(-1)).toBe('/healthz?full=1,x=%20+y=@');
    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });

  it('exports the probe output budget (A4): 1 KiB', () => {
    expect(PROBE_OUTPUT_MAX_BYTES).toBe(1024);
  });
});

describe('probe templates reject every other shape (A2)', () => {
  const base = httpConfig();
  const PATHS = [
    '/health;id',
    '/health && id',
    '/health|id',
    `/${DOLLAR_SIGN}(id)`,
    `/${String.fromCharCode(96)}id${String.fromCharCode(96)}`,
    `/${DOLLAR_SIGN}{HOME}`,
    "/a'b",
    '/a"b',
    '/a b',
    '/a\nb',
    '/a\rb',
    '/a\\b',
    '/a>b',
    '/a<b',
    '/a*',
    'health',
    'http://evil/health',
    '/../etc',
    '',
  ];

  it.each(PATHS)('a force-cast path %j throws before any command exists', (path) => {
    expect(() => probeHttp({ ip, config: { ...base, path } })).toThrow(RangeError);
  });

  it.each(ADVERSARIAL_VALUES)('a force-cast ip %j throws', (value) => {
    expect(() => probeHttp({ ip: value as ContainerIp, config: base })).toThrow(RangeError);
    expect(() => probeTcp({ ip: value as ContainerIp, config: tcpConfig() })).toThrow(RangeError);
  });

  it.each([
    ['probeTimeoutS 0', { probeTimeoutS: 0 }],
    ['probeTimeoutS 31', { probeTimeoutS: 31 }],
    ['probeTimeoutS 1.5', { probeTimeoutS: 1.5 }],
    ['port 0', { port: 0 }],
    ['port 65536', { port: 65536 }],
    ['port as a string', { port: '3000; id' }],
    ['an unknown key', { headers: { Cookie: 'x' } }],
    ['another type', { type: 'tcp' }],
  ] as const)('an http config with %s throws', (_label, fields) => {
    expect(() =>
      probeHttp({ ip, config: { ...base, ...fields } as unknown as HttpHealthcheckConfig }),
    ).toThrow(RangeError);
  });

  it('a tcp builder refuses an http config and vice versa', () => {
    expect(() => probeTcp({ ip, config: base as unknown as TcpHealthcheckConfig })).toThrow(
      RangeError,
    );
    expect(() =>
      probeHttp({ ip, config: tcpConfig() as unknown as HttpHealthcheckConfig }),
    ).toThrow(RangeError);
  });
});

describe('the -prev container (ADR 0010 A2, H1)', () => {
  const BOUND = ['timeout', '-k', '1', String(PREV_STEP_TIMEOUT_SECONDS)];

  it('previousContainerNameFor derives noodara-<serviceId>-prev', () => {
    expect(previousContainerNameFor(serviceId)).toBe(PREV);
  });

  it.each([
    [
      'docker.rename_to_prev',
      () => dockerRenameToPrevious(serviceId),
      [...BOUND, 'docker', 'rename', '--', container, PREV],
    ],
    [
      'docker.rename_from_prev',
      () => dockerRenameFromPrevious(serviceId),
      [...BOUND, 'docker', 'rename', '--', PREV, container],
    ],
    [
      'docker.start_prev',
      () => dockerStartPrevious(serviceId),
      [...BOUND, 'docker', 'start', '--', PREV],
    ],
    [
      'docker.remove_prev',
      () => dockerRemovePrevious(serviceId),
      [...BOUND, 'docker', 'rm', '--', PREV],
    ],
    [
      'docker.network_connect',
      () => dockerNetworkConnect(serviceId),
      [...BOUND, 'docker', 'network', 'connect', '--', network, container],
    ],
    [
      'docker.inspect_networks',
      () => dockerInspectNetworks({ serviceId, container: 'current' }),
      [
        ...BOUND,
        'docker',
        'inspect',
        '--type',
        'container',
        '--format',
        '{{json .NetworkSettings.Networks}}',
        '--',
        container,
      ],
    ],
  ] as const)('%s has the exact bounded argv', (name, build, argv) => {
    const command = build();

    expect(command.name).toBe(name);
    expect(command.stdin).toBe('none');
    expect(command.supervisable).toBe(false);
    expect(command.argv).toEqual(argv);
    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });

  it('docker.inspect_networks can target the -prev container', () => {
    expect(dockerInspectNetworks({ serviceId, container: 'previous' }).argv.at(-1)).toBe(PREV);
  });

  it('docker.stop_prev bounds the stop timeout plus the fixed step budget', () => {
    expect(dockerStopPrevious({ serviceId, timeoutSeconds: 10 }).argv).toEqual([
      'timeout',
      '-k',
      '1',
      String(10 + PREV_STEP_TIMEOUT_SECONDS),
      'docker',
      'stop',
      '--timeout',
      '10',
      '--',
      PREV,
    ]);
    expect(() => dockerStopPrevious({ serviceId, timeoutSeconds: 301 })).toThrow(RangeError);
    expect(() => dockerStopPrevious({ serviceId, timeoutSeconds: -1 })).toThrow(RangeError);
  });

  it('H1: no -prev template can overwrite or silently remove another version', () => {
    const all = [
      dockerRenameToPrevious(serviceId),
      dockerRenameFromPrevious(serviceId),
      dockerStartPrevious(serviceId),
      dockerStopPrevious({ serviceId, timeoutSeconds: 10 }),
      dockerRemovePrevious(serviceId),
    ];
    for (const command of all) {
      expect(command.argv).not.toContain('--force');
      expect(command.argv).not.toContain('-f');
    }
    // Only docker.remove_prev removes, and only the -prev name.
    const removing = all.filter((command) => command.argv.includes('rm'));
    expect(removing.map((command) => command.argv.at(-1))).toEqual([PREV]);
  });

  it.each(ADVERSARIAL_VALUES)('a force-cast serviceId %j throws before any command exists', (value) => {
    const id = value as ResourceId;
    expect(() => dockerRenameToPrevious(id)).toThrow(RangeError);
    expect(() => dockerRenameFromPrevious(id)).toThrow(RangeError);
    expect(() => dockerStartPrevious(id)).toThrow(RangeError);
    expect(() => dockerStopPrevious({ serviceId: id, timeoutSeconds: 5 })).toThrow(RangeError);
    expect(() => dockerRemovePrevious(id)).toThrow(RangeError);
    expect(() => dockerNetworkConnect(id)).toThrow(RangeError);
    expect(() => dockerInspectNetworks({ serviceId: id, container: 'previous' })).toThrow(
      RangeError,
    );
    expect(() => dockerListServiceImages(id)).toThrow(RangeError);
    expect(() => dockerRemoveServiceImage({ serviceId: id, deploymentId })).toThrow(RangeError);
    expect(() => dockerRemoveServiceImage({ serviceId, deploymentId: id })).toThrow(RangeError);
  });
});

describe("the service's own images (17-01, retention)", () => {
  it('docker.image_list_service lists only noodara/<serviceId> images carrying its label, as NDJSON', () => {
    const command = dockerListServiceImages(serviceId);

    expect(command.name).toBe('docker.image_list_service');
    expect(command.argv).toEqual([
      'docker',
      'image',
      'ls',
      '--no-trunc',
      '--filter',
      `reference=noodara/${SERVICE_ID_TEXT}`,
      '--filter',
      `label=noodara.service_id=${SERVICE_ID_TEXT}`,
      '--format',
      '{{json .}}',
    ]);
  });

  it('docker.image_remove_service removes only noodara/<serviceId>:<deploymentId>, never forced', () => {
    const command = dockerRemoveServiceImage({ serviceId, deploymentId });

    expect(command.name).toBe('docker.image_remove_service');
    expect(command.argv).toEqual(['docker', 'image', 'rm', '--', image]);
  });
});

describe('docker.image_inspect (17-05: a rollback target must still be on the server)', () => {
  const BOUND = ['timeout', '-k', '1', String(PREV_STEP_TIMEOUT_SECONDS)];

  it('prints only the image id, bounded by the fixed step budget, with `--` before the ref', () => {
    const command = dockerImageInspect(image);

    expect(command.name).toBe('docker.image_inspect');
    expect(command.stdin).toBe('none');
    expect(command.supervisable).toBe(false);
    expect(command.argv).toEqual([
      ...BOUND,
      'docker',
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      '--',
      image,
    ]);
    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });

  it('accepts any valid image ref (a pulled image source), not only noodara/<serviceId>', () => {
    const pulled = valid(validateImageRef('ghcr.io/acme/api:1.2.3'));

    expect(dockerImageInspect(pulled).argv.at(-1)).toBe('ghcr.io/acme/api:1.2.3');
  });

  it('never forces, removes or pulls anything', () => {
    const argv = dockerImageInspect(image).argv;

    for (const token of ['--force', '-f', 'rm', 'pull', 'run', 'create']) {
      expect(argv).not.toContain(token);
    }
  });

  it.each([...ADVERSARIAL_VALUES, '', '--help', 'nginx', '-rf:1'])(
    'a force-cast image %j throws before any command exists',
    (value) => {
      expect(() => dockerImageInspect(value as ImageRef)).toThrow(RangeError);
    },
  );

  it('is re-exported from the commands barrel', () => {
    expect(commands).toHaveProperty('dockerImageInspect');
  });
});
