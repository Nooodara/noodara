// Deploy-engine fixture stack (11-03-PLAN.md Task 2; D-10, D-11, D-12, D-14, G7). One call yields:
//   - a privileged Ubuntu deploy host (sshd + nested dockerd with install.sh's Docker packages),
//     reachable over real SSH as `deployer`, also serving bare Git repositories to a per-run
//     deploy key under a D-06-valid alias;
//   - the D-10 htpasswd registry, preloaded with the fixtures' digest-pinned base images;
//   - the G7 pull-through mirror the nested dockerd uses for docker.io;
//   - optionally (12-06) an HTTPS git host: git-http-backend behind nginx basic auth, its per-run
//     CA trusted by the deploy host, for the askpass HTTPS-token clone contract.
// Everything carries `noodara.test=true` and stop() removes it all (D-14).
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type ExecOptions,
  type StartedTestContainer,
} from 'testcontainers';
import { generateDeployKeyPair, type DeployKeyPair } from './deploy-keys.js';
import {
  MIRROR_ALIAS,
  REGISTRY_ALIAS,
  generateRegistryCredentials,
  startAuthRegistry,
  startBaseImageMirror,
  type StartedMirror,
  type StartedRegistry,
} from './registry.js';
import type { UbuntuVersion } from './ssh.js';

export type { UbuntuVersion } from './ssh.js';
export { MIRROR_ALIAS, REGISTRY_ALIAS } from './registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_CONTEXT = path.resolve(HERE, '../images');
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');

export const DEPLOY_HOST_ALIAS = 'deploy-host.noodara-test.internal';
export const GIT_HOST_ALIAS = 'git.noodara-test.internal';
export const GIT_HTTPS_HOST_ALIAS = 'git-https.noodara-test.internal';
/** The user name the askpass helper answers (ASKPASS_SCRIPT_CONTENT). */
export const GIT_HTTPS_USERNAME = 'x-access-token';
export const DEPLOY_HOST_READY_LINE = 'NOODARA_DEPLOY_HOST_READY';

/** Used until 11-04 lands fixtures/*\/Dockerfile. Index digests resolved on 2026-09-29. */
const DEFAULT_BASE_IMAGES = [
  'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402',
  'nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2',
] as const;

const BUILD_TIMEOUT_MS = 900_000;
const STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const IMAGE_TRANSFER_TIMEOUT_MS = 600_000;
const HOST_CLI_TIMEOUT_MS = 60_000;
const SEED_COMMIT_DATE = '2026-01-01T00:00:00Z';
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

function parseUbuntuSelection(raw: string | undefined): readonly UbuntuVersion[] {
  if (raw === undefined || raw === '' || raw === 'all') return ['22.04', '24.04'];
  if (raw === '22.04' || raw === '24.04') return [raw];
  throw new Error(`NOODARA_TEST_UBUNTU must be '22.04', '24.04' or 'all' (got '${raw}')`);
}

/** D-11: 24.04 on PRs, both on main and nightly; selected by NOODARA_TEST_UBUNTU. */
export const DEPLOY_ENGINE_UBUNTU_VERSIONS: readonly UbuntuVersion[] = parseUbuntuSelection(
  process.env['NOODARA_TEST_UBUNTU'],
);

export interface SeedRepository {
  readonly name: string;
  /** Absolute host path committed as a single commit on `branch`. */
  readonly sourceDir: string;
  readonly branch?: string;
  readonly withGitmodules?: boolean;
  readonly withLfsPointer?: boolean;
}

export interface StartDeployEngineStackOptions {
  readonly ubuntu: UbuntuVersion;
  readonly seedRepositories?: readonly SeedRepository[];
  /** 12-06: also serve every seed repository over HTTPS with a per-run token. */
  readonly httpsGit?: boolean;
  /**
   * 13-06: extra labels (e.g. a run-scoped `noodara.e2e.run=<id>`) added to the network, the
   * dockerd volume and every container this module builds itself. The registry and mirror join the
   * labelled network, so a sweep by network membership reaches them too.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface HttpsGitHost {
  /** Per-run random token; the only accepted password for GIT_HTTPS_USERNAME. */
  readonly token: string;
  repoUrl(name: string): string;
}

