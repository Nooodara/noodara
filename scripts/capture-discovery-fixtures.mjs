#!/usr/bin/env node
// Reproducible capture of real command output from the project-owned sshd fixture images
// (02-04-PLAN.md Task 2, open question 2, assumption A3). Every parser in this phase is tested
// against the files this script writes — nothing under packages/domain/src/discovery/fixtures/
// is hand-typed sample text. Re-run this script (never hand-edit a fixture) whenever a template
// in packages/ssh/src/commands changes.
//
// Requires packages/ssh to already be built (`pnpm build` — the repo's own `pnpm test`/
// `pnpm test:integration` already do this via turbo/global-setup): this script imports the
// frozen command templates from the published `@noodara/ssh` entrypoint so the captured output
// can never drift from the exact string the real adapter will send over an SSH exec channel.
//
// Usage: node scripts/capture-discovery-fixtures.mjs

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURES_ROOT = path.join(
  REPO_ROOT,
  'packages/domain/src/discovery/fixtures',
);

let ssh;
try {
  ssh = await import('@noodara/ssh');
} catch (err) {
  console.error(
    'Could not import "@noodara/ssh" — packages/ssh/dist is likely missing. Run `pnpm build` first.',
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const { COMMAND_TEMPLATES } = ssh;

const { startSshd, assertNoStrayTestContainers } = await import(
  new URL('../tests/integration/helpers/ssh.ts', import.meta.url)
);

const UBUNTU_VERSIONS = ['22.04', '24.04'];

// One entry per DISCOVERY_CHECK_ID (packages/domain/src/discovery/types.ts) mapped to the exact
// CommandName (packages/ssh/src/commands/allowlist.ts) whose frozen template produces it — the
// filenames below ARE the DISCOVERY_CHECK_IDs, so a parser test can join a check id directly to
// its fixture file with no translation table of its own.
const NON_DOCKER_CHECKS = [
  ['hostname', 'discovery.hostname'],
  ['os_release', 'discovery.os_release'],
  ['arch', 'discovery.arch'],
  ['cpu', 'discovery.cpu'],
  ['memory', 'discovery.memory'],
  ['disk', 'discovery.disk'],
  ['uptime', 'discovery.uptime'],
];
const USER_DEPENDENT_CHECKS = [
  ['sudo', 'access.sudo'],
  ['docker_group', 'access.docker_group'],
];
const DOCKER_CHECKS = [
  ['docker_version', 'docker.version'],
  ['docker_compose_version', 'docker.compose_version'],
];

const changedFiles = [];

function writeIfChanged(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const previous = existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
  if (previous !== content) {
    writeFileSync(filePath, content, 'utf8');
    changedFiles.push(path.relative(REPO_ROOT, filePath));
  }
}

function writeMeta(filePath, meta) {
  writeIfChanged(filePath, JSON.stringify(meta, null, 2) + '\n');
}

/** Runs `command` as `user` via a login shell, matching how a real SSH exec channel runs an
 *  allowlisted template string (packages/ssh's future adapter execs the template verbatim
 *  through the remote user's shell, not as an argv array). */
async function run(fixture, command, user) {
  return fixture.container.exec(['sh', '-c', command], { user });
}

async function capturePlainImage(ubuntu) {
  const dir = path.join(FIXTURES_ROOT, `ubuntu-${ubuntu}`);
  const fixture = await startSshd({ ubuntu });
  try {
    for (const [id, commandName] of NON_DOCKER_CHECKS) {
      const result = await run(fixture, COMMAND_TEMPLATES[commandName], 'deployer');
      writeIfChanged(path.join(dir, `${id}.txt`), result.stdout);
    }

    // sudo/docker_group differ by user (SERV-08's whole point) — deployer passes both, restricted
    // fails both. Both captures come from the SAME plain image so the parser's pass/fail fixtures
    // are directly comparable.
    for (const [id, commandName] of USER_DEPENDENT_CHECKS) {
      const deployerResult = await run(fixture, COMMAND_TEMPLATES[commandName], 'deployer');
      writeIfChanged(path.join(dir, `${id}.txt`), deployerResult.stdout);

      const restrictedResult = await run(fixture, COMMAND_TEMPLATES[commandName], 'restricted');
      writeIfChanged(path.join(dir, `${id}.restricted.txt`), restrictedResult.stdout);
      writeMeta(path.join(dir, `${id}.restricted.meta.json`), {
        command: COMMAND_TEMPLATES[commandName],
        exitCode: restrictedResult.exitCode,
        stderr: restrictedResult.stderr,
      });
    }

    // The "docker binary absent" shape (open question 2): exit 127, no JSON on stdout ever.
    // Never overwrites the CLI-present <id>.txt captured in captureDockerCliImage — this is a
    // deliberately distinct fixture for the "not installed" branch of D-12's parser.
    for (const [id, commandName] of DOCKER_CHECKS) {
      const result = await run(fixture, COMMAND_TEMPLATES[commandName], 'deployer');
      writeIfChanged(path.join(dir, `${id}.not_installed.txt`), result.stdout);
      writeMeta(path.join(dir, `${id}.not_installed.meta.json`), {
        command: COMMAND_TEMPLATES[commandName],
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
  } finally {
    await fixture.stop();
  }
}

async function captureDockerCliImage(ubuntu) {
  const dir = path.join(FIXTURES_ROOT, `ubuntu-${ubuntu}`);
  const fixture = await startSshd({ ubuntu, dockerCli: true });
  try {
    // CLI present, daemon unreachable (open question 2's other half): exit non-zero, but stdout
    // is still valid JSON with a `Client` key — this is the shape D-12's parser must treat as
    // "installed", never collapsing a non-zero exit into "not installed" (Pitfall 2).
    for (const [id, commandName] of DOCKER_CHECKS) {
      const result = await run(fixture, COMMAND_TEMPLATES[commandName], 'deployer');
      writeIfChanged(path.join(dir, `${id}.txt`), result.stdout);
      writeMeta(path.join(dir, `${id}.meta.json`), {
        command: COMMAND_TEMPLATES[commandName],
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }
  } finally {
    await fixture.stop();
  }
}

async function main() {
  for (const ubuntu of UBUNTU_VERSIONS) {
    await capturePlainImage(ubuntu);
    await captureDockerCliImage(ubuntu);
  }

  await assertNoStrayTestContainers();

  if (changedFiles.length === 0) {
    console.log('capture-discovery-fixtures: no files changed (fully idempotent run).');
  } else {
    console.log(`capture-discovery-fixtures: ${String(changedFiles.length)} file(s) changed:`);
    for (const file of changedFiles) console.log(`  ${file}`);
  }
}

main().catch((err) => {
  console.error('capture-discovery-fixtures: FATAL', err);
  process.exit(1);
});
