# SSH fixture images

The SSH integration tests run against small Ubuntu containers (`sshd-ubuntu-22.04` and
`sshd-ubuntu-24.04`, each with or without the Docker CLI and with or without a slow `df`). Their
build context is the committed `tests/integration/images/` tree. Building them is the slowest part
of a cold integration run, so the helpers can reuse a cached copy, and can optionally pull a
pre-built copy from a registry. This page explains how an image is identified, where it comes
from, and what trusting a pulled image means.

## Identity

Every fixture variant has an identity: a SHA-256 hash (hex) computed by
`tests/integration/helpers/fixture-image.ts` over:

- a scheme version (`noodara-fixture-image/v1`),
- the Dockerfile path relative to the build context,
- the build arguments, sorted by key (the identity build argument itself is never hashed),
- every regular file of the build context that `.dockerignore` does not exclude, sorted by path,
  each with its path, its executable bit and its content. Declared text files are hashed with LF
  line endings, so a Windows checkout with CRLF produces the same identity; on Windows the
  executable bit comes from the git index.

Every field is length-prefixed, so two different inputs cannot produce the same byte stream. A
symlink, a special file or a `.dockerignore` pattern outside the supported subset makes the
computation fail instead of silently disagreeing with what `docker build` would send.

The identity is used twice:

- as the image tag: `noodara-test/<name>:<identity>` locally, `<registry>/<name>:<identity>` in a
  registry;
- as the value of the `noodara.test.fixture-identity` image label, which the Dockerfiles set from
  the `NOODARA_FIXTURE_IDENTITY` build argument.

Any change to a Dockerfile, a build argument or a file in the context produces a new identity, so a
stale image is never picked up: it simply has a different tag.

To see the identities of the current checkout (read-only, no Docker needed):

```bash
node scripts/fixture-images.mjs list
```

The script imports the TypeScript helper directly, so it needs a Node.js version with unflagged
TypeScript type stripping: Node.js 22.18 or later, or Node.js 24 (the version CI uses). On an older
Node.js 22 release it fails to load; upgrade Node.js to run it.

It prints one line per variant: `<name> <identity> <tag>`. With `--registry <ref>` the tag column
shows the registry tag instead of the local one.

## Resolution order

The SSH helper accepts an `image` option.

`image: 'reuse'` (the default of `createSshdTestScope().start`) resolves an image in this order:

1. **Local image with a matching hash.** A local `noodara-test/<name>:<identity>` whose identity
   label equals the identity and whose OS/architecture matches the local Docker engine is used as
   is.
2. **Optional registry pull.** Only when `NOODARA_TEST_FIXTURE_REGISTRY` is set to a valid registry
   reference (lowercase `host[:port][/path]`, no scheme, no credentials): the helper pulls
   `<registry>/<name>:<identity>` within a bounded deadline (30 seconds, multiplied by
   `NOODARA_TEST_TIMEOUT_SCALE`; kept below half the integration test budget so the build fallback
   still fits in the test), then checks the identity label and the OS/architecture. A pulled image
   that fails either check is removed. Every pull problem (not configured, invalid value,
   unauthorized, not found, timeout, label or platform mismatch) prints a fixed message once and
   falls back to the next step; the registry value and Docker's own output are never echoed. A
   pull that failed or timed out is not retried by later tests in the same process: they go
   straight to the local cache and the build.
3. **Local build.** The image is built from the committed context with the identity build
   argument, and the content-hash tag is published locally so the next run takes step 1.

Concurrent tests in one process that need the same identity share a single pull or build.

`image: 'build'` (the default of `startSshd` and `createSshdLifecycle`) skips steps 1 and 2: it
always builds, then publishes the content-hash tag locally on a best-effort basis. Use it when you
are changing a fixture Dockerfile and want a fresh build regardless of the cache.

## Enabling the registry pull

The pull is opt-in and off by default, locally and in CI. To try it, export the registry that holds
the published images, for example:

```bash
export NOODARA_TEST_FIXTURE_REGISTRY=ghcr.io/<owner>/noodara-test-fixtures
```

The helpers never log in to a registry. If the registry needs authentication, log in with
`docker login` yourself beforehand; without access the pull fails with a fixed message and the
image is built locally.

## Disabling the registry pull

Unset the variable or set it to an empty string:

