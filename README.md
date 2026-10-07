<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/ui/brand/lockup-dark.svg">
  <img alt="Noodara" src="packages/ui/brand/lockup-light.svg" width="240">
</picture>

# Noodara

> Your infrastructure, understood.

Noodara is an open-source, self-hostable, AI-native PaaS for deploying, operating and
understanding applications and infrastructure on your own servers.

## Status

This is **v0.2 Projects & Services**: connect a server over SSH, run discovery, organize work as
projects, environments and services, and deploy a service from a Git repository, a Dockerfile or
an image, with build and runtime logs and the real container state.

Not part of this release: domains and HTTPS, application environment variables and secrets,
webhooks, healthchecks and automatic rollback. Release notes: [`docs/releases/v0.2.0.md`](docs/releases/v0.2.0.md).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh
```

See [`docs/install.md`](docs/install.md) for requirements, the download-read-run alternative,
supported variables, upgrade, rollback and troubleshooting.

Release candidates (`vX.Y.Z-rc.N`) are published as GitHub prereleases and are never installed by
default; pin one with `NOODARA_VERSION=v0.2.0-rc.1`.

## Development

```sh
pnpm install
pnpm dev
pnpm test
pnpm test:integration
pnpm test:installer
pnpm lint
pnpm typecheck
pnpm boundaries
pnpm check:posix-sh
```

- `pnpm dev` — runs the control-plane API, worker and web UI together.
- `pnpm test` — unit tests (Vitest).
- `pnpm test:integration` — integration tests against real Postgres, Redis and Docker
  (Testcontainers).
- `pnpm test:installer` — the installer's own Docker-in-Docker test suite.
- `pnpm lint` / `pnpm typecheck` — static checks.
- `pnpm boundaries` — enforces `packages/domain`'s zero-I/O boundary.
- `pnpm check:posix-sh` — the installer's own strict-POSIX-shell static gate.

## Learn more

- [`docs/roadmap-v0.1-v0.5.md`](docs/roadmap-v0.1-v0.5.md) — the roadmap from v0.1 through v0.5.
- [`docs/adr/`](docs/adr/) — architecture decision records.
- [`LICENSE`](LICENSE) — Apache License 2.0.