export interface StackExecOptions {
  readonly user?: string;
  /** Delivered through a 0600 temp file redirected to stdin; never argv, never env. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface StackExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeployEngineStack {
  readonly ubuntu: UbuntuVersion;
  readonly ssh: {
    readonly host: string;
    readonly port: number;
    readonly user: 'deployer';
    readonly privateKey: string;
  };
  readonly deployKey: DeployKeyPair;
  readonly registry: {
    readonly host: string;
    readonly username: string;
    readonly password: string;
  };
  gitRepoUrl(name: string): string;
  /** null unless started with `httpsGit: true`. */
  readonly httpsGit: HttpsGitHost | null;
  /** Digest-pinned refs, e.g. node:22-alpine@sha256:... */
  readonly baseImages: readonly string[];
  /** Upstream the G7 mirror proxies (mirror.gcr.io, or the Docker Hub fallback). */
  readonly mirrorUpstream: string;
  /** The per-run bridge network every container of this stack joins. */
  readonly networkName: string;
  exec(command: readonly string[], options?: StackExecOptions): Promise<StackExecResult>;
  /** Idempotent. */
  stop(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`deploy-engine: ${label} timed out after ${String(ms)}ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function hostDocker(args: readonly string[]): void {
  execFileSync('docker', [...args], { stdio: 'ignore', timeout: HOST_CLI_TIMEOUT_MS });
}

/** FROM lines pinned by digest in fixtures/*\/Dockerfile; defaults until those fixtures exist. */
export function resolveBaseImages(): readonly string[] {
  const found = new Set<string>();
  if (existsSync(FIXTURES_DIR)) {
    for (const entry of readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
      const dockerfile = path.join(FIXTURES_DIR, entry.name, 'Dockerfile');
      if (!entry.isDirectory() || !existsSync(dockerfile)) continue;
      for (const match of readFileSync(dockerfile, 'utf8').matchAll(
        /^FROM\s+(\S+@sha256:[0-9a-f]{64})/gim,
      )) {
        if (match[1] !== undefined) found.add(match[1]);
      }
    }
  }
  return found.size > 0 ? [...found] : [...DEFAULT_BASE_IMAGES];
}

/** `node:22-alpine@sha256:...` -> `<registry>/fixtures/node:22-alpine` */
export function preloadedRefFor(registryHost: string, baseImage: string): string {
  return `${registryHost}/fixtures/${baseImage.split('@')[0] ?? baseImage}`;
}

const SEED_SCRIPT = `set -eu
name=$1; branch=$2; gitmodules=$3; lfs=$4; lfs_oid=$5
work=/tmp/noodara-seed-$name
bare=/srv/git/$name.git
cd "$work"
git init -q -b "$branch" .
if [ "$gitmodules" = 1 ]; then
  printf '[submodule "vendor/sub"]\\n\\tpath = vendor/sub\\n\\turl = https://example.invalid/sub.git\\n' > .gitmodules
fi
if [ "$lfs" = 1 ]; then
  printf '*.bin filter=lfs diff=lfs merge=lfs -text\\n' > .gitattributes
  printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize 12\\n' "$lfs_oid" > blob.bin
fi
git add -A
if [ "$gitmodules" = 1 ]; then
  git update-index --add --cacheinfo 160000,0123456789abcdef0123456789abcdef01234567,vendor/sub
fi
git -c user.name='Noodara Test' -c user.email=test@noodara.invalid -c commit.gpgsign=false commit -q -m seed
git init -q --bare -b "$branch" "$bare"
git push -q "$bare" "$branch:refs/heads/$branch"
chown -R git:git "$bare"
rm -rf "$work"
`;

const LFS_POINTER_OID = 'a'.repeat(64);

// 12-06 HTTPS git host. nginx (pinned by index digest) terminates TLS with a leaf signed by a CA
// generated at container start, checks basic auth against an apr1 hash of the per-run token
// (delivered as a 0600 file, never argv or env, deleted once hashed) and hands /git/* to
// git-http-backend through fcgiwrap. Everything runs as `git`, which owns the bare repositories.
const GIT_HTTPS_BASE_IMAGE =
  'nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2';
const GIT_HTTPS_READY_LINE = 'NOODARA_GIT_HTTPS_READY';
const GIT_HTTPS_CA_TARGET = '/usr/local/share/ca-certificates/noodara-test-git-https.crt';

const GIT_HTTPS_DOCKERFILE = `FROM ${GIT_HTTPS_BASE_IMAGE}
RUN apk add --no-cache git git-daemon fcgiwrap openssl \\
    && addgroup -S git && adduser -S -D -H -G git -s /sbin/nologin git \\
    && mkdir -p /srv/git /run/fcgi /certs /auth \\
    && chown git:git /srv/git /run/fcgi \\
    && test -x /usr/libexec/git-core/git-http-backend
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /usr/local/bin/noodara-git-https
RUN chmod 0755 /usr/local/bin/noodara-git-https
ENTRYPOINT ["/usr/local/bin/noodara-git-https"]
`;

const GIT_HTTPS_NGINX_CONF = `user git git;
worker_processes 1;
error_log /dev/stderr warn;
pid /run/nginx.pid;
events { worker_connections 64; }
http {
  access_log /dev/stdout;
  server {
    listen 443 ssl;
    ssl_certificate /certs/server.crt;
    ssl_certificate_key /certs/server.key;
    client_max_body_size 0;
    location ~ ^/git(/.*)$ {
      auth_basic "noodara-test";
      auth_basic_user_file /auth/htpasswd;
      include /etc/nginx/fastcgi_params;
      fastcgi_param SCRIPT_FILENAME /usr/libexec/git-core/git-http-backend;
      fastcgi_param GIT_PROJECT_ROOT /srv/git;
      fastcgi_param GIT_HTTP_EXPORT_ALL 1;
      fastcgi_param PATH_INFO $1;
      fastcgi_param REMOTE_USER $remote_user;
      fastcgi_pass unix:/run/fcgi/fcgiwrap.sock;
    }
  }
}
`;

const GIT_HTTPS_ENTRYPOINT = `#!/bin/sh
set -eu
host_name=$1; user_name=$2
cd /certs
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \\
  -subj /CN=noodara-test-git-https-ca -keyout ca.key -out ca.crt \\
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \\
  -subj "/CN=$host_name" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:%s\\nextendedKeyUsage=serverAuth\\nbasicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\n' "$host_name" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \\
  -extfile server.ext -out server.crt 2>/dev/null
rm -f ca.key ca.srl server.csr server.ext
chmod 0644 ca.crt server.crt
chmod 0600 server.key
hash=$(openssl passwd -apr1 -stdin < /auth/token)
rm -f /auth/token
printf '%s:%s\\n' "$user_name" "$hash" > /auth/htpasswd
chmod 0644 /auth/htpasswd
su -s /bin/sh git -c 'exec fcgiwrap -s unix:/run/fcgi/fcgiwrap.sock' &
i=0
while [ ! -S /run/fcgi/fcgiwrap.sock ] && [ "$i" -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
nginx
trap 'exit 0' TERM INT
echo ${GIT_HTTPS_READY_LINE}
while :; do sleep 1; done
`;

interface StartedHttpsGit {
  readonly container: StartedTestContainer;
  readonly caCertificate: string;
}

async function startHttpsGitHost(
  networkName: string,
  token: string,
  labels: Readonly<Record<string, string>>,
): Promise<StartedHttpsGit> {
  const context = mkdtempSync(path.join(tmpdir(), 'noodara-git-https-'));
  let image: GenericContainer;
  try {
    writeFileSync(path.join(context, 'Dockerfile'), GIT_HTTPS_DOCKERFILE);
    writeFileSync(path.join(context, 'nginx.conf'), GIT_HTTPS_NGINX_CONF);
    writeFileSync(path.join(context, 'entrypoint.sh'), GIT_HTTPS_ENTRYPOINT);
    image = await withTimeout(
      GenericContainer.fromDockerfile(context).build(),
      BUILD_TIMEOUT_MS,
      'build git-https host',
    );
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  const container = await image
    .withName(`noodara-git-https-${randomUUID()}`)
    .withLabels({ ...labels, 'noodara.test': 'true' })
    .withNetworkMode(networkName)
    .withNetworkAliases(GIT_HTTPS_HOST_ALIAS)
    .withCommand([GIT_HTTPS_HOST_ALIAS, GIT_HTTPS_USERNAME])
    .withCopyContentToContainer([{ content: token, target: '/auth/token', mode: 0o600 }])
    .withWaitStrategy(Wait.forLogMessage(GIT_HTTPS_READY_LINE))
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();
  try {
    const ca = await withTimeout(
      container.exec(['cat', '/certs/ca.crt']),
      DEFAULT_EXEC_TIMEOUT_MS,
      'read git-https CA',
    );
    if (ca.exitCode !== 0 || !ca.stdout.includes('BEGIN CERTIFICATE')) {
      throw new Error('deploy-engine: git-https host produced no CA certificate');
    }
    return { container, caCertificate: ca.stdout };
  } catch (error) {
    await container.stop();
    throw error;
  }
}

export async function startDeployEngineStack(
  options: StartDeployEngineStackOptions,
): Promise<DeployEngineStack> {
  const { ubuntu, seedRepositories = [], labels: extraLabels = {} } = options;
  const labels: Readonly<Record<string, string>> = { ...extraLabels, 'noodara.test': 'true' };
  for (const repo of seedRepositories) {
    if (!SAFE_NAME.test(repo.name))
      throw new Error(`deploy-engine: invalid seed repository name '${repo.name}'`);
    if (repo.branch !== undefined && !SAFE_BRANCH.test(repo.branch)) {
      throw new Error(`deploy-engine: invalid seed branch '${repo.branch}'`);
    }
    if (!path.isAbsolute(repo.sourceDir))
      throw new Error('deploy-engine: seed sourceDir must be absolute');
  }

  const cleanups: (() => Promise<void>)[] = [];
  const runCleanups = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'deploy-engine: cleanup failed');
  };

  try {
    const runId = randomUUID();
    const networkName = `noodara-deploy-engine-${runId}`;
    const client = await getContainerRuntimeClient();
    const network = await client.network.create({
      Name: networkName,
      Driver: 'bridge',
      Labels: { ...labels },
    });
    cleanups.push(async () => {
      await client.network.remove(network);
    });

    // Nested dockerd storage on a labelled volume (overlay on overlay is not viable), as in
    // installer-dind.ts.
    const volumeName = `noodara-deploy-engine-docker-${runId}`;
    hostDocker([
      'volume',
      'create',
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      volumeName,
    ]);
    cleanups.push(() => {
      hostDocker(['volume', 'rm', '-f', volumeName]);
      return Promise.resolve();
    });

    const [loginKey, deployKey] = await Promise.all([
      generateDeployKeyPair('noodara-test-login'),
      generateDeployKeyPair('noodara-test-deploy'),
    ]);

    const daemonJson = JSON.stringify({
      'insecure-registries': [`${REGISTRY_ALIAS}:5000`, `${MIRROR_ALIAS}:5000`],
      'registry-mirrors': [`http://${MIRROR_ALIAS}:5000`],
    });