```bash
unset NOODARA_TEST_FIXTURE_REGISTRY
# or
export NOODARA_TEST_FIXTURE_REGISTRY=
```

With the variable unset or empty the helpers never contact a registry: they use the local cache
or build. An invalid value is also treated as "not configured" after a warning. No workflow under
`.github/workflows` sets the variable.

## Trust model

- **A pulled fixture image is third-party code executed by the tests.** It runs on your Docker
  engine with the privileges the tests give it. Only point `NOODARA_TEST_FIXTURE_REGISTRY` at a
  registry whose publisher you trust.
- **The identity label proves the identity claimed by the publisher, not integrity.** Whoever can
  push to the registry also sets the label, so a matching label only says the publisher claims the
  image was built from this exact context. It is not a signature and does not prove the image
  contents match the Dockerfile. When in doubt, use `image: 'build'` or leave the pull disabled.
- **Fixture images carry test SSH key pairs.** Cached and pulled `sshd-ubuntu-*` images contain
  the test SSH key pairs generated at build time: the private keys the tests log in with, under
  `/keys`, and their public halves in the `authorized_keys` of `root` (key-only root login,
  `PermitRootLogin prohibit-password`), of `deployer` (passwordless sudo) and of `restricted`.
  Anyone who can read the image can read them. They must never be treated as secrets and must
  never be reused outside the tests (no real server, no real `known_hosts`, no deploy key).
- **Whoever has the image and can reach a running fixture's SSH port can log in to the fixture
  container as root.** The helpers publish the container's SSH port 22 on a host port without a
  host address (`withExposedPorts` in `tests/integration/helpers/ssh.ts`), so Docker binds it on
  all host interfaces unless the Docker daemon is configured with a different default bind
  address. A locally built image never leaves your machine, so only you hold its keys. A published
  image hands the same keys to everyone who can pull it, which for a public package is anyone.
  Therefore:
  - this exposure must be weighed before publishing the images (setting
    `NOODARA_FIXTURE_PUBLISH_ENABLED`) or making the package public; it is a precondition of the
    first publish, not something to settle afterwards;
  - do not run the SSH integration tests on a host whose ports are reachable from untrusted
    networks, and above all not with pulled images.
- The local cache is just a tagged Docker image: remove it with `docker image rm` like any other
  image and the next run rebuilds it.

## Publication

Images are published only by `.github/workflows/fixture-images.yml`, which runs
`node scripts/fixture-images.mjs publish --registry <ref>`. The script builds each variant whose
`<registry>/<name>:<identity>` tag does not exist yet, verifies the identity label of the built
image, checks again that the tag is still absent, and pushes it. An existing tag is never
overwritten, and an inconclusive existence check stops the publish without pushing.

The workflow triggers on pushes to `main` that change `tests/integration/images/**` and on manual
dispatch, but its publishing job only runs on `main` and publishes nothing unless a maintainer has
set the repository variable `NOODARA_FIXTURE_PUBLISH_ENABLED` to `true` (exactly that value; unset
or anything else skips the job). Merging the workflow to `main` therefore publishes nothing by
itself.

Nothing has been published yet. Setting `NOODARA_FIXTURE_PUBLISH_ENABLED` to `true` (and so
running the publish for the first time), deciding the visibility of the package, and enabling
`NOODARA_TEST_FIXTURE_REGISTRY` in any CI job all need maintainer approval. Until then every run
uses the local cache or builds locally.

## Measured durations

One run of `tests/integration/ssh/fixture-lifecycle.test.ts` with `NOODARA_TEST_UBUNTU=all` on a
WSL2 VM with 4 CPU / 6 GB and Docker Engine inside the distribution, on 2026-11-12, with
`NOODARA_TEST_TIMEOUT_SCALE=3` (scaled local evidence, not CI-equivalent). Each figure is the whole
test case: image resolution, container start, SSH readiness, two stops and cleanup checks.

| Ubuntu | Cold (`image: 'build'`, uncached build) | Warm (`image: 'reuse'`, local hash-tagged image) |
| --- | --- | --- |
| 22.04 | 131 s | 15 s |
| 24.04 | 141 s | 15 s |

The suite passed 8 of 8 tests in 355 s and left no `noodara.test` resources. The cold figures are
above the unscaled 120 s integration budget, so on a machine like this one the cold cases need the
timeout scale; the warm cases do not. These are single measurements, not averages.
