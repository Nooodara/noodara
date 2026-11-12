#!/usr/bin/env node
// 36-04: lists and publishes the content-addressed SSH fixture images.
//
//   node scripts/fixture-images.mjs list [--registry <ref>]
//   node scripts/fixture-images.mjs publish --registry <ref>
//
// `list` is read-only and needs no Docker: it prints one line per fixture variant,
// `<name> <identity> <tag>`, where tag is the local cache tag (or the registry tag with --registry).
// `publish` builds every variant whose `<registry>/<name>:<identity>` tag does not exist yet,
// checks the identity label on the built image, and pushes it. An existing tag is never
// overwritten: it is checked before the build and again right before the push, and an
// inconclusive check aborts without pushing.
//
// One identity implementation (H8): everything identity-related is imported from the test
// helper itself, which Node 24 loads through type stripping, so the tag published here is exactly
// the tag the tests look for. The registry login is the caller's job (the workflow uses
// docker/login-action): this script never logs in, never reads Docker configuration or
// credential files, runs `docker` through execFile with argument arrays and explicit timeouts,
// and never prints Docker output or a rejected --registry value (H4).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIXTURE_IDENTITY_BUILD_ARG,
  FIXTURE_IDENTITY_LABEL,
  FIXTURE_IMAGES_CONTEXT,
  computeFixtureIdentity,
  listFixtureImageSpecs,
  localFixtureRef,
  remoteFixtureRef,
  runDockerCli,
  validateRegistryReference,
} from '../tests/integration/helpers/fixture-image.ts';

/** Explicit bounds for every Docker call this script makes. */
export const FIXTURE_IMAGE_COMMAND_TIMEOUTS_MS = Object.freeze({
  manifestInspect: 60_000,
  build: 20 * 60_000,
  imageInspect: 30_000,
  push: 15 * 60_000,
});

const USAGE = 'usage: node scripts/fixture-images.mjs list [--registry <ref>] | publish --registry <ref>';
const INVALID_REGISTRY =
  'fixture-images: --registry is not a valid registry reference (expected lowercase host[:port][/path] without scheme, credentials or whitespace).';
// stderr of `docker manifest inspect` for a tag or repository that does not exist. Anything else
// (unauthorized, denied, network, timeout) is inconclusive and stops the publish.
const ABSENT_TAG = /no such manifest|manifest unknown|name unknown|\bnot found\b/i;

class FixtureImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureImageError';
  }
}

/** A fixed description of a failed command: timeout or exit code, never its output. */
function describeFailure(error) {
  if (error !== null && typeof error === 'object') {
    if (error.killed === true || error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') return 'timed out';
    if (typeof error.code === 'number') return `exit code ${String(error.code)}`;
  }
  return 'docker could not be run';
}

function registryOrThrow(value) {
  const validation = validateRegistryReference(value);
  if (!validation.ok || validation.registry === null) throw new FixtureImageError(INVALID_REGISTRY);
  return validation.registry;
}

/**
 * Every fixture variant with its identity and tag. Read-only: no Docker call.
 * @param {{ registry?: string, contextDir?: string }} [options]
 */
export async function listFixtureImages(options = {}) {
  const contextDir = options.contextDir ?? FIXTURE_IMAGES_CONTEXT;
  const registry = options.registry === undefined ? null : registryOrThrow(options.registry);
  const listed = [];
  for (const spec of listFixtureImageSpecs()) {
    const identity = await computeFixtureIdentity({
      contextDir,
      dockerfile: spec.dockerfile,
      buildArgs: spec.buildArgs,
    });
    listed.push({
      ...spec,
      identity,
      tag: registry === null ? localFixtureRef(spec.name, identity) : remoteFixtureRef(registry, spec.name, identity),
    });
  }
  return listed;
}

async function tagExists(run, ref) {
  try {
    await run(['manifest', 'inspect', '--', ref], { timeoutMs: FIXTURE_IMAGE_COMMAND_TIMEOUTS_MS.manifestInspect });
    return true;
  } catch (error) {
    const stderr = error !== null && typeof error === 'object' && typeof error.stderr === 'string' ? error.stderr : '';
    if (ABSENT_TAG.test(stderr)) return false;
    throw new FixtureImageError(
      `fixture-images: could not check whether ${ref} exists (${describeFailure(error)}); nothing was pushed for it.`,
    );
  }
}

async function step(name, ref, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof FixtureImageError) throw error;
    throw new FixtureImageError(`fixture-images: ${name} failed for ${ref} (${describeFailure(error)}).`);
  }
}