    const startHost = async (): Promise<StartedTestContainer> => {
      const image = await withTimeout(
        GenericContainer.fromDockerfile(
          IMAGES_CONTEXT,
          `sshd-dockerd-ubuntu-${ubuntu}/Dockerfile`,
        ).build(),
        BUILD_TIMEOUT_MS,
        `build sshd-dockerd-ubuntu-${ubuntu}`,
      );
      const containerName = `noodara-deploy-host-${ubuntu}-${runId}`;
      try {
        return await image
          .withName(containerName)
          .withLabels({ ...labels })
          // Nested dockerd requires privileged mode; same accepted posture as installer-dind (T-11-09).
          .withPrivilegedMode()
          .withBindMounts([{ source: volumeName, target: '/var/lib/docker' }])
          .withNetworkMode(networkName)
          .withNetworkAliases(DEPLOY_HOST_ALIAS, GIT_HOST_ALIAS)
          .withEnvironment({
            NOODARA_TEST_LOGIN_PUBKEY: loginKey.publicKey,
            NOODARA_TEST_DEPLOY_PUBKEY: deployKey.publicKey,
            NOODARA_TEST_DOCKER_DAEMON_JSON: daemonJson,
          })
          .withExposedPorts(22)
          .withWaitStrategy(Wait.forLogMessage(DEPLOY_HOST_READY_LINE))
          .withStartupTimeout(STARTUP_TIMEOUT_MS)
          .start();
      } catch (error) {
        try {
          hostDocker(['rm', '-f', containerName]);
        } catch {
          // never created
        }
        throw error;
      }
    };

    const [hostResult, mirrorResult] = await Promise.allSettled([
      startHost(),
      startBaseImageMirror(networkName),
    ]);
    if (mirrorResult.status === 'fulfilled') {
      const mirror: StartedMirror = mirrorResult.value;
      cleanups.push(async () => {
        await mirror.container.stop();
      });
    }
    if (hostResult.status === 'fulfilled') {
      const started = hostResult.value;
      // Stops before the volume/network cleanups registered earlier (reverse order).
      cleanups.push(async () => {
        await started.stop();
      });
    }
    if (hostResult.status === 'rejected') throw hostResult.reason;
    if (mirrorResult.status === 'rejected') throw mirrorResult.reason;
    const host = hostResult.value;
    const mirror = mirrorResult.value;

    const rawExec = async (
      command: readonly string[],
      opts: { user?: string; env?: Record<string, string>; timeoutMs?: number } = {},
    ): Promise<StackExecResult> => {
      const execOptions: Partial<ExecOptions> = {};
      if (opts.user !== undefined) execOptions.user = opts.user;
      if (opts.env !== undefined) execOptions.env = opts.env;
      const result = await withTimeout(
        host.exec([...command], execOptions),
        opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        `exec ${command[0] ?? ''}`,
      );
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    };

    const exec = async (
      command: readonly string[],
      opts: StackExecOptions = {},
    ): Promise<StackExecResult> => {
      const base = {
        ...(opts.user === undefined ? {} : { user: opts.user }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      };
      if (opts.stdin === undefined) return rawExec(command, base);
      const stdinPath = `/tmp/noodara-stdin-${randomUUID()}`;
      await host.copyContentToContainer([{ content: opts.stdin, target: stdinPath, mode: 0o600 }]);
      try {
        if (opts.user !== undefined && opts.user !== 'root') {
          const chown = await rawExec(['chown', opts.user, stdinPath], { user: 'root' });
          if (chown.exitCode !== 0)
            throw new Error(`deploy-engine: chown stdin file failed: ${chown.stderr}`);
        }
        return await rawExec(
          ['sh', '-c', 'f=$1; shift; "$@" < "$f"', 'sh', stdinPath, ...command],
          base,
        );
      } finally {
        await rawExec(['rm', '-f', stdinPath], { user: 'root' });
      }
    };

    const mustExec = async (
      label: string,
      command: readonly string[],
      opts: StackExecOptions = {},
    ): Promise<string> => {
      const result = await exec(command, opts);
      if (result.exitCode !== 0) {
        throw new Error(
          `deploy-engine: ${label} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
        );
      }
      return result.stdout;
    };

    // D-10 registry: bcrypt htpasswd produced inside the deploy host, password via stdin only.
    const credentials = generateRegistryCredentials();
    const htpasswdEntry = await mustExec('htpasswd', ['htpasswd', '-Bin', credentials.username], {
      stdin: `${credentials.password}\n`,
    });
    const registry: StartedRegistry = await startAuthRegistry(networkName, htpasswdEntry);
    cleanups.push(async () => {
      await registry.container.stop();
    });

    // Preload the auth registry with every digest-pinned base, pulled through the mirror.
    const baseImages = resolveBaseImages();
    for (const baseImage of baseImages) {
      // A pull-through cache can hand back a half-written blob on a cold fetch ("unexpected commit
      // digest"); the digest pin makes a retry safe, so one transient failure is retried twice.
      for (let attempt = 1; ; attempt += 1) {
        const pulled = await exec(['docker', 'pull', '--quiet', baseImage], {
          user: 'deployer',
          timeoutMs: IMAGE_TRANSFER_TIMEOUT_MS,
        });
        if (pulled.exitCode === 0) break;
        if (attempt >= 3) {
          throw new Error(
            `deploy-engine: docker pull exited ${String(pulled.exitCode)}: ${pulled.stderr.trim()}`,
          );
        }
      }
      await mustExec(
        'docker tag',
        ['docker', 'tag', baseImage, preloadedRefFor(registry.host, baseImage)],
        {
          user: 'deployer',
        },
      );
    }
    await mustExec(
      'docker login',
      ['docker', 'login', registry.host, '--username', credentials.username, '--password-stdin'],
      { user: 'deployer', stdin: `${credentials.password}\n` },
    );
    try {
      for (const baseImage of baseImages) {
        await mustExec(
          'docker push',
          ['docker', 'push', '--quiet', preloadedRefFor(registry.host, baseImage)],
          {
            user: 'deployer',
            timeoutMs: IMAGE_TRANSFER_TIMEOUT_MS,
          },
        );
      }
    } finally {
      await exec(['docker', 'logout', registry.host], { user: 'deployer' });
    }

    /** Seeds every repository into `target`'s /srv/git, owned by its `git` user. */
    const seedInto = async (target: StartedTestContainer, label: string): Promise<void> => {
      for (const repo of seedRepositories) {
        const branch = repo.branch ?? 'main';
        await target.copyDirectoriesToContainer([
          { source: repo.sourceDir, target: `/tmp/noodara-seed-${repo.name}` },
        ]);
        const seeded = await withTimeout(
          target.exec(
            [
              'sh',
              '-c',
              SEED_SCRIPT,
              'sh',
              repo.name,
              branch,
              repo.withGitmodules === true ? '1' : '0',
              repo.withLfsPointer === true ? '1' : '0',
              LFS_POINTER_OID,
            ],
            {
              user: 'root',
              env: { GIT_AUTHOR_DATE: SEED_COMMIT_DATE, GIT_COMMITTER_DATE: SEED_COMMIT_DATE },
            },
          ),
          DEFAULT_EXEC_TIMEOUT_MS,
          `seed ${repo.name} on ${label}`,
        );
        if (seeded.exitCode !== 0) {
          throw new Error(
            `deploy-engine: seeding '${repo.name}' on ${label} failed: ${seeded.stderr.trim()}`,
          );
        }
      }
    };
    await seedInto(host, 'the ssh git host');

    let httpsGit: HttpsGitHost | null = null;
    if (options.httpsGit === true) {
      // Per-run random token, as a real provider issues one; never a committed literal.
      const token = randomBytes(24).toString('base64url');
      const gitHttps = await startHttpsGitHost(networkName, token, labels);
      cleanups.push(async () => {
        await gitHttps.container.stop();
      });
      await seedInto(gitHttps.container, 'the https git host');
      // Trusted like a public CA: the clone template itself carries no TLS override.
      await host.copyContentToContainer([
        { content: gitHttps.caCertificate, target: GIT_HTTPS_CA_TARGET, mode: 0o644 },
      ]);
      await mustExec('update-ca-certificates', ['update-ca-certificates'], { user: 'root' });
      httpsGit = {
        token,
        repoUrl: (name: string) => `https://${GIT_HTTPS_HOST_ALIAS}/git/${name}.git`,
      };
    }

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await runCleanups();
    };

    return {
      ubuntu,
      ssh: {
        host: host.getHost(),
        port: host.getMappedPort(22),
        user: 'deployer',
        privateKey: loginKey.privateKey,
      },
      deployKey,
      registry: {
        host: registry.host,
        username: credentials.username,
        password: credentials.password,
      },
      gitRepoUrl: (name: string) => `git@${GIT_HOST_ALIAS}:/srv/git/${name}.git`,
      httpsGit,
      baseImages,
      mirrorUpstream: mirror.upstream,
      networkName,
      exec,
      stop,
    };
  } catch (error) {
    await runCleanups().catch(() => undefined);
    throw error;
  }
}