/**
 * Builds and pushes every absent `<registry>/<name>:<identity>` tag. Existing tags are skipped.
 * @param {{ registry: string, run?: typeof runDockerCli, log?: (line: string) => void, contextDir?: string }} options
 * @returns {Promise<{ published: string[], skipped: string[] }>}
 */
export async function publishFixtureImages(options) {
  const registry = registryOrThrow(options.registry);
  const run = options.run ?? runDockerCli;
  const log = options.log ?? ((line) => console.log(line));
  const contextDir = options.contextDir ?? FIXTURE_IMAGES_CONTEXT;
  const published = [];
  const skipped = [];

  for (const image of await listFixtureImages({ registry, contextDir })) {
    const ref = image.tag;
    if (await tagExists(run, ref)) {
      skipped.push(ref);
      log(`skip ${ref} (already published)`);
      continue;
    }

    const buildArgs = Object.entries(image.buildArgs)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]);
    await step('build', ref, () =>
      run(
        [
          'build',
          '--quiet',
          '--file',
          path.join(contextDir, image.dockerfile),
          ...buildArgs,
          '--build-arg',
          `${FIXTURE_IDENTITY_BUILD_ARG}=${image.identity}`,
          '--tag',
          ref,
          '--',
          contextDir,
        ],
        { timeoutMs: FIXTURE_IMAGE_COMMAND_TIMEOUTS_MS.build },
      ),
    );

    const label = await step('label check', ref, () =>
      run(['image', 'inspect', '--format', `{{index .Config.Labels "${FIXTURE_IDENTITY_LABEL}"}}`, '--', ref], {
        timeoutMs: FIXTURE_IMAGE_COMMAND_TIMEOUTS_MS.imageInspect,
      }),
    );
    if (label.trim() !== image.identity) {
      throw new FixtureImageError(
        `fixture-images: the built image for ${ref} does not carry the expected identity label; nothing was pushed for it.`,
      );
    }

    // A concurrent publisher may have pushed the same identity while this one was building.
    if (await tagExists(run, ref)) {
      skipped.push(ref);
      log(`skip ${ref} (already published)`);
      continue;
    }
    await step('push', ref, () => run(['push', '--quiet', '--', ref], { timeoutMs: FIXTURE_IMAGE_COMMAND_TIMEOUTS_MS.push }));
    published.push(ref);
    log(`pushed ${ref}`);
  }

  return { published, skipped };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'publish') return null;
  let registry;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== '--registry' || registry !== undefined || i + 1 >= rest.length) return null;
    registry = rest[i + 1];
    i += 1;
  }
  if (command === 'publish' && registry === undefined) return null;
  return { command, registry };
}

/**
 * CLI entry point. Exit codes: 0 ok, 1 Docker or identity failure, 2 usage or invalid registry.
 * @param {string[]} argv
 * @param {{ run?: typeof runDockerCli, stdout?: (line: string) => void, stderr?: (line: string) => void }} [deps]
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((line) => console.log(line));
  const stderr = deps.stderr ?? ((line) => console.error(line));
  const args = parseArgs(argv);
  if (args === null) {
    stderr(USAGE);
    return 2;
  }
  if (args.registry !== undefined) {
    const validation = validateRegistryReference(args.registry);
    if (!validation.ok || validation.registry === null) {
      stderr(INVALID_REGISTRY);
      return 2;
    }
  }

  try {
    if (args.command === 'list') {
      for (const image of await listFixtureImages({ registry: args.registry })) {
        stdout(`${image.name} ${image.identity} ${image.tag}`);
      }
      return 0;
    }
    const result = await publishFixtureImages({ registry: args.registry, run: deps.run, log: stdout });
    stdout(`fixture-images: ${String(result.published.length)} pushed, ${String(result.skipped.length)} already published.`);
    return 0;
  } catch (error) {
    stderr(error instanceof FixtureImageError ? error.message : 'fixture-images: failed to compute the fixture identities.');
    return 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  process.exitCode = await main(process.argv.slice(2));
}
